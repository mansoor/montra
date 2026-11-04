/**
 * Typed client for the Montra REST API (docs/design/05-api-design.md), shared by web and mobile.
 * Request bodies are the *input* side of the contract schemas; responses are the DTOs.
 */
import type { z } from 'zod';
import type {
  AcceptRecommendationRequest,
  AssignRequest,
  BudgetDto,
  BudgetMoveDto,
  BudgetPeriodDto,
  CalendarDto,
  CopyBudgetRequest,
  CreateBudgetRequest,
  CreateExpectedIncomeRequest,
  CreateGoalRequest,
  DashboardDto,
  DraftBudgetDto,
  DraftBudgetRequest,
  ExpectedIncomeDto,
  ForecastDto,
  GoalDto,
  MoveRequest,
  NetWorthDto,
  PlanningSettingsDto,
  RecommendationDto,
  SankeyDto,
  UpdateBudgetPeriodRequest,
  UpdateBudgetRequest,
  UpdateExpectedIncomeRequest,
  UpdateGoalRequest,
  UpdatePlanningSettingsRequest,
} from '@montra/schemas';
import type {
  AcceptCategoryProposalsRequest,
  AcceptInsightRequest,
  AcceptReviewRequest,
  AcceptReviewResponse,
  AcceptRuleSuggestionRequest,
  AiEventDto,
  AiSettingsDto,
  AiTaskDto,
  BulkImportRowsRequest,
  CategoryProposalsResponse,
  CreateRuleRequest,
  InsightDto,
  ParseQuickAddRequest,
  QuickAddDraftDto,
  ResolveReviewRequest,
  ResolveReviewResponse,
  ReviewListResponse,
  RuleDto,
  RulePreviewDto,
  RulePreviewRequest,
  RuleSuggestionDto,
  SuggestRequest,
  SuggestionDto,
  TestAiProviderResponse,
  UpdateAiSettingsRequest,
  UpdateRuleRequest,
  AccountDto,
  ColumnMappingDto,
  CreateImportRequest,
  ImportBatchDto,
  ImportRowDto,
  JobDto,
  ReconciliationDto,
  StartReconciliationRequest,
  UndoResultDto,
  UpdateImportRowRequest,
  UpdateMappingRequest,
  UploadDto,
  BalanceAdjustmentRequest,
  BulkEditRequest,
  BulkEditResult,
  CategoryDto,
  ChangeDto,
  ConfirmOccurrenceRequest,
  CreateAccountRequest,
  CreateEntityRequest,
  CreateFamilyMemberRequest,
  CreateInviteRequest,
  CreateRecurringRequest,
  CreateTransactionRequest,
  CreateTransferRequest,
  CreateWorkspaceRequest,
  EntityGrant,
  FamilyMemberDto,
  LedgerAccountDto,
  ManualJournalRequest,
  MeDto,
  MemberDto,
  PeriodLockRequest,
  ProblemDto,
  RecurringDto,
  RegisterLineDto,
  TransactionDto,
  UpdateAccountRequest,
  UpdateEntityRequest,
  UpdateFamilyMemberRequest,
  UpdateMeRequest,
  UpdateMemberRequest,
  UpdateRecurringRequest,
  UpdateTransactionRequest,
  WorkspaceDto,
  ApplyReceiptRequest,
  CreateReceiptRequest,
  FxRateDto,
  OrderImportResultDto,
  ReceiptDto,
  ReceiptFileDto,
  ReceiptPageDto,
  ReceiptRecommendationDto,
  TripDto,
  TripInput,
  UpdateReceiptRequest,
  ConfirmPayslipRequest,
  CreateEmployerRequest,
  CreatePayslipRequest,
  EmployerDto,
  MemberReportDto,
  PayslipDto,
  PayslipSummaryDto,
  UpdateEmployerRequest,
  UpdatePayslipRequest,
} from '@montra/schemas';

export type CreateWorkspaceInput = z.input<typeof CreateWorkspaceRequest>;
export type CreateAccountInput = z.input<typeof CreateAccountRequest>;
export type UpdateAccountInput = z.input<typeof UpdateAccountRequest>;
export type BalanceAdjustmentInput = z.input<typeof BalanceAdjustmentRequest>;
export type CreateTransactionInput = z.input<typeof CreateTransactionRequest>;
export type UpdateTransactionInput = z.input<typeof UpdateTransactionRequest>;
export type BulkEditInput = z.input<typeof BulkEditRequest>;
export type CreateTransferInput = z.input<typeof CreateTransferRequest>;
export type ConfirmOccurrenceInput = z.input<typeof ConfirmOccurrenceRequest>;
export type CreateEntityInput = z.input<typeof CreateEntityRequest>;
export type UpdateEntityInput = z.input<typeof UpdateEntityRequest>;
export type CreateFamilyMemberInput = z.input<typeof CreateFamilyMemberRequest>;
export type UpdateFamilyMemberInput = z.input<typeof UpdateFamilyMemberRequest>;
export type UpdateMeInput = z.input<typeof UpdateMeRequest>;
export type ManualJournalInput = z.input<typeof ManualJournalRequest>;
export type PeriodLockInput = z.input<typeof PeriodLockRequest>;
export type CreateInviteInput = z.input<typeof CreateInviteRequest>;
export type UpdateMemberInput = z.input<typeof UpdateMemberRequest>;
export type EntityGrantInput = z.input<typeof EntityGrant>;
export type CreateRecurringInput = z.input<typeof CreateRecurringRequest>;
export type UpdateRecurringInput = z.input<typeof UpdateRecurringRequest>;

export type CreateImportInput = z.input<typeof CreateImportRequest>;
export type UpdateMappingInput = z.input<typeof UpdateMappingRequest>;
export type UpdateImportRowInput = z.input<typeof UpdateImportRowRequest>;
export type StartReconciliationInput = z.input<typeof StartReconciliationRequest>;
export type BulkImportRowsInput = z.input<typeof BulkImportRowsRequest>;
export type UpdateAiSettingsInput = z.input<typeof UpdateAiSettingsRequest>;
export type CreateRuleInput = z.input<typeof CreateRuleRequest>;
export type UpdateRuleInput = z.input<typeof UpdateRuleRequest>;
export type RulePreviewInput = z.input<typeof RulePreviewRequest>;
export type AcceptRuleSuggestionInput = z.input<typeof AcceptRuleSuggestionRequest>;
export type AcceptReviewInput = z.input<typeof AcceptReviewRequest>;
export type ResolveReviewInput = z.input<typeof ResolveReviewRequest>;
export type SuggestInput = z.input<typeof SuggestRequest>;
export type ParseQuickAddInput = z.input<typeof ParseQuickAddRequest>;
export type AcceptCategoryProposalsInput = z.input<typeof AcceptCategoryProposalsRequest>;
export type AcceptInsightInput = z.input<typeof AcceptInsightRequest>;
export type CreateReceiptInput = z.input<typeof CreateReceiptRequest>;
export type UpdateReceiptInput = z.input<typeof UpdateReceiptRequest>;
export type ApplyReceiptInput = z.input<typeof ApplyReceiptRequest>;
export type CreateEmployerInput = z.input<typeof CreateEmployerRequest>;
export type UpdateEmployerInput = z.input<typeof UpdateEmployerRequest>;
export type CreatePayslipInput = z.input<typeof CreatePayslipRequest>;
export type UpdatePayslipInput = z.input<typeof UpdatePayslipRequest>;
export type ConfirmPayslipInput = z.input<typeof ConfirmPayslipRequest>;
export interface ReceiptListOptions {
  status?: ReceiptDto['status'];
  /** RCP-10: search merchant and receipt text. */
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
export type TripInputValue = z.input<typeof TripInput>;

export interface ReviewListOptions {
  entityId?: string;
  minConfidence?: number;
  cursor?: string;
  limit?: number;
}
export type ColumnMapping = ColumnMappingDto;
export type ImportRowStatus = ImportRowDto['status'];

export interface ImportRowsOptions {
  status?: ImportRowStatus;
  cursor?: string | number;
  limit?: number;
}

export type RegisterView = 'ledger' | 'simple';

/** A register line; ledger view carries debit/credit, simple view carries a signed amount. */
export type RegisterLine = Omit<RegisterLineDto, 'debit' | 'credit' | 'amount'> &
  Partial<Pick<RegisterLineDto, 'debit' | 'credit' | 'amount'>>;

export interface RegisterResponse {
  view: RegisterView;
  data: RegisterLine[];
}

/** Entity as returned by /entities (includes archived ones). */
export interface EntityDetailDto {
  id: string;
  type: 'personal' | 'business' | 'rental';
  name: string;
  functionalCurrency: string;
  businessType: string | null;
  fiscalYearStartMonth: number;
  archived: boolean;
  /** Books are closed through this date (DE-09); null when open. */
  lockedThrough: string | null;
}

/** Row of the journal list (DE-07); `total` is the sum of debits in minor units. */
export interface JournalListItemDto {
  id: string;
  entityId: string;
  transactionId: string | null;
  date: string;
  kind: string;
  description: string;
  locked: boolean;
  total: string;
}

export interface JournalListOptions {
  entityId?: string;
  from?: string;
  to?: string;
  kind?: string;
  limit?: number;
}

/** Signed-in session on a device (AUTH-07). */
export interface SessionInfoDto {
  id: string;
  current: boolean;
  authenticatedAt: string;
  expiresAt: string | null;
  devices: { userAgent: string | null; ipAddress: string | null; location: string | null }[];
}

export interface JournalPostingDto {
  lineNo: number;
  accountId: string;
  accountName: string;
  accountType: 'asset' | 'liability' | 'equity' | 'income' | 'expense';
  debit: string | null;
  credit: string | null;
  currency: string;
  memberId: string | null;
  memo: string | null;
  cleared: 'uncleared' | 'cleared' | 'reconciled';
}

export interface JournalEntryDetailDto {
  id: string;
  entityId: string;
  transactionId: string | null;
  date: string;
  kind: string;
  description: string;
  locked: boolean;
  reversesEntryId: string | null;
  postings: JournalPostingDto[];
}

export interface PeriodLockEventDto {
  action: 'lock' | 'unlock' | 'relock';
  lockedThrough: string | null;
  actorUserId: string | null;
  note: string | null;
  at: string;
}

export interface InviteDto {
  id: string;
  email: string;
  role: 'partner' | 'viewer' | 'accountant';
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** The token is returned once, to the owner, until email delivery is wired up. */
export interface CreatedInviteDto {
  id: string;
  email: string;
  role: InviteDto['role'];
  expiresAt: string;
  token: string;
}

export interface ChangesResponse {
  changes: ChangeDto[];
  latestSeq: string;
  hasMore: boolean;
}

export interface TransactionListOptions {
  from?: string;
  to?: string;
  limit?: number;
  status?: 'scheduled' | 'pending' | 'posted' | 'void';
  reviewState?: 'auto_applied' | 'needs_review' | 'reviewed';
  accountId?: string;
  /** Drill-down filters from the dashboard (FLOW-01/02). */
  entityId?: string;
  /** A member's id, or `household` for what's tagged to nobody (FAM-08). */
  memberId?: string;
  categoryIds?: string[];
  accountIds?: string[];
  /** List the trash (voided and deleted) instead of active transactions (BAK-06). */
  trash?: boolean;
}

// ----- Planning (Phase 6) inputs ----------------------------------------------------------------------------
export type CreateBudgetInput = z.input<typeof CreateBudgetRequest>;
export type UpdateBudgetInput = z.input<typeof UpdateBudgetRequest>;
export type AssignInput = z.input<typeof AssignRequest>;
export type MoveInput = z.input<typeof MoveRequest>;
export type CopyBudgetInput = z.input<typeof CopyBudgetRequest>;
export type UpdateBudgetPeriodInput = z.input<typeof UpdateBudgetPeriodRequest>;
export type DraftBudgetInput = z.input<typeof DraftBudgetRequest>;
export type CreateGoalInput = z.input<typeof CreateGoalRequest>;
export type UpdateGoalInput = z.input<typeof UpdateGoalRequest>;
export type CreateExpectedIncomeInput = z.input<typeof CreateExpectedIncomeRequest>;
export type UpdateExpectedIncomeInput = z.input<typeof UpdateExpectedIncomeRequest>;
export type AcceptRecommendationInput = z.input<typeof AcceptRecommendationRequest>;
export type UpdatePlanningSettingsInput = z.input<typeof UpdatePlanningSettingsRequest>;

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

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

const query = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter(
    (e): e is [string, string | number] => e[1] !== undefined && e[1] !== '',
  );
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
};

/** ETag value for optimistic concurrency on a transaction (docs/design/05 §1). */
export const versionTag = (version: string | number | bigint): string => `"v${version}"`;

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
    const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
    // FormData sets its own multipart content type (with the boundary).
    if (body !== undefined && !multipart) h['content-type'] = 'application/json';
    if (method === 'POST' && !h['idempotency-key']) h['idempotency-key'] = this.newKey();
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method,
        headers: h,
        body: body === undefined ? undefined : multipart ? (body as FormData) : JSON.stringify(body),
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

  private ws(workspaceId: string, path = ''): string {
    return `/v1/workspaces/${enc(workspaceId)}${path}`;
  }

  // ----- Me ------------------------------------------------------------------------------------------------
  getMe() {
    return this.request<MeDto>('GET', '/v1/me');
  }
  updateMe(input: UpdateMeInput) {
    return this.request<MeDto>('PATCH', '/v1/me', input);
  }

  // ----- Sessions and devices (AUTH-07) --------------------------------------------------------------------
  listSessions() {
    return this.request<{ data: SessionInfoDto[] }>('GET', '/v1/me/sessions').then((r) => r.data);
  }
  revokeSession(sessionId: string) {
    return this.request<{ revoked: true }>('DELETE', `/v1/me/sessions/${enc(sessionId)}`);
  }
  revokeOtherSessions() {
    return this.request<{ revoked: number }>('DELETE', '/v1/me/sessions');
  }

  // ----- Workspaces and entities ---------------------------------------------------------------------------
  listWorkspaces() {
    return this.request<{ data: WorkspaceDto[] }>('GET', '/v1/workspaces').then((r) => r.data);
  }
  createWorkspace(input: CreateWorkspaceInput) {
    return this.request<WorkspaceDto>('POST', '/v1/workspaces', input);
  }
  getWorkspace(workspaceId: string) {
    return this.request<WorkspaceDto>('GET', this.ws(workspaceId));
  }
  listEntities(workspaceId: string) {
    return this.request<{ data: EntityDetailDto[] }>('GET', this.ws(workspaceId, '/entities')).then(
      (r) => r.data,
    );
  }
  createEntity(workspaceId: string, input: CreateEntityInput) {
    return this.request<EntityDetailDto>('POST', this.ws(workspaceId, '/entities'), input);
  }
  updateEntity(workspaceId: string, entityId: string, input: UpdateEntityInput) {
    return this.request<EntityDetailDto>('PATCH', this.ws(workspaceId, `/entities/${enc(entityId)}`), input);
  }

  // ----- Period close (DE-09) ------------------------------------------------------------------------------
  lockPeriod(workspaceId: string, entityId: string, input: PeriodLockInput) {
    return this.request<{ entityId: string; lockedThrough: string }>(
      'PUT',
      this.ws(workspaceId, `/entities/${enc(entityId)}/period-lock`),
      input,
    );
  }
  unlockPeriod(workspaceId: string, entityId: string, note: string) {
    return this.request<{ entityId: string; lockedThrough: null }>(
      'DELETE',
      this.ws(workspaceId, `/entities/${enc(entityId)}/period-lock`),
      { note },
    );
  }
  periodLockHistory(workspaceId: string, entityId: string) {
    return this.request<{ data: PeriodLockEventDto[] }>(
      'GET',
      this.ws(workspaceId, `/entities/${enc(entityId)}/period-lock/history`),
    ).then((r) => r.data);
  }

  // ----- Family members (FAM) ------------------------------------------------------------------------------
  listFamilyMembers(workspaceId: string) {
    return this.request<{ data: FamilyMemberDto[] }>('GET', this.ws(workspaceId, '/family-members')).then(
      (r) => r.data,
    );
  }
  createFamilyMember(workspaceId: string, input: CreateFamilyMemberInput) {
    return this.request<FamilyMemberDto>('POST', this.ws(workspaceId, '/family-members'), input);
  }
  updateFamilyMember(workspaceId: string, memberId: string, input: UpdateFamilyMemberInput) {
    return this.request<FamilyMemberDto>(
      'PATCH',
      this.ws(workspaceId, `/family-members/${enc(memberId)}`),
      input,
    );
  }

  // ----- Accounts and categories ---------------------------------------------------------------------------
  /** `include: 'all'` also returns archived and hidden accounts (settings). */
  listAccounts(workspaceId: string, opts: { include?: 'all' } = {}) {
    return this.request<{ data: AccountDto[] }>(
      'GET',
      this.ws(workspaceId, `/accounts${query({ include: opts.include })}`),
    ).then((r) => r.data);
  }
  createAccount(workspaceId: string, input: CreateAccountInput) {
    return this.request<AccountDto>('POST', this.ws(workspaceId, '/accounts'), input);
  }
  updateAccount(workspaceId: string, accountId: string, input: UpdateAccountInput) {
    return this.request<AccountDto>('PATCH', this.ws(workspaceId, `/accounts/${enc(accountId)}`), input);
  }
  adjustBalance(workspaceId: string, accountId: string, input: BalanceAdjustmentInput) {
    return this.request<unknown>(
      'POST',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/balance-adjustments`),
      input,
    );
  }
  listCategories(workspaceId: string, entityId?: string) {
    return this.request<{ data: CategoryDto[] }>(
      'GET',
      this.ws(workspaceId, `/categories${query({ entityId })}`),
    ).then((r) => r.data);
  }
  register(workspaceId: string, accountId: string, view: RegisterView = 'ledger') {
    return this.request<RegisterResponse>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/register${query({ view })}`),
    );
  }

  // ----- Transactions --------------------------------------------------------------------------------------
  listTransactions(workspaceId: string, opts: TransactionListOptions = {}) {
    return this.request<{ data: TransactionDto[] }>(
      'GET',
      this.ws(
        workspaceId,
        `/transactions${query({
          ...opts,
          categoryIds: opts.categoryIds?.join(','),
          accountIds: opts.accountIds?.join(','),
          trash: opts.trash ? 'true' : undefined,
        })}`,
      ),
    ).then((r) => r.data);
  }
  getTransaction(workspaceId: string, id: string) {
    return this.request<TransactionDto>('GET', this.ws(workspaceId, `/transactions/${enc(id)}`));
  }
  createTransaction(workspaceId: string, input: CreateTransactionInput) {
    return this.request<TransactionDto>('POST', this.ws(workspaceId, '/transactions'), input);
  }
  createTransfer(workspaceId: string, input: CreateTransferInput) {
    return this.request<TransactionDto>('POST', this.ws(workspaceId, '/transactions/transfer'), input);
  }
  /** Edits with optimistic concurrency; a stale `version` fails with ApiError code `version.mismatch` (412). */
  updateTransaction(workspaceId: string, id: string, version: string, input: UpdateTransactionInput) {
    return this.request<TransactionDto>('PATCH', this.ws(workspaceId, `/transactions/${enc(id)}`), input, {
      'if-match': versionTag(version),
    });
  }
  /** Voids and moves to trash; entries in a closed period are reversed instead of removed. */
  deleteTransaction(workspaceId: string, id: string, version?: string) {
    return this.request<{ outcome: 'removed' | 'reversed' }>(
      'DELETE',
      this.ws(workspaceId, `/transactions/${enc(id)}`),
      undefined,
      version ? { 'if-match': versionTag(version) } : {},
    );
  }
  restoreTransaction(workspaceId: string, id: string) {
    return this.request<TransactionDto>('POST', this.ws(workspaceId, `/transactions/${enc(id)}/restore`));
  }
  confirmOccurrence(workspaceId: string, id: string, input: ConfirmOccurrenceInput = {}) {
    return this.request<TransactionDto>(
      'POST',
      this.ws(workspaceId, `/transactions/${enc(id)}/confirm`),
      input,
    );
  }
  bulkEdit(workspaceId: string, input: BulkEditInput) {
    return this.request<BulkEditResult>('POST', this.ws(workspaceId, '/transactions/bulk'), input);
  }

  // ----- Journals (DE-07) ----------------------------------------------------------------------------------
  listJournalEntries(workspaceId: string, opts: JournalListOptions = {}) {
    return this.request<{ data: JournalListItemDto[] }>(
      'GET',
      this.ws(workspaceId, `/journal-entries${query({ ...opts })}`),
    ).then((r) => r.data);
  }
  /** Full chart of accounts, including system accounts (DE-02). */
  listLedgerAccounts(workspaceId: string, entityId?: string) {
    return this.request<{ data: LedgerAccountDto[] }>(
      'GET',
      this.ws(workspaceId, `/ledger-accounts${query({ entityId })}`),
    ).then((r) => r.data);
  }
  getJournalEntry(workspaceId: string, entryId: string) {
    return this.request<JournalEntryDetailDto>(
      'GET',
      this.ws(workspaceId, `/journal-entries/${enc(entryId)}`),
    );
  }
  createJournalEntry(workspaceId: string, input: ManualJournalInput) {
    return this.request<JournalEntryDetailDto>('POST', this.ws(workspaceId, '/journal-entries'), input);
  }

  // ----- Sharing (UP-04, AUTH-10) --------------------------------------------------------------------------
  listMembers(workspaceId: string) {
    return this.request<{ data: MemberDto[] }>('GET', this.ws(workspaceId, '/sharing/members')).then(
      (r) => r.data,
    );
  }
  updateMember(workspaceId: string, userId: string, input: UpdateMemberInput) {
    return this.request<MemberDto>('PATCH', this.ws(workspaceId, `/sharing/members/${enc(userId)}`), input);
  }
  setGrants(workspaceId: string, userId: string, grants: EntityGrantInput[]) {
    return this.request<MemberDto>('PUT', this.ws(workspaceId, `/sharing/members/${enc(userId)}/grants`), {
      grants,
    });
  }
  listInvites(workspaceId: string) {
    return this.request<{ data: InviteDto[] }>('GET', this.ws(workspaceId, '/sharing/invites')).then(
      (r) => r.data,
    );
  }
  createInvite(workspaceId: string, input: CreateInviteInput) {
    return this.request<CreatedInviteDto>('POST', this.ws(workspaceId, '/sharing/invites'), input);
  }
  revokeInvite(workspaceId: string, inviteId: string) {
    return this.request<{ revoked: true }>(
      'DELETE',
      this.ws(workspaceId, `/sharing/invites/${enc(inviteId)}`),
    );
  }
  acceptInvite(token: string) {
    return this.request<{ workspaceId: string }>('POST', `/v1/invites/${enc(token)}/accept`);
  }

  // ----- Recurring (TXN-05) --------------------------------------------------------------------------------
  listRecurring(workspaceId: string) {
    return this.request<{ data: RecurringDto[] }>('GET', this.ws(workspaceId, '/recurring')).then(
      (r) => r.data,
    );
  }
  createRecurring(workspaceId: string, input: CreateRecurringInput) {
    return this.request<RecurringDto>('POST', this.ws(workspaceId, '/recurring'), input);
  }
  updateRecurring(workspaceId: string, id: string, input: UpdateRecurringInput) {
    return this.request<RecurringDto>('PATCH', this.ws(workspaceId, `/recurring/${enc(id)}`), input);
  }
  /** Creates due occurrences now (the nightly job does the same). */
  materializeRecurring(workspaceId: string, through?: string) {
    return this.request<{ created: number; posted: number }>(
      'POST',
      this.ws(workspaceId, '/recurring/materialize'),
      through ? { through } : {},
    );
  }

  // ----- Statement import (IMP-01..09) --------------------------------------------------------------------
  /** Uploads one statement file as multipart/form-data (field `file`); the API detects the type. */
  uploadFile(workspaceId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<UploadDto>('POST', this.ws(workspaceId, '/uploads'), form);
  }
  /** Starts parsing an uploaded file into an import batch (202, status `parsing`). */
  createImport(workspaceId: string, input: CreateImportInput) {
    return this.request<ImportBatchDto>('POST', this.ws(workspaceId, '/imports'), input);
  }
  listImports(workspaceId: string, accountId?: string) {
    return this.request<{ data: ImportBatchDto[] }>(
      'GET',
      this.ws(workspaceId, `/imports${query({ accountId })}`),
    ).then((r) => r.data);
  }
  getImport(workspaceId: string, id: string) {
    return this.request<ImportBatchDto>('GET', this.ws(workspaceId, `/imports/${enc(id)}`));
  }
  listImportRows(workspaceId: string, id: string, opts: ImportRowsOptions = {}) {
    return this.request<{ data: ImportRowDto[]; nextCursor: string | null }>(
      'GET',
      this.ws(workspaceId, `/imports/${enc(id)}/rows${query({ ...opts })}`),
    );
  }
  /** Confirms or corrects the column mapping and re-parses (202). */
  setImportMapping(workspaceId: string, id: string, input: UpdateMappingInput) {
    return this.request<ImportBatchDto>('PUT', this.ws(workspaceId, `/imports/${enc(id)}/mapping`), input);
  }
  updateImportRow(workspaceId: string, id: string, rowId: string, input: UpdateImportRowInput) {
    return this.request<ImportRowDto>(
      'PATCH',
      this.ws(workspaceId, `/imports/${enc(id)}/rows/${enc(rowId)}`),
      input,
    );
  }
  commitImport(workspaceId: string, id: string) {
    return this.request<ImportBatchDto>('POST', this.ws(workspaceId, `/imports/${enc(id)}/commit`));
  }
  /** Undoes a committed import within 30 days (202); the job result is an UndoResultDto. */
  undoImport(workspaceId: string, id: string) {
    return this.request<ImportBatchDto>('POST', this.ws(workspaceId, `/imports/${enc(id)}/undo`));
  }
  getJob(workspaceId: string, jobId: string) {
    return this.request<JobDto>('GET', this.ws(workspaceId, `/jobs/${enc(jobId)}`));
  }

  // ----- Reconciliation (DE-08) ----------------------------------------------------------------------------
  startReconciliation(workspaceId: string, accountId: string, input: StartReconciliationInput) {
    return this.request<ReconciliationDto>(
      'POST',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/reconciliations`),
      input,
    );
  }
  getReconciliation(workspaceId: string, id: string) {
    return this.request<ReconciliationDto>('GET', this.ws(workspaceId, `/reconciliations/${enc(id)}`));
  }
  setCleared(workspaceId: string, id: string, input: { clear?: string[]; unclear?: string[] }) {
    return this.request<ReconciliationDto>(
      'POST',
      this.ws(workspaceId, `/reconciliations/${enc(id)}/cleared`),
      input,
    );
  }
  completeReconciliation(workspaceId: string, id: string) {
    return this.request<ReconciliationDto>(
      'POST',
      this.ws(workspaceId, `/reconciliations/${enc(id)}/complete`),
    );
  }

  /** One decision for many rows: listed ids, or every row with a status (e.g. skip all probable duplicates). */
  bulkImportRows(workspaceId: string, id: string, input: BulkImportRowsInput) {
    return this.request<{ updated: number }>(
      'PATCH',
      this.ws(workspaceId, `/imports/${enc(id)}/rows`),
      input,
    );
  }
  /** Categories proposed from an import's payees (UP-03). */
  categoryProposals(workspaceId: string, id: string) {
    return this.request<CategoryProposalsResponse>(
      'GET',
      this.ws(workspaceId, `/imports/${enc(id)}/category-proposals`),
    );
  }
  acceptCategoryProposals(workspaceId: string, id: string, input: AcceptCategoryProposalsInput) {
    return this.request<unknown>(
      'POST',
      this.ws(workspaceId, `/imports/${enc(id)}/category-proposals/accept`),
      input,
    );
  }
  /** An account's reconciliations, newest first; `in_progress` finds the one to resume. */
  listReconciliations(workspaceId: string, accountId: string, status?: 'in_progress' | 'completed') {
    return this.request<{ data: ReconciliationDto[] }>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/reconciliations${query({ status })}`),
    ).then((r) => r.data);
  }

  // ----- AI settings and audit log (UP-13, UP-06, AIA-08, AIA-10) -----------------------------------------
  getAiSettings(workspaceId: string) {
    return this.request<AiSettingsDto>('GET', this.ws(workspaceId, '/ai/settings'));
  }
  updateAiSettings(workspaceId: string, input: UpdateAiSettingsInput) {
    return this.request<AiSettingsDto>('PATCH', this.ws(workspaceId, '/ai/settings'), input);
  }
  testAiProvider(workspaceId: string) {
    return this.request<TestAiProviderResponse>('POST', this.ws(workspaceId, '/ai/settings/test'));
  }
  listAiEvents(workspaceId: string, opts: { cursor?: string; limit?: number } = {}) {
    return this.request<{ data: AiEventDto[]; nextCursor: string | null }>(
      'GET',
      this.ws(workspaceId, `/ai/events${query({ ...opts })}`),
    );
  }
  deleteAiEvent(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/ai/events/${enc(id)}`));
  }
  deleteAllAiEvents(workspaceId: string) {
    return this.request<unknown>('DELETE', this.ws(workspaceId, '/ai/events'));
  }
  /** Local mode: work parked for a client on the user's network. */
  listAiTasks(workspaceId: string) {
    return this.request<{ data: AiTaskDto[] }>('GET', this.ws(workspaceId, '/ai/tasks')).then((r) => r.data);
  }
  postAiTaskResult(workspaceId: string, id: string, output: unknown) {
    return this.request<unknown>('POST', this.ws(workspaceId, `/ai/tasks/${enc(id)}/result`), { output });
  }

  // ----- Rules (UP-02) and rule suggestions (AI-05) -------------------------------------------------------
  listRules(workspaceId: string) {
    return this.request<{ data: RuleDto[] }>('GET', this.ws(workspaceId, '/rules')).then((r) => r.data);
  }
  createRule(workspaceId: string, input: CreateRuleInput) {
    return this.request<RuleDto>('POST', this.ws(workspaceId, '/rules'), input);
  }
  updateRule(workspaceId: string, id: string, input: UpdateRuleInput) {
    return this.request<RuleDto>('PATCH', this.ws(workspaceId, `/rules/${enc(id)}`), input);
  }
  deleteRule(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/rules/${enc(id)}`));
  }
  /** Match count and sample on existing transactions, for an unsaved rule. */
  previewRule(workspaceId: string, input: RulePreviewInput) {
    return this.request<RulePreviewDto>('POST', this.ws(workspaceId, '/rules/preview'), input);
  }
  previewSavedRule(workspaceId: string, id: string) {
    return this.request<RulePreviewDto>('POST', this.ws(workspaceId, `/rules/${enc(id)}/preview`), {});
  }
  /** "Apply to existing" (UP-02): a job; poll getJob for the result. */
  applyRule(workspaceId: string, id: string) {
    return this.request<JobDto>('POST', this.ws(workspaceId, `/rules/${enc(id)}/apply`));
  }
  listRuleSuggestions(workspaceId: string) {
    return this.request<{ data: RuleSuggestionDto[] }>('GET', this.ws(workspaceId, '/rule-suggestions')).then(
      (r) => r.data,
    );
  }
  acceptRuleSuggestion(workspaceId: string, id: string, input: AcceptRuleSuggestionInput = {}) {
    return this.request<unknown>('POST', this.ws(workspaceId, `/rule-suggestions/${enc(id)}/accept`), input);
  }
  dismissRuleSuggestion(workspaceId: string, id: string) {
    return this.request<unknown>('POST', this.ws(workspaceId, `/rule-suggestions/${enc(id)}/dismiss`));
  }

  // ----- Review queue (AI-03/04), suggestions and quick add (TXN-06) --------------------------------------
  listReview(workspaceId: string, opts: ReviewListOptions = {}) {
    return this.request<ReviewListResponse>('GET', this.ws(workspaceId, `/review${query({ ...opts })}`));
  }
  acceptReview(workspaceId: string, input: AcceptReviewInput) {
    return this.request<AcceptReviewResponse>('POST', this.ws(workspaceId, '/review/accept'), input);
  }
  resolveReview(workspaceId: string, transactionId: string, input: ResolveReviewInput) {
    return this.request<ResolveReviewResponse>(
      'POST',
      this.ws(workspaceId, `/review/${enc(transactionId)}/resolve`),
      input,
    );
  }
  suggestCategory(workspaceId: string, input: SuggestInput) {
    return this.request<SuggestionDto>('POST', this.ws(workspaceId, '/categorize/suggest'), input);
  }
  parseQuickAdd(workspaceId: string, input: ParseQuickAddInput) {
    return this.request<QuickAddDraftDto>('POST', this.ws(workspaceId, '/transactions/parse'), input);
  }

  // ----- Insights (AI-08, AI-09) ----------------------------------------------------------------------------
  listInsights(workspaceId: string, status: 'open' | 'dismissed' | 'accepted' = 'open') {
    return this.request<{ data: InsightDto[] }>(
      'GET',
      this.ws(workspaceId, `/insights${query({ status })}`),
    ).then((r) => r.data);
  }
  acceptInsight(workspaceId: string, id: string, input: AcceptInsightInput = {}) {
    return this.request<unknown>('POST', this.ws(workspaceId, `/insights/${enc(id)}/accept`), input);
  }
  dismissInsight(workspaceId: string, id: string) {
    return this.request<unknown>('POST', this.ws(workspaceId, `/insights/${enc(id)}/dismiss`));
  }

  // ----- Employers and payslips (PAY-01..09), reports by member (FAM-08, RPT-01) ---------------------------
  listEmployers(workspaceId: string, opts: { memberId?: string } = {}) {
    return this.request<{ data: EmployerDto[] }>(
      'GET',
      this.ws(workspaceId, `/employers${query(opts)}`),
    ).then((r) => r.data);
  }
  createEmployer(workspaceId: string, input: CreateEmployerInput) {
    return this.request<EmployerDto>('POST', this.ws(workspaceId, '/employers'), input);
  }
  updateEmployer(workspaceId: string, id: string, input: UpdateEmployerInput) {
    return this.request<EmployerDto>('PATCH', this.ws(workspaceId, `/employers/${enc(id)}`), input);
  }
  /** Uploads one payslip page (PDF, JPEG, PNG, WebP); the API sniffs the type. */
  uploadPayslipFile(workspaceId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<ReceiptFileDto>('POST', this.ws(workspaceId, '/payslips/files'), form);
  }
  listPayslips(
    workspaceId: string,
    opts: { memberId?: string; employerId?: string; status?: PayslipDto['status'] } = {},
  ) {
    return this.request<{ data: PayslipDto[] }>('GET', this.ws(workspaceId, `/payslips${query(opts)}`)).then(
      (r) => r.data,
    );
  }
  /** From uploaded files (read in the background), from the last payslip, or empty to fill by hand. */
  createPayslip(workspaceId: string, input: CreatePayslipInput) {
    return this.request<PayslipDto>('POST', this.ws(workspaceId, '/payslips'), input);
  }
  getPayslip(workspaceId: string, id: string) {
    return this.request<PayslipDto>('GET', this.ws(workspaceId, `/payslips/${enc(id)}`));
  }
  /** The path of a payslip's file, for the review screen (through the authenticated proxy). */
  payslipFilePath(workspaceId: string, id: string, fileId: string) {
    return this.baseUrl + this.ws(workspaceId, `/payslips/${enc(id)}/files/${enc(fileId)}`);
  }
  updatePayslip(workspaceId: string, id: string, input: UpdatePayslipInput) {
    return this.request<PayslipDto>('PATCH', this.ws(workspaceId, `/payslips/${enc(id)}`), input);
  }
  /** Posts it. Comes back unposted, with `matchCandidates`, when several deposits could be this pay. */
  confirmPayslip(workspaceId: string, id: string, input: ConfirmPayslipInput) {
    return this.request<PayslipDto>('POST', this.ws(workspaceId, `/payslips/${enc(id)}/confirm`), input);
  }
  deletePayslip(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/payslips/${enc(id)}`));
  }
  getMemberReport(workspaceId: string, opts: { from?: string; to?: string; entityId?: string } = {}) {
    return this.request<MemberReportDto>('GET', this.ws(workspaceId, `/reports/by-member${query(opts)}`));
  }
  getPayslipSummary(workspaceId: string, memberId: string, opts: { year?: number } = {}) {
    return this.request<PayslipSummaryDto>(
      'GET',
      this.ws(workspaceId, `/reports/payslip-summary${query({ memberId, ...opts })}`),
    );
  }

  // ----- Receipts (TXN-08, IMP-11, RCP-01..12) -------------------------------------------------------------
  /** Uploads one receipt photo (JPEG, PNG, WebP) or PDF invoice; the API sniffs the type. */
  uploadReceiptFile(workspaceId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<ReceiptFileDto>('POST', this.ws(workspaceId, '/receipts/files'), form);
  }
  /** Creates a receipt from uploaded files (pages in order); extraction runs in the background. */
  createReceipt(workspaceId: string, input: CreateReceiptInput) {
    return this.request<ReceiptDto>('POST', this.ws(workspaceId, '/receipts'), input);
  }
  listReceipts(workspaceId: string, opts: ReceiptListOptions = {}) {
    return this.request<ReceiptPageDto>('GET', this.ws(workspaceId, `/receipts${query({ ...opts })}`));
  }
  getReceipt(workspaceId: string, id: string) {
    return this.request<ReceiptDto>('GET', this.ws(workspaceId, `/receipts/${enc(id)}`));
  }
  /** Path of a receipt page image (for <img src>, through the same-origin proxy in the browser). */
  receiptFilePath(workspaceId: string, id: string, fileId: string) {
    return this.baseUrl + this.ws(workspaceId, `/receipts/${enc(id)}/files/${enc(fileId)}`);
  }
  updateReceipt(workspaceId: string, id: string, input: UpdateReceiptInput) {
    return this.request<ReceiptDto>('PATCH', this.ws(workspaceId, `/receipts/${enc(id)}`), input);
  }
  applyReceipt(workspaceId: string, id: string, input: ApplyReceiptInput) {
    return this.request<ReceiptDto>('POST', this.ws(workspaceId, `/receipts/${enc(id)}/apply`), input);
  }
  matchReceipt(workspaceId: string, id: string) {
    return this.request<ReceiptDto>('POST', this.ws(workspaceId, `/receipts/${enc(id)}/match`));
  }
  rejectReceipt(workspaceId: string, id: string) {
    return this.request<ReceiptDto>('POST', this.ws(workspaceId, `/receipts/${enc(id)}/reject`));
  }
  deleteReceipt(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/receipts/${enc(id)}`));
  }

  // ----- Budgets, goals and money flow (Phase 6) ------------------------------------------------------------
  listBudgets(workspaceId: string, entityId?: string) {
    return this.request<{ data: BudgetDto[] }>(
      'GET',
      this.ws(workspaceId, `/budgets${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createBudget(workspaceId: string, input: CreateBudgetInput) {
    return this.request<BudgetDto>('POST', this.ws(workspaceId, '/budgets'), input);
  }
  updateBudget(workspaceId: string, id: string, input: UpdateBudgetInput) {
    return this.request<BudgetDto>('PATCH', this.ws(workspaceId, `/budgets/${enc(id)}`), input);
  }
  /** `start` is a period's first day, or 'current'. */
  getBudgetPeriod(workspaceId: string, id: string, start = 'current') {
    return this.request<BudgetPeriodDto>(
      'GET',
      this.ws(workspaceId, `/budgets/${enc(id)}/periods/${enc(start)}`),
    );
  }
  updateBudgetPeriod(workspaceId: string, id: string, start: string, input: UpdateBudgetPeriodInput) {
    return this.request<BudgetPeriodDto>(
      'PATCH',
      this.ws(workspaceId, `/budgets/${enc(id)}/periods/${enc(start)}`),
      input,
    );
  }
  assignBudget(workspaceId: string, id: string, start: string, categoryId: string, input: AssignInput) {
    return this.request<BudgetPeriodDto>(
      'PUT',
      this.ws(workspaceId, `/budgets/${enc(id)}/periods/${enc(start)}/lines/${enc(categoryId)}`),
      input,
    );
  }
  moveBudget(workspaceId: string, id: string, start: string, input: MoveInput) {
    return this.request<BudgetPeriodDto>(
      'POST',
      this.ws(workspaceId, `/budgets/${enc(id)}/periods/${enc(start)}/moves`),
      input,
    );
  }
  listBudgetMoves(workspaceId: string, id: string, start: string) {
    return this.request<{ data: BudgetMoveDto[] }>(
      'GET',
      this.ws(workspaceId, `/budgets/${enc(id)}/periods/${enc(start)}/moves`),
    ).then((r) => r.data);
  }
  copyBudget(workspaceId: string, id: string, start: string, input: CopyBudgetInput) {
    return this.request<BudgetPeriodDto>(
      'POST',
      this.ws(workspaceId, `/budgets/${enc(id)}/periods/${enc(start)}/copy`),
      input,
    );
  }
  draftBudget(workspaceId: string, input: DraftBudgetInput) {
    return this.request<DraftBudgetDto>('POST', this.ws(workspaceId, '/budgets/draft'), input);
  }
  listGoals(workspaceId: string, entityId?: string) {
    return this.request<{ data: GoalDto[] }>(
      'GET',
      this.ws(workspaceId, `/goals${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createGoal(workspaceId: string, input: CreateGoalInput) {
    return this.request<GoalDto>('POST', this.ws(workspaceId, '/goals'), input);
  }
  updateGoal(workspaceId: string, id: string, input: UpdateGoalInput) {
    return this.request<GoalDto>('PATCH', this.ws(workspaceId, `/goals/${enc(id)}`), input);
  }
  listExpectedIncome(workspaceId: string, entityId?: string) {
    return this.request<{ data: ExpectedIncomeDto[] }>(
      'GET',
      this.ws(workspaceId, `/expected-income${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createExpectedIncome(workspaceId: string, input: CreateExpectedIncomeInput) {
    return this.request<ExpectedIncomeDto>('POST', this.ws(workspaceId, '/expected-income'), input);
  }
  updateExpectedIncome(workspaceId: string, id: string, input: UpdateExpectedIncomeInput) {
    return this.request<ExpectedIncomeDto>(
      'PATCH',
      this.ws(workspaceId, `/expected-income/${enc(id)}`),
      input,
    );
  }
  getDashboard(workspaceId: string, opts: { entityId?: string; memberId?: string } = {}) {
    return this.request<DashboardDto>('GET', this.ws(workspaceId, `/dashboard${query(opts)}`));
  }
  getSankey(workspaceId: string, opts: { from?: string; to?: string; entityId?: string } = {}) {
    return this.request<SankeyDto>('GET', this.ws(workspaceId, `/flow/sankey${query(opts)}`));
  }
  getForecast(workspaceId: string, opts: { days?: number; entityId?: string } = {}) {
    return this.request<ForecastDto>('GET', this.ws(workspaceId, `/flow/forecast${query(opts)}`));
  }
  getCalendar(workspaceId: string, opts: { from?: string; to?: string; entityId?: string } = {}) {
    return this.request<CalendarDto>('GET', this.ws(workspaceId, `/calendar${query(opts)}`));
  }
  getNetWorth(workspaceId: string, opts: { date?: string; months?: number; entityId?: string } = {}) {
    return this.request<NetWorthDto>('GET', this.ws(workspaceId, `/net-worth${query(opts)}`));
  }
  listRecommendations(
    workspaceId: string,
    opts: { entityId?: string; status?: RecommendationDto['status'] } = {},
  ) {
    return this.request<{ data: RecommendationDto[] }>(
      'GET',
      this.ws(workspaceId, `/recommendations${query(opts)}`),
    ).then((r) => r.data);
  }
  refreshRecommendations(workspaceId: string) {
    return this.request<{ created: number; expired: number }>(
      'POST',
      this.ws(workspaceId, '/recommendations/refresh'),
    );
  }
  acceptRecommendation(workspaceId: string, id: string, input: AcceptRecommendationInput = {}) {
    return this.request<RecommendationDto>(
      'POST',
      this.ws(workspaceId, `/recommendations/${enc(id)}/accept`),
      input,
    );
  }
  dismissRecommendation(workspaceId: string, id: string) {
    return this.request<RecommendationDto>(
      'POST',
      this.ws(workspaceId, `/recommendations/${enc(id)}/dismiss`),
    );
  }
  getPlanningSettings(workspaceId: string) {
    return this.request<PlanningSettingsDto>('GET', this.ws(workspaceId, '/planning/settings'));
  }
  updatePlanningSettings(workspaceId: string, input: UpdatePlanningSettingsInput) {
    return this.request<PlanningSettingsDto>('PATCH', this.ws(workspaceId, '/planning/settings'), input);
  }
  /** RCP-11: purchases at multi-department stores above the threshold without a receipt. */
  listReceiptRecommendations(workspaceId: string) {
    return this.request<{ data: ReceiptRecommendationDto[] }>(
      'GET',
      this.ws(workspaceId, '/receipts/recommended'),
    ).then((r) => r.data);
  }
  dismissReceiptRecommendation(workspaceId: string, transactionId: string) {
    return this.request<void>(
      'POST',
      this.ws(workspaceId, `/receipts/recommended/${enc(transactionId)}/dismiss`),
    );
  }
  /** RCP-12: an Amazon order-history CSV. */
  importOrderHistory(workspaceId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<OrderImportResultDto>('POST', this.ws(workspaceId, '/receipts/order-history'), form);
  }

  // ----- Trips (CUR-09) and FX rates (CUR-05) --------------------------------------------------------------
  listTrips(workspaceId: string) {
    return this.request<{ data: TripDto[] }>('GET', this.ws(workspaceId, '/trips')).then((r) => r.data);
  }
  createTrip(workspaceId: string, input: TripInputValue) {
    return this.request<TripDto>('POST', this.ws(workspaceId, '/trips'), input);
  }
  updateTrip(workspaceId: string, id: string, input: TripInputValue & { version: string }) {
    return this.request<TripDto>('PATCH', this.ws(workspaceId, `/trips/${enc(id)}`), input);
  }
  deleteTrip(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/trips/${enc(id)}`));
  }
  getFxRate(workspaceId: string, base: string, quote: string, date: string) {
    return this.request<FxRateDto>('GET', this.ws(workspaceId, `/fx/rates${query({ base, quote, date })}`));
  }

  // ----- Sync (PLT-06) -------------------------------------------------------------------------------------
  /** Current position of the change feed, without the changes themselves. */
  syncHead(workspaceId: string) {
    return this.request<ChangesResponse>('GET', this.ws(workspaceId, '/sync/changes?head=true')).then(
      (r) => r.latestSeq,
    );
  }
  syncChanges(workspaceId: string, since: string, limit?: number) {
    return this.request<ChangesResponse>(
      'GET',
      this.ws(workspaceId, `/sync/changes${query({ since, limit })}`),
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
  if (status === 412) {
    return new ApiError(
      412,
      'version.mismatch',
      'This item changed since you loaded it. Reload and try again.',
    );
  }
  return new ApiError(status, `http_${status}`, `Request failed (${status})`);
}

export type {
  AiEventDto,
  AiSettingsDto,
  AiTaskDto,
  CategoryProposalsResponse,
  InsightDto,
  QuickAddDraftDto,
  ResolveReviewResponse,
  ReviewListResponse,
  RuleDto,
  RulePreviewDto,
  RuleSuggestionDto,
  SuggestionDto,
  TestAiProviderResponse,
  ImportBatchDto,
  ImportRowDto,
  JobDto,
  ReconciliationDto,
  UndoResultDto,
  UploadDto,
  LedgerAccountDto,
  AccountDto,
  BulkEditResult,
  CategoryDto,
  ChangeDto,
  FamilyMemberDto,
  MeDto,
  MemberDto,
  RecurringDto,
  TransactionDto,
  WorkspaceDto,
  FxRateDto,
  OrderImportResultDto,
  ReceiptDto,
  DepositCandidateDto,
  EmployerDto,
  MemberReportDto,
  MemberTotalsDto,
  PayslipDto,
  PayslipLineDto,
  PayslipSummaryDto,
  WithholdingDto,
  ReceiptFileDto,
  ReceiptPageDto,
  ReceiptRecommendationDto,
  TripDto,
  BudgetDto,
  BudgetMoveDto,
  BudgetPeriodDto,
  CalendarDto,
  DashboardDto,
  DraftBudgetDto,
  ExpectedIncomeDto,
  ForecastDto,
  GoalDto,
  NetWorthDto,
  PlanningSettingsDto,
  RecommendationDto,
  SankeyDto,
};
