/**
 * Typed client for the Montra REST API (docs/design/05-api-design.md), shared by web and mobile.
 * Request bodies are the *input* side of the contract schemas; responses are the DTOs.
 */
import type { z } from 'zod';
import type {
  AccountDto,
  CategoryDto,
  CreateAccountRequest,
  CreateTransactionRequest,
  CreateTransferRequest,
  CreateWorkspaceRequest,
  ProblemDto,
  RegisterLineDto,
  TransactionDto,
  WorkspaceDto,
} from '@montra/schemas';

export type CreateWorkspaceInput = z.input<typeof CreateWorkspaceRequest>;
export type CreateAccountInput = z.input<typeof CreateAccountRequest>;
export type CreateTransactionInput = z.input<typeof CreateTransactionRequest>;
export type CreateTransferInput = z.input<typeof CreateTransferRequest>;

export type RegisterView = 'ledger' | 'simple';

/** A register line; ledger view carries debit/credit, simple view carries a signed amount. */
export type RegisterLine = Omit<RegisterLineDto, 'debit' | 'credit' | 'amount'> &
  Partial<Pick<RegisterLineDto, 'debit' | 'credit' | 'amount'>>;

export interface RegisterResponse {
  view: RegisterView;
  data: RegisterLine[];
}

export interface FieldError {
  path: string;
  message: string;
}

/** An RFC 9457 problem returned by the API, or a transport failure (status 0). */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly errors: FieldError[];
  readonly problem: ProblemDto | null;

  constructor(
    status: number,
    code: string,
    message: string,
    errors: FieldError[] = [],
    problem: ProblemDto | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.errors = errors;
    this.problem = problem;
  }

  /** Field errors keyed by their path, e.g. { "amount.amount": "…" }. */
  fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.errors) out[e.path] ??= e.message;
    return out;
  }
}

export interface ApiClientOptions {
  /** e.g. "/api" in the browser (BFF proxy) or "http://localhost:4000" on the server. */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Extra headers per request, e.g. Authorization on the server side. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Idempotency key generator for POSTs (defaults to crypto.randomUUID). */
  idempotencyKey?: () => string;
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const query = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter((e): e is [string, string | number] => e[1] !== undefined);
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
};

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders?: ApiClientOptions['headers'];
  private readonly newKey: () => string;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.extraHeaders = options.headers;
    this.newKey = options.idempotencyKey ?? (() => globalThis.crypto.randomUUID());
  }

  async request<T>(
    method: Method,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const h: Record<string, string> = {
      accept: 'application/json',
      ...(await this.extraHeaders?.()),
      ...headers,
    };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (method === 'POST' && !h['idempotency-key']) h['idempotency-key'] = this.newKey();
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: 'no-store',
      });
    } catch (err) {
      throw new ApiError(0, 'network_error', (err as Error).message || 'Network error');
    }
    const text = await res.text();
    const json: unknown = text ? safeJson(text) : undefined;
    if (!res.ok) throw toApiError(res.status, json);
    return json as T;
  }

  // Workspaces
  listWorkspaces() {
    return this.request<{ data: WorkspaceDto[] }>('GET', '/v1/workspaces').then((r) => r.data);
  }
  createWorkspace(input: CreateWorkspaceInput) {
    return this.request<WorkspaceDto>('POST', '/v1/workspaces', input);
  }
  getWorkspace(workspaceId: string) {
    return this.request<WorkspaceDto>('GET', `/v1/workspaces/${enc(workspaceId)}`);
  }

  // Accounts and categories
  listAccounts(workspaceId: string) {
    return this.request<{ data: AccountDto[] }>('GET', `/v1/workspaces/${enc(workspaceId)}/accounts`).then(
      (r) => r.data,
    );
  }
  createAccount(workspaceId: string, input: CreateAccountInput) {
    return this.request<AccountDto>('POST', `/v1/workspaces/${enc(workspaceId)}/accounts`, input);
  }
  listCategories(workspaceId: string, entityId?: string) {
    return this.request<{ data: CategoryDto[] }>(
      'GET',
      `/v1/workspaces/${enc(workspaceId)}/categories${query({ entityId })}`,
    ).then((r) => r.data);
  }
  register(workspaceId: string, accountId: string, view: RegisterView = 'ledger') {
    return this.request<RegisterResponse>(
      'GET',
      `/v1/workspaces/${enc(workspaceId)}/accounts/${enc(accountId)}/register${query({ view })}`,
    );
  }

  // Transactions
  listTransactions(workspaceId: string, opts: { from?: string; to?: string; limit?: number } = {}) {
    return this.request<{ data: TransactionDto[] }>(
      'GET',
      `/v1/workspaces/${enc(workspaceId)}/transactions${query(opts)}`,
    ).then((r) => r.data);
  }
  getTransaction(workspaceId: string, id: string) {
    return this.request<TransactionDto>('GET', `/v1/workspaces/${enc(workspaceId)}/transactions/${enc(id)}`);
  }
  createTransaction(workspaceId: string, input: CreateTransactionInput) {
    return this.request<TransactionDto>('POST', `/v1/workspaces/${enc(workspaceId)}/transactions`, input);
  }
  createTransfer(workspaceId: string, input: CreateTransferInput) {
    return this.request<TransactionDto>(
      'POST',
      `/v1/workspaces/${enc(workspaceId)}/transactions/transfer`,
      input,
    );
  }
}

const enc = encodeURIComponent;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const p = body as Partial<ProblemDto> | undefined;
  if (p && typeof p === 'object' && typeof p.code === 'string') {
    return new ApiError(
      status,
      p.code,
      p.detail ?? p.title ?? `Request failed (${status})`,
      Array.isArray(p.errors) ? p.errors : [],
      p as ProblemDto,
    );
  }
  return new ApiError(status, `http_${status}`, `Request failed (${status})`);
}

export type { AccountDto, CategoryDto, TransactionDto, WorkspaceDto };
