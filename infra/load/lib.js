import http from 'k6/http';

export const BASE_URL = (__ENV.BASE_URL || 'http://host.docker.internal:4000').replace(/\/+$/, '');
export const WORKSPACE_ID = __ENV.WORKSPACE_ID;

export function requireEnv(...names) {
  for (const name of names) {
    if (!__ENV[name]) throw new Error(`Set ${name}. See infra/load/README.md.`);
  }
  if (/montra\.(app|com)|prod/i.test(BASE_URL) && !__ENV.ALLOW_NON_LOCAL) {
    throw new Error(`Refusing to load-test ${BASE_URL}: it looks like production.`);
  }
}

export function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${__ENV.AUTH_TOKEN}`, ...extra };
}

export function get(path, tags) {
  return http.get(`${BASE_URL}${path}`, { headers: authHeaders(), tags });
}
