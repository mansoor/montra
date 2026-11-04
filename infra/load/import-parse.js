// NFR-07: an import of 5,000 rows parses in under 10 s, before AI. Measures from the upload to the end of parsing.
import { check, fail, sleep } from 'k6';
import http from 'k6/http';
import { Trend } from 'k6/metrics';
import { authHeaders, BASE_URL, requireEnv, WORKSPACE_ID } from './lib.js';

const ROWS = 5000;
const PARSING_STATES = ['uploaded', 'parsing'];
const TIMEOUT_SECONDS = 120;

const parseDuration = new Trend('import_parse_duration', true);

export const options = {
  scenarios: {
    imports: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || 2),
      iterations: Number(__ENV.IMPORTS || 10),
      maxDuration: __ENV.DURATION || '15m',
    },
  },
  thresholds: {
    import_parse_duration: ['p(95)<10000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  requireEnv('AUTH_TOKEN', 'WORKSPACE_ID', 'ACCOUNT_ID');
}

// Unique content on each iteration, so that the duplicate-file check doesn't short-circuit the run.
function statementCsv(seed) {
  const lines = ['Date,Description,Amount'];
  for (let i = 0; i < ROWS; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String((i % 12) + 1).padStart(2, '0');
    const cents = String(i % 100).padStart(2, '0');
    lines.push(`2025-${month}-${day},LOAD TEST MERCHANT ${seed} ${i},-${(i % 500) + 1}.${cents}`);
  }
  return lines.join('\n');
}

export default function () {
  const seed = `${__VU}-${__ITER}-${Date.now()}`;
  const started = Date.now();

  const upload = http.post(
    `${BASE_URL}/v1/workspaces/${WORKSPACE_ID}/uploads`,
    { file: http.file(statementCsv(seed), `load-${seed}.csv`, 'text/csv') },
    { headers: authHeaders(), tags: { name: 'upload' } },
  );
  if (!check(upload, { 'upload accepted': (r) => r.status === 200 || r.status === 201 })) {
    fail(`upload failed with ${upload.status}`);
  }

  const created = http.post(
    `${BASE_URL}/v1/workspaces/${WORKSPACE_ID}/imports`,
    JSON.stringify({ fileId: upload.json('fileId'), accountId: __ENV.ACCOUNT_ID }),
    {
      headers: authHeaders({ 'content-type': 'application/json', 'idempotency-key': `load-${seed}` }),
      tags: { name: 'create_import' },
    },
  );
  if (!check(created, { 'import accepted': (r) => r.status === 202 })) {
    fail(`import failed with ${created.status}: ${created.body}`);
  }

  const id = created.json('id');
  for (let waited = 0; waited < TIMEOUT_SECONDS * 2; waited++) {
    const batch = http.get(`${BASE_URL}/v1/workspaces/${WORKSPACE_ID}/imports/${id}`, {
      headers: authHeaders(),
      tags: { name: 'poll_import' },
    });
    const status = batch.json('status');
    if (status === 'failed') fail(`import ${id} failed to parse`);
    if (!PARSING_STATES.includes(status)) {
      parseDuration.add(Date.now() - started);
      return;
    }
    sleep(0.5);
  }
  fail(`import ${id} still parsing after ${TIMEOUT_SECONDS} s`);
}
