// The transaction list, one of the busiest reads. NFR-07 gives no number; 1 s is our own limit, to catch regressions.
import { check, sleep } from 'k6';
import { get, requireEnv, WORKSPACE_ID } from './lib.js';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '2m',
  thresholds: {
    'http_req_duration{name:transactions}': ['p(95)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  requireEnv('AUTH_TOKEN', 'WORKSPACE_ID');
}

export default function () {
  const res = get(`/v1/workspaces/${WORKSPACE_ID}/transactions`, { name: 'transactions' });
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
