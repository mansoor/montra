/**
 * Native multipart uploads (expo-file-system) for files the app holds. React Native's FormData upload failed on
 * Android without reaching the server, and with no time limit a stalled upload held the receipt queue forever.
 */
import { File, UploadType } from 'expo-file-system';
import type { FileUploader } from './client';

/** Long enough for a large photo on a slow connection; a stall beyond it gives up and retries later. */
export const UPLOAD_TIMEOUT_MS = 120_000;

export const nativeUpload: FileUploader = async (url, file, headers) => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), UPLOAD_TIMEOUT_MS);
  try {
    const task = new File(file.uri).createUploadTask(url, {
      httpMethod: 'POST',
      uploadType: UploadType.MULTIPART,
      fieldName: 'file',
      mimeType: file.type,
      headers,
      signal: abort.signal,
    });
    const res = await task.uploadAsync();
    return { status: res.status, body: res.body };
  } catch (err) {
    if (abort.signal.aborted) throw new Error(`No answer within ${UPLOAD_TIMEOUT_MS / 1000} s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
