import type { Readable } from 'node:stream';
import { DeleteObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import type { S3Secret, S3Settings } from '@montra/schemas';
import { agentsFor, assertAllowedUrl, type HostPolicy } from './guard.js';
import { asDestinationError, DestinationError, type StorageDestination } from './types.js';

/** AWS S3 and everything that speaks its API: Backblaze B2, Wasabi, Cloudflare R2, MinIO (ADR-0030 §2). */
export class S3Destination implements StorageDestination {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(settings: S3Settings, secret: S3Secret, policy: HostPolicy) {
    if (settings.endpoint) assertAllowedUrl(new URL(settings.endpoint), policy);
    const { httpAgent, httpsAgent } = agentsFor(policy);
    this.bucket = settings.bucket;
    this.client = new S3Client({
      region: settings.region,
      ...(settings.endpoint ? { endpoint: settings.endpoint } : {}),
      forcePathStyle: settings.pathStyle,
      credentials: { accessKeyId: secret.accessKeyId, secretAccessKey: secret.secretAccessKey },
      // Not every S3-compatible service accepts the SDK's newer default trailing checksums.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // The mirror job does its own retrying, with backoff measured in minutes.
      maxAttempts: 2,
      requestHandler: { httpAgent, httpsAgent, connectionTimeout: 10_000, requestTimeout: 120_000 },
    });
  }

  async put(path: string, body: Uint8Array | Readable, opts: { contentType: string; bytes: number }) {
    await this.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: path,
        Body: body,
        ContentLength: opts.bytes,
        ContentType: opts.contentType,
      }),
    );
  }

  async delete(path: string) {
    // S3 answers 204 whether or not the object was there.
    await this.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
  }

  close() {
    this.client.destroy();
  }

  private async send(command: PutObjectCommand | DeleteObjectCommand) {
    try {
      await this.client.send(command as PutObjectCommand);
    } catch (e) {
      throw s3Error(e);
    }
  }
}

function s3Error(e: unknown): DestinationError {
  if (e instanceof S3ServiceException) {
    const status = e.$metadata?.httpStatusCode ?? 0;
    const name = e.name;
    if (
      status === 401 ||
      status === 403 ||
      ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied'].includes(name)
    ) {
      return new DestinationError('refused', name);
    }
    if (status === 404 || name === 'NoSuchBucket') return new DestinationError('not_found', name);
    if (status === 507 || ['QuotaExceeded', 'EntityTooLarge', 'StorageCapExceeded'].includes(name)) {
      return new DestinationError('full', name);
    }
    if (status === 400 || status === 301 || name === 'PermanentRedirect') {
      return new DestinationError('invalid', name);
    }
    return new DestinationError('failed', `${status} ${name}`);
  }
  return asDestinationError(e);
}
