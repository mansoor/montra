/**
 * Typed API calls the app makes outside the sync engine (05 §2). Pure over an injected `fetch` and token
 * source so it is unit-testable; the sync endpoints themselves go through `FetchTransport` in @montra/sync.
 */
import type {
  CategoryProposalsResponse,
  ColumnMappingDto,
  ImportBatchDto,
  ImportRowDto,
  MeDto,
  ParseQuickAddRequest,
  QuickAddDraftDto,
  RegisterPushDeviceRequest,
  SuggestionDto,
  SuggestRequest,
  UploadDto,
  WorkspaceDto,
} from '@montra/schemas';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** No network or the server is down: the caller may fall back to offline behaviour. */
  get offline(): boolean {
    return this.status === 0;
  }
}

export interface ApiOptions {
  baseUrl: string;
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
}

/** A file picked from Files, the share sheet or the camera (React Native's FormData file shape). */
export interface UploadFile {
  uri: string;
  name: string;
  type: string;
}

export type Api = ReturnType<typeof createApi>;

export function createApi(opts: ApiOptions) {
  const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => globalThis.fetch(...a));

  async function request<T>(method: string, path: string, body?: unknown, raw?: FormData): Promise<T> {
    const token = await opts.token();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(`${opts.baseUrl}${path}`, {
        method,
        headers,
        body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
      });
    } catch (err) {
      throw new ApiError(0, 'network', (err as Error).message || 'Network request failed');
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    if (!res.ok) {
      const p = (json ?? {}) as { code?: string; title?: string; detail?: string };
      throw new ApiError(res.status, p.code ?? `http_${res.status}`, p.detail ?? p.title ?? `HTTP ${res.status}`);
    }
    return json as T;
  }

  const ws = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;

  return {
    request,
    me: () => request<MeDto>('GET', '/v1/me'),
    workspaces: async () => (await request<{ data: WorkspaceDto[] }>('GET', '/v1/workspaces')).data,
    aiSettings: (w: string) => request<{ mode: string }>('GET', `${ws(w)}/ai/settings`),
    suggest: (w: string, req: SuggestRequest) => request<SuggestionDto>('POST', `${ws(w)}/categorize/suggest`, req),
    parseQuickAdd: (w: string, req: ParseQuickAddRequest) =>
      request<QuickAddDraftDto>('POST', `${ws(w)}/transactions/parse`, req),

    upload: (w: string, file: UploadFile) => {
      const form = new FormData();
      // React Native's FormData accepts { uri, name, type } for files.
      form.append('file', file as unknown as Blob);
      return request<UploadDto>('POST', `${ws(w)}/uploads`, undefined, form);
    },
    createImport: (w: string, fileId: string, accountId: string) =>
      request<ImportBatchDto>('POST', `${ws(w)}/imports`, { fileId, accountId }),
    getImport: (w: string, id: string) => request<ImportBatchDto>('GET', `${ws(w)}/imports/${id}`),
    importRows: async (w: string, id: string) =>
      (await request<{ data: ImportRowDto[] }>('GET', `${ws(w)}/imports/${id}/rows`)).data,
    setRowDecision: (w: string, id: string, rowId: string, decision: 'import' | 'skip' | null) =>
      request<ImportRowDto>('PATCH', `${ws(w)}/imports/${id}/rows/${rowId}`, { decision }),
    setMapping: (w: string, id: string, mapping: ColumnMappingDto) =>
      request<ImportBatchDto>('PUT', `${ws(w)}/imports/${id}/mapping`, { mapping, saveProfile: true }),
    commitImport: (w: string, id: string) => request<ImportBatchDto>('POST', `${ws(w)}/imports/${id}/commit`),
    categoryProposals: (w: string, id: string) =>
      request<CategoryProposalsResponse>('GET', `${ws(w)}/imports/${id}/category-proposals`),

    registerPushDevice: (req: RegisterPushDeviceRequest) =>
      request<{ id: string }>('POST', '/v1/me/push-devices', req),
    removePushDevice: (token: string) =>
      request<void>('DELETE', `/v1/me/push-devices/${encodeURIComponent(token)}`),
  };
}
