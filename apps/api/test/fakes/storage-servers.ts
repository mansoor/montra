/**
 * In-process stand-ins for someone's storage (ADR-0031), so the tests run in CI without MinIO or a Nextcloud. The S3 one is driven by
 * the real AWS SDK, and the WebDAV one by Montra's own client. Each keeps what it was given in memory, and can be told to fail.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServer {
  url: string;
  /** Objects by path (S3: `<bucket>/<key>`; WebDAV: the decoded path under the root). */
  objects: Map<string, Buffer>;
  /** Every request, as `METHOD path`. */
  log: string[];
  /** Answer every request with this status, or `null` to behave. */
  failWith: number | null;
  /** Refuse deletes, as a key without delete permission would. */
  refuseDeletes: boolean;
  close(): Promise<void>;
}

async function listen(
  handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => handler(req, Buffer.concat(chunks), res));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

const close = (server: http.Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** `aws-chunked` bodies, in case the SDK streams with chunk signatures. */
function unchunk(req: http.IncomingMessage, body: Buffer): Buffer {
  const sha = String(req.headers['x-amz-content-sha256'] ?? '');
  if (
    !sha.startsWith('STREAMING-') &&
    !String(req.headers['content-encoding'] ?? '').includes('aws-chunked')
  ) {
    return body;
  }
  const out: Buffer[] = [];
  let at = 0;
  for (;;) {
    const eol = body.indexOf('\r\n', at);
    if (eol < 0) break;
    const size = parseInt(body.subarray(at, eol).toString().split(';')[0]!, 16);
    if (!size) break;
    out.push(body.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
  return Buffer.concat(out);
}

const s3Error = (res: http.ServerResponse, status: number, code: string) => {
  res.writeHead(status, { 'content-type': 'application/xml' });
  res.end(
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
  );
};

/** Path-style S3: PUT, GET and DELETE of objects in the buckets it was given, for one access key. */
export async function fakeS3(opts: { buckets: string[]; accessKeyId: string }): Promise<FakeServer> {
  const fake: Partial<FakeServer> = { objects: new Map(), log: [], failWith: null, refuseDeletes: false };
  const { server, url } = await listen((req, body, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(1));
    fake.log!.push(`${req.method} ${path}`);
    if (fake.failWith)
      return s3Error(res, fake.failWith, fake.failWith === 403 ? 'AccessDenied' : 'InternalError');
    const auth = String(req.headers.authorization ?? '');
    if (!auth.includes(`Credential=${opts.accessKeyId}/`)) return s3Error(res, 403, 'InvalidAccessKeyId');
    const bucket = path.split('/')[0]!;
    if (!opts.buckets.includes(bucket)) return s3Error(res, 404, 'NoSuchBucket');
    if (req.method === 'PUT') {
      fake.objects!.set(path, unchunk(req, body));
      res.writeHead(200, { etag: '"x"' });
      return res.end();
    }
    if (req.method === 'GET') {
      const o = fake.objects!.get(path);
      if (!o) return s3Error(res, 404, 'NoSuchKey');
      res.writeHead(200, { 'content-length': o.length });
      return res.end(o);
    }
    if (req.method === 'DELETE') {
      if (fake.refuseDeletes) return s3Error(res, 403, 'AccessDenied');
      fake.objects!.delete(path);
      res.writeHead(204);
      return res.end();
    }
    return s3Error(res, 405, 'MethodNotAllowed');
  });
  return Object.assign(fake, { url, close: () => close(server) }) as FakeServer;
}

/** WebDAV with Basic auth, rooted at `/dav/`: MKCOL, PUT, DELETE and PROPFIND, with real folder rules (no PUT into a missing one). */
export async function fakeWebDav(opts: { username: string; password: string }): Promise<FakeServer> {
  const folders = new Set<string>(['']);
  const fake: Partial<FakeServer> = { objects: new Map(), log: [], failWith: null, refuseDeletes: false };
  const expected = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString('base64')}`;
  const { server, url } = await listen((req, body, res) => {
    const raw = new URL(req.url ?? '/', 'http://x').pathname;
    const send = (status: number) => {
      res.writeHead(status);
      res.end();
    };
    if (!raw.startsWith('/dav/')) return send(404);
    const path = decodeURIComponent(raw.slice('/dav/'.length)).replace(/\/$/, '');
    fake.log!.push(`${req.method} ${path}`);
    if (fake.failWith) return send(fake.failWith);
    if (req.headers.authorization !== expected) return send(401);
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    switch (req.method) {
      case 'MKCOL':
        if (folders.has(path)) return send(405);
        if (!folders.has(parent)) return send(409);
        folders.add(path);
        return send(201);
      case 'PUT':
        if (!folders.has(parent)) return send(409);
        if (Number(req.headers['content-length']) !== body.length) return send(400);
        fake.objects!.set(path, body);
        return send(201);
      case 'DELETE':
        if (fake.refuseDeletes) return send(403);
        if (!fake.objects!.delete(path)) return send(404);
        return send(204);
      case 'PROPFIND':
        res.writeHead(207, { 'content-type': 'application/xml' });
        return res.end('<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>');
      default:
        return send(405);
    }
  });
  return Object.assign(fake, { url: `${url}/dav/`, close: () => close(server) }) as FakeServer;
}
