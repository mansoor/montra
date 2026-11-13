import 'reflect-metadata';
import { loadConfig } from './config.js';
import { Db } from './db/database.js';
import { LogMail, MemoryMail, SmtpMail, type MailPort } from './mail/mail.service.js';
import { buildAuthGateway } from './auth-gateway/gateway.js';
import { ThrottleStore } from './auth-gateway/throttle.js';

/**
 * Auth gateway entrypoint (AUTH-08, ADR-0042): the only public door to Kratos. Same image as the API, its own process
 * and port. Kratos's own port stays on the private network.
 */
const DEV_SECRET = 'dev-only-auth-gateway-secret-not-for-production';

const config = loadConfig(process.env, { process: 'auth-gateway' });
const db = new Db(config);
const mail: MailPort =
  config.MAIL_MODE === 'smtp'
    ? new SmtpMail(config)
    : config.MAIL_MODE === 'memory'
      ? new MemoryMail()
      : new LogMail();
const store = new ThrottleStore(db);
const app = buildAuthGateway({
  kratosUrl: config.KRATOS_PUBLIC_URL!,
  webUrl: config.WEB_URL,
  secret: config.AUTH_GATEWAY_SECRET ?? DEV_SECRET,
  store,
  mail,
  trustProxy: config.TRUST_PROXY_HOPS,
  logger: true,
});

const prune = setInterval(() => {
  store
    .prune(new Date())
    .catch((err: Error) => app.log.warn(`Could not prune attempt counters: ${err.message}`));
}, 10 * 60_000);
prune.unref();

const stop = async () => {
  clearInterval(prune);
  await app.close();
  await db.onApplicationShutdown();
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());

await app.listen({ port: config.AUTH_GATEWAY_PORT, host: '0.0.0.0' });
