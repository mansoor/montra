/**
 * Encrypting an archive with a password (BAK-04; ADR-0019 §8). The file is `MONTRABK1\n`, one JSON line of KDF parameters, the AES-256-GCM
 * ciphertext of the ZIP, then the 16-byte tag. Keys are derived in the request, so a password never reaches the job queue.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open as openFile, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  length: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const MAGIC = 'MONTRABK1\n';
const TAG_BYTES = 16;
/** About 128 MB of memory and a fraction of a second, per the OWASP guidance for scrypt. */
export const KDF = { N: 2 ** 17, r: 8, p: 1 };
const maxmem = (k: { N: number; r: number }) => 128 * k.N * k.r * 2;

export interface KdfParams {
  salt: string;
  N: number;
  r: number;
  p: number;
}

export async function deriveKey(password: string, params: KdfParams): Promise<Buffer> {
  return scrypt(password, Buffer.from(params.salt, 'base64'), 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmem(params),
  });
}

export const newKdfParams = (): KdfParams => ({ salt: randomBytes(16).toString('base64'), ...KDF });

/** Encrypts a file. With `kdf`, the header says how to get the key from a password; without, the key is the caller's to keep. */
export async function encryptFile(
  from: string,
  to: string,
  key: Buffer,
  kdf: KdfParams | null,
): Promise<void> {
  const iv = randomBytes(12);
  const header = Buffer.from(
    `${MAGIC}${JSON.stringify({ alg: 'aes-256-gcm', iv: iv.toString('base64'), kdf })}\n`,
  );
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  const out = createWriteStream(to);
  out.write(header);
  await pipeline(createReadStream(from), cipher, out, { end: false });
  await new Promise<void>((resolve, reject) => {
    out.end(cipher.getAuthTag(), () => resolve());
    out.on('error', reject);
  });
}

interface Header {
  iv: string;
  kdf: KdfParams | null;
  raw: Buffer;
}

async function readHeader(path: string): Promise<Header | null> {
  const f = await openFile(path, 'r');
  try {
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await f.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead);
    if (head.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) return null;
    const end = head.indexOf(0x0a, MAGIC.length);
    if (end < 0) return null;
    const json = JSON.parse(head.subarray(MAGIC.length, end).toString('utf8')) as {
      iv: string;
      kdf: KdfParams | null;
    };
    return { iv: json.iv, kdf: json.kdf, raw: head.subarray(0, end + 1) };
  } catch {
    return null;
  } finally {
    await f.close();
  }
}

/** Whether a file is one of ours, and whether it needs a password. */
export async function inspectArchive(path: string): Promise<'plain' | 'password' | 'keyed'> {
  const h = await readHeader(path);
  if (!h) return 'plain';
  return h.kdf ? 'password' : 'keyed';
}

export class BadPasswordError extends Error {}

/** Decrypts to a file. A wrong password or a tampered file fails on the tag, once it's all been read. */
export async function decryptFile(
  from: string,
  to: string,
  key: Buffer | { password: string },
): Promise<void> {
  const h = await readHeader(from);
  if (!h) throw new BadPasswordError('Not an encrypted archive');
  const actual = Buffer.isBuffer(key) ? key : h.kdf ? await deriveKey(key.password, h.kdf) : null;
  if (!actual) throw new BadPasswordError('This archive has no password');
  const size = (await stat(from)).size;
  const start = h.raw.length;
  const end = size - TAG_BYTES;
  if (end < start) throw new BadPasswordError('This archive is cut short');
  const f = await openFile(from, 'r');
  const tag = Buffer.alloc(TAG_BYTES);
  await f.read(tag, 0, TAG_BYTES, end);
  await f.close();
  const decipher = createDecipheriv('aes-256-gcm', actual, Buffer.from(h.iv, 'base64'));
  decipher.setAAD(h.raw);
  decipher.setAuthTag(tag);
  const source =
    end > start
      ? createReadStream(from, { start, end: end - 1 })
      : createReadStream(from, { start, end: start });
  try {
    await pipeline(
      source,
      end > start
        ? decipher
        : new Transform({
            transform(_chunk, _enc, cb) {
              cb();
            },
          }),
      createWriteStream(to),
    );
  } catch {
    throw new BadPasswordError('The password is wrong, or the archive is damaged');
  }
}
