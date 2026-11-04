// Drives a running Kratos through what Montra relies on. Run it after every Kratos rebuild (see
// docs/runbooks/security-patching.md). It creates throwaway identities, so never point it at production.
//
//   node scripts/kratos-smoke.mjs                       every flow, with new identities
//   node scripts/kratos-smoke.mjs --seed <file>         before an upgrade: make an identity with MFA, save it to <file>
//   node scripts/kratos-smoke.mjs --after-upgrade <file> after it: check that identity still works
//
// KRATOS_PUBLIC_URL (default http://localhost:4433), KRATOS_ADMIN_URL (http://localhost:4434),
// MAILPIT_URL (http://localhost:8025). With MONTRA_API_URL and KRATOS_WEBHOOK_SECRET it also checks that a recovery
// reaches the API's hook. Run the API with AUTH_MODE=kratos and SESSION_CACHE_SECONDS=300 so that a missed hook shows.
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const PUBLIC = (process.env.KRATOS_PUBLIC_URL ?? 'http://localhost:4433').replace(/\/$/, '');
const ADMIN = (process.env.KRATOS_ADMIN_URL ?? 'http://localhost:4434').replace(/\/$/, '');
const MAILPIT = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/$/, '');
const API = process.env.MONTRA_API_URL?.replace(/\/$/, '');
const HOOK_SECRET = process.env.KRATOS_WEBHOOK_SECRET;

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newEmail = (tag) => `smoke-${tag}-${randomBytes(5).toString('hex')}@example.test`;
const newPassword = () => `Sm0ke-${randomBytes(12).toString('hex')}`;

async function request(url, { method = 'GET', body, token, bearer, cookies } = {}) {
  const res = await fetch(url, {
    method,
    redirect: 'manual',
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { 'x-session-token': token } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(cookies?.size ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const i = pair.indexOf('=');
    cookies?.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: an empty 204, or a redirect.
  }
  return { status: res.status, body: json, text };
}

// Mail
const SUBJECT = {
  recovery: 'Your Montra account recovery code',
  verification: 'Confirm your email for Montra',
};
async function mailTo(address, subject) {
  for (let i = 0; i < 40; i++) {
    const { body } = await request(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`);
    const match = body?.messages?.find((m) => m.Subject === subject);
    if (match) return (await request(`${MAILPIT}/api/v1/message/${match.ID}`)).body;
    await sleep(500);
  }
  return null;
}
const codeIn = (mail) => /(?:^|\n)\s*(\d{6})\s*(?:\n|$)/.exec(mail?.Text ?? '')?.[1];
function checkMail(name, mail) {
  check(`${name}: email arrives`, Boolean(mail));
  if (!mail) return;
  check(
    `${name}: states the 30 minute lifetime`,
    /30 minutes/.test(mail.Text) && /30 minutes/.test(mail.HTML),
  );
  check(`${name}: code in both bodies`, Boolean(codeIn(mail)) && mail.HTML.includes(codeIn(mail)));
  check(`${name}: no unfilled template values`, !/<no value>|\{\{/.test(mail.Text + mail.HTML));
}

// Flow helpers
const messages = (flow) => (flow?.ui?.messages ?? []).map((m) => m.id);
const csrf = (flow) => flow.ui.nodes.find((n) => n.attributes?.name === 'csrf_token')?.attributes.value;
const node = (flow, id) => flow.ui.nodes.find((n) => n.attributes?.id === id);

function totp(base32) {
  let bits = '';
  for (const c of base32.toUpperCase().replace(/=+$/, '')) {
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

async function register(email, password) {
  const flow = (await request(`${PUBLIC}/self-service/registration/api`)).body;
  return request(`${PUBLIC}/self-service/registration?flow=${flow.id}`, {
    method: 'POST',
    body: { method: 'password', password, traits: { email } },
  });
}
async function login(identifier, password) {
  const flow = (await request(`${PUBLIC}/self-service/login/api`)).body;
  return request(`${PUBLIC}/self-service/login?flow=${flow.id}`, {
    method: 'POST',
    body: { method: 'password', identifier, password },
  });
}
async function stepUp(token, body) {
  const flow = await request(`${PUBLIC}/self-service/login/api?aal=aal2`, { token });
  return request(`${PUBLIC}/self-service/login?flow=${flow.body.id}`, { method: 'POST', token, body });
}
const whoami = (token) => request(`${PUBLIC}/sessions/whoami`, { token });
const aalOf = (res) => res.body?.authenticator_assurance_level;

async function enrolTotp(token) {
  const flow = (await request(`${PUBLIC}/self-service/settings/api`, { token })).body;
  const secret = node(flow, 'totp_secret_key')?.attributes.text.text;
  const res = await request(`${PUBLIC}/self-service/settings?flow=${flow.id}`, {
    method: 'POST',
    token,
    body: { method: 'totp', totp_code: totp(secret) },
  });
  return { secret, res };
}
async function enrolLookup(token) {
  const flow = (await request(`${PUBLIC}/self-service/settings/api`, { token })).body;
  const shown = await request(`${PUBLIC}/self-service/settings?flow=${flow.id}`, {
    method: 'POST',
    token,
    body: { method: 'lookup_secret', lookup_secret_regenerate: true },
  });
  const codes = node(shown.body, 'lookup_secret_codes')?.attributes.text.context.secrets.map((s) => s.text);
  const res = await request(`${PUBLIC}/self-service/settings?flow=${flow.id}`, {
    method: 'POST',
    token,
    body: { method: 'lookup_secret', lookup_secret_confirm: true },
  });
  return { codes, res };
}

async function verifyByEmail(email) {
  const flow = (await request(`${PUBLIC}/self-service/verification/api`)).body;
  const url = `${PUBLIC}/self-service/verification?flow=${flow.id}`;
  return { flow, url, sent: await request(url, { method: 'POST', body: { method: 'code', email } }) };
}

/** A browser flow as the web app runs it, with cookies and the CSRF token, but asking for JSON. */
async function startRecovery(cookies) {
  const { body: flow } = await request(`${PUBLIC}/self-service/recovery/browser`, { cookies });
  return flow;
}
async function askRecovery(email) {
  const cookies = new Map();
  const flow = await startRecovery(cookies);
  const res = await request(`${PUBLIC}/self-service/recovery?flow=${flow.id}`, {
    method: 'POST',
    cookies,
    body: { method: 'code', email, csrf_token: csrf(flow) },
  });
  return { cookies, flow, res };
}
const submitRecoveryCode = ({ cookies, flow, res }, code) =>
  request(`${PUBLIC}/self-service/recovery?flow=${res.body?.id ?? flow.id}`, {
    method: 'POST',
    cookies,
    body: { method: 'code', code, csrf_token: csrf(res.body ?? flow) },
  });

async function verificationFlow() {
  console.log('\n# Sign-up and verification');
  const email = newEmail('verify');
  const password = newPassword();
  const signup = await register(email, password);
  check(
    'sign-up returns a session',
    signup.status === 200 && Boolean(signup.body?.session_token),
    signup.text,
  );
  const next = signup.body?.continue_with?.find((c) => c.action === 'show_verification_ui');
  check('sign-up asks for verification', Boolean(next?.flow?.id), JSON.stringify(signup.body?.continue_with));

  const mail = await mailTo(email, SUBJECT.verification);
  checkMail('verification', mail);
  const url = `${PUBLIC}/self-service/verification?flow=${next?.flow?.id}`;
  const wrong = await request(url, { method: 'POST', body: { method: 'code', code: '000000' } });
  check('verification: a wrong code is refused', messages(wrong.body).includes(4070006), wrong.text);
  const right = await request(url, { method: 'POST', body: { method: 'code', code: codeIn(mail) } });
  check('verification: the code passes', right.body?.state === 'passed_challenge', right.text);
  const me = await whoami(signup.body.session_token);
  check(
    'verification: the address is verified',
    me.body?.identity?.verifiable_addresses?.[0]?.verified === true,
    me.text,
  );

  const again = await verifyByEmail(email);
  await sleep(1000);
  const reuse = await request(again.url, { method: 'POST', body: { method: 'code', code: codeIn(mail) } });
  check('verification: the code works once', reuse.body?.state !== 'passed_challenge', reuse.text);
}

async function recoveryFlow() {
  console.log('\n# Recovery');
  const email = newEmail('recover');
  const password = newPassword();
  const signup = await register(email, password);
  const token = signup.body.session_token;
  const identityId = signup.body.identity.id;

  const hooked = API && HOOK_SECRET;
  if (hooked) {
    const before = await request(`${API}/v1/workspaces`, { bearer: token });
    check(
      'API accepts the session before recovery',
      before.status === 200,
      `${before.status} ${before.text}`,
    );
    const denied = await fetch(`${API}/internal/kratos/hooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-montra-hook-secret': 'x'.repeat(HOOK_SECRET.length) },
      body: JSON.stringify({ event: 'recovery', identity_id: identityId }),
    });
    check('hook: a wrong secret is refused', denied.status === 401, String(denied.status));
  }

  const known = await askRecovery(email);
  const unknownAddress = newEmail('nobody');
  const unknown = await askRecovery(unknownAddress);
  check('recovery: request accepted', known.res.status === 200, known.res.text);
  check(
    'recovery: same response for an unknown address',
    known.res.status === unknown.res.status &&
      known.res.body?.state === unknown.res.body?.state &&
      JSON.stringify(messages(known.res.body)) === JSON.stringify(messages(unknown.res.body)),
    `${known.res.status}/${unknown.res.status} ${messages(known.res.body)} vs ${messages(unknown.res.body)}`,
  );
  const mail = await mailTo(email, SUBJECT.recovery);
  checkMail('recovery', mail);
  await sleep(2000);
  const { body: stray } = await request(
    `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${unknownAddress}"`)}`,
  );
  check('recovery: an unknown address gets no email', (stray?.messages?.length ?? 0) === 0);

  const wrong = await submitRecoveryCode(known, '000000');
  check(
    'recovery: a wrong code is refused',
    wrong.status !== 422 && wrong.body?.state !== 'passed_challenge',
    wrong.text,
  );
  const right = await submitRecoveryCode(known, codeIn(mail));
  check(
    'recovery: the code signs in and goes to settings',
    right.status === 422 && /\/settings\/security/.test(right.body?.redirect_browser_to ?? ''),
    `${right.status} ${right.text}`,
  );
  check('recovery: sets a session cookie', known.cookies.has('ory_kratos_session'));

  const old = await whoami(token);
  check('recovery: other sessions are revoked', old.status === 401, `${old.status}`);
  if (hooked) {
    const after = await request(`${API}/v1/workspaces`, { bearer: token });
    check(
      'hook: the API drops its cached session at once',
      after.status === 401,
      `${after.status} ${after.text}`,
    );
  }

  // A second request with the same code must fail.
  const second = await askRecovery(email);
  const reuse = await submitRecoveryCode(second, codeIn(mail));
  check('recovery: the code works once', reuse.status !== 422, `${reuse.status} ${reuse.text}`);

  // Finish the job: the settings flow the redirect goes to takes a new password.
  const settingsId = new URL(right.body?.redirect_browser_to ?? 'http://x/?').searchParams.get('flow');
  const settings = await request(`${PUBLIC}/self-service/settings/flows?id=${settingsId}`, {
    cookies: known.cookies,
  });
  const newPass = newPassword();
  const changed = await request(`${PUBLIC}/self-service/settings?flow=${settingsId}`, {
    method: 'POST',
    cookies: known.cookies,
    body: { method: 'password', password: newPass, csrf_token: csrf(settings.body) },
  });
  check('recovery: a new password can be set', changed.status === 200, `${changed.status} ${changed.text}`);
  check('recovery: the new password signs in', (await login(email, newPass)).status === 200);
  check('recovery: the old password no longer does', (await login(email, password)).status !== 200);
}

async function createMfaIdentity(tag) {
  const email = newEmail(tag);
  const password = newPassword();
  const signup = await register(email, password);
  const { secret, res: enrolled } = await enrolTotp(signup.body.session_token);
  check('TOTP: enrolment succeeds', enrolled.status === 200, `${enrolled.status} ${enrolled.text}`);
  const first = await login(email, password);
  check('TOTP: a password alone gives AAL1', first.body?.session?.authenticator_assurance_level === 'aal1');
  const wrong = await stepUp(first.body.session_token, { method: 'totp', totp_code: '000000' });
  check('TOTP: a wrong code is refused', wrong.status === 400, `${wrong.status}`);
  const second = await stepUp(first.body.session_token, { method: 'totp', totp_code: totp(secret) });
  check(
    'TOTP: the code gives AAL2',
    second.body?.session?.authenticator_assurance_level === 'aal2',
    second.text,
  );
  const token = second.body?.session_token ?? first.body.session_token;
  const { codes, res: saved } = await enrolLookup(token);
  check(
    'recovery codes: enrolment succeeds',
    saved.status === 200 && codes?.length > 0,
    `${saved.status} ${saved.text}`,
  );
  return { email, password, secret, codes, token, identityId: signup.body.identity.id };
}

async function checkMfaLogin(user, label) {
  const first = await login(user.email, user.password);
  check(`${label}: password sign-in`, first.status === 200, `${first.status} ${first.text}`);
  const viaTotp = await stepUp(first.body.session_token, { method: 'totp', totp_code: totp(user.secret) });
  check(
    `${label}: TOTP step-up`,
    viaTotp.body?.session?.authenticator_assurance_level === 'aal2',
    viaTotp.text,
  );
  const again = await login(user.email, user.password);
  const code = user.codes.at(-1);
  const viaLookup = await stepUp(again.body.session_token, { method: 'lookup_secret', lookup_secret: code });
  check(
    `${label}: recovery code step-up`,
    viaLookup.body?.session?.authenticator_assurance_level === 'aal2',
    viaLookup.text,
  );
  const third = await login(user.email, user.password);
  const reuse = await stepUp(third.body.session_token, { method: 'lookup_secret', lookup_secret: code });
  check(`${label}: a recovery code works once`, reuse.status === 400, `${reuse.status}`);
}

/** The calls apps/api/src/auth/kratos.adapter.ts makes for sessions and account administration. */
async function adapterCalls(user) {
  console.log('\n# Calls the API makes');
  const a = await login(user.email, user.password);
  const b = await login(user.email, user.password);
  const list = await request(`${PUBLIC}/sessions`, { token: a.body.session_token });
  check('GET /sessions lists the others', list.status === 200 && list.body?.length >= 1, list.text);
  const bId = (await whoami(b.body.session_token)).body?.id;
  const one = await request(`${PUBLIC}/sessions/${bId}`, { method: 'DELETE', token: a.body.session_token });
  check('DELETE /sessions/:id', one.status === 204, `${one.status} ${one.text}`);
  check('that session is gone', (await whoami(b.body.session_token)).status === 401);
  const c = await login(user.email, user.password);
  const all = await request(`${PUBLIC}/sessions`, { method: 'DELETE', token: a.body.session_token });
  check(
    'DELETE /sessions counts them',
    all.status === 200 && all.body?.count >= 1,
    `${all.status} ${all.text}`,
  );
  check('those sessions are gone', (await whoami(c.body.session_token)).status === 401);

  const path = `${ADMIN}/admin/identities/${user.identityId}`;
  const next = newEmail('changed');
  const traits = await request(path, {
    method: 'PATCH',
    body: [{ op: 'replace', path: '/traits/email', value: next }],
  });
  check('change email: traits', traits.status === 200, `${traits.status} ${traits.text}`);
  const address = await request(path, {
    method: 'PATCH',
    body: [
      { op: 'replace', path: '/verifiable_addresses/0/value', value: next },
      { op: 'replace', path: '/verifiable_addresses/0/verified', value: true },
      { op: 'replace', path: '/verifiable_addresses/0/status', value: 'completed' },
    ],
  });
  const stored = address.body?.verifiable_addresses?.[0];
  check(
    'change email: the new address is stored as verified',
    address.status === 200 && stored?.value === next && stored?.verified === true,
    `${address.status} ${address.text}`,
  );
  check('change email: the new address signs in', (await login(next, user.password)).status === 200);

  for (const type of ['totp', 'webauthn', 'lookup_secret']) {
    const res = await request(`${path}/credentials/${type}`, { method: 'DELETE' });
    check(`remove second factor: ${type}`, [204, 404].includes(res.status), `${res.status} ${res.text}`);
  }
  const gone = await request(`${path}/sessions`, { method: 'DELETE' });
  check('remove second factor: sessions', [204, 404].includes(gone.status), `${gone.status}`);
  const after = await request(`${path}?include_credential=totp`);
  check('remove second factor: no TOTP left', !after.body?.credentials?.totp, after.text);
}

const [mode, file] = process.argv.slice(2);
for (let i = 0; i < 60; i++) {
  const ready = await request(`${PUBLIC}/health/ready`).catch(() => null);
  if (ready?.status === 200) break;
  await sleep(1000);
}
const version = await request(`${ADMIN}/admin/version`);
console.log(`Kratos ${version.body?.version} at ${PUBLIC}`);

if (mode === '--seed') {
  const user = await createMfaIdentity('seed');
  writeFileSync(file, JSON.stringify(user));
} else if (mode === '--after-upgrade') {
  const user = JSON.parse(readFileSync(file, 'utf8'));
  console.log('\n# The identity from before the upgrade');
  const me = await whoami(user.token);
  check(
    'the session from before still works',
    me.status === 200 && aalOf(me) === 'aal2',
    `${me.status} ${me.text}`,
  );
  check('the identity keeps its traits', me.body?.identity?.traits?.email === user.email);
  await checkMfaLogin(user, 'upgraded');
  await adapterCalls(user);
} else {
  await verificationFlow();
  await recoveryFlow();
  console.log('\n# MFA');
  const user = await createMfaIdentity('mfa');
  await checkMfaLogin(user, 'MFA');
  await adapterCalls(user);
}

console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
