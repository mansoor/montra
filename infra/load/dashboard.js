// NFR-07: the dashboard loads in under 2 s (p95) with 50,000 transactions.
import { check, sleep } from 'k6';
import { get, requireEnv, WORKSPACE_ID } from './lib.js';

export const options = {
  vus: Number(__ENV.VUS || 20),
  duration: __ENV.DURATION || '2m',
  thresholds: {
    'http_req_duration{name:dashboard}': ['p(95)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  requireEnv('AUTH_TOKEN', 'WORKSPACE_ID');
}

export default function () {
  const res = get(`/v1/workspaces/${WORKSPACE_ID}/dashboard`, { name: 'dashboard' });
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);
}
