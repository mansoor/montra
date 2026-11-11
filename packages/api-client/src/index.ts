/**
 * Typed client for the Montra REST API (docs/design/05-api-design.md), shared by web and mobile.
 * Request bodies are the *input* side of the contract schemas; responses are the DTOs.
 */
import type { z } from 'zod';
import type {
  AddI9DocumentRequest,
  CreatePersonRequest,
  CreateW4Request,
  CreateW9Request,
  I9Dto,
  PayrollFileDto,
  PayrollPersonDto,
  PersonKind,
  RevealRequest,
  RevealResponse,
  SaveI9Section1Request,
  SaveI9Section2Request,
  UpdatePersonRequest,
  W4Dto,
  W9Dto,
  ApprovePayRunRequest,
  CreatePayRunRequest,
  CreatePayScheduleRequest,
  CreateReimbursementRequest,
  DecideReimbursementRequest,
  PayRunDto,
  PayScheduleDto,
  PaycheckDto,
  ReimbursementDto,
  ReimbursementStatus,
  UpdatePaycheckRequest,
  UpdatePayRunRequest,
  UpdatePayScheduleRequest,
  CreateDe4Request,
  De4Dto,
  DepositObligationDto,
  PayrollDepositDto,
  PayrollSettingsDto,
  PayrollTaxesDto,
  PayrollTaxKind,
  PreTaxCode,
  RecordDepositRequest,
  UpdatePayrollSettingsRequest,
  WorksheetDto,
} from '@montra/schemas';
import type {
  AcceptRecommendationRequest,
  AnalyzeMigrationRequest,
  StartMigrationRequest,
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
  DashboardChartsDto,
  SetCategoryBudgetDto,
  SetCategoryBudgetRequest,
  MonthSummaryDto,
  SpendingExploreDto,
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
  MigrationAnalysisDto,
  MigrationDto,
  MigrationEligibilityDto,
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
  AccountBalanceHistoryDto,
  AccountDto,
  AccountValuationDto,
  AddValuationsRequest,
  CardStatementDto,
  InterestEarnedDto,
  BalanceRangeDto,
  InvestmentPerformanceDto,
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
  AdminAccountDto,
  AdminSetPlanRequest,
  AdminSupportRequestDto,
  AdminWorkspaceDto,
  AiAccuracyRowDto,
  AppVersionsDto,
  BillingDto,
  BillingLinkDto,
  ClientErrorRequest,
  CreateNoticeRequest,
  CreateSupportRequest,
  FeatureFlagDto,
  ImportFailureRowDto,
  SaveFeatureFlagRequest,
  SaveMerchantRequest,
  SaveMileageRateRequest,
  StaffMeDto,
  StatusDto,
  SupportGrantDto,
  SupportViewDto,
  SystemNoticeDto,
  CreateInviteRequest,
  CreateRecurringRequest,
  CreateTransactionRequest,
  CreateTransferRequest,
  MakeTransferDto,
  MakeTransferRequest,
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
  ReceiptHabitDto,
  ReceiptRecommendationDto,
  TripDto,
  TripInput,
  UpdateReceiptRequest,
  ConfirmPayslipRequest,
  BillDto,
  AllocateTransactionRequest,
  AllocationRuleDto,
  AmortizationRowDto,
  ArrearsDto,
  CreateAllocationRuleRequest,
  CreateDepreciationRequest,
  CreateLeaseRequest,
  CreateLoanRequest,
  CreateMaintenanceRequest,
  CreatePropertyRequest,
  CreateReminderRequest,
  CreateTenantRequest,
  CreateUnitRequest,
  DepositEventRequest,
  DepreciationDto,
  LeaseCandidateDto,
  LeaseDto,
  LoanDto,
  LoanPaymentRequest,
  MaintenanceDto,
  PortfolioReportDto,
  PropertyBudgetDto,
  PropertyDto,
  ReminderDto,
  RentChargeDto,
  RentPaymentDto,
  RentPaymentRequest,
  RentRollDto,
  SavePropertyBudgetRequest,
  ScheduleEDto,
  ScheduleEExportFormat,
  TenantDto,
  UpdateChargeRequest,
  UpdateLeaseRequest,
  UpdateLoanRequest,
  UpdateMaintenanceRequest,
  UpdatePropertyRequest,
  UpdateReminderRequest,
  UpdateTenantRequest,
  UpdateUnitRequest,
  AskAnswerDto,
  AskRequest,
  BackupScheduleDto,
  ConfirmRestoreRequest,
  CreateBackupRequest,
  CreateSavedReportRequest,
  CreateTaxPackageRequest,
  DeletionStatusDto,
  ExportJobDto,
  NotificationDto,
  NotificationListDto,
  NotificationPrefsDto,
  ReportDto,
  ReportExportFormat,
  ReportFilters,
  ReportType,
  RequestDeletionRequest,
  RestoreJobDto,
  SaveBackupScheduleRequest,
  SavedReportDto,
  SearchResultsDto,
  SecurityEventDto,
  StorageUsageDto,
  TrashItemDto,
  UpdateNotificationPrefsRequest,
  AccountMovePreviewDto,
  BusinessDashboardDto,
  BusinessLogoDto,
  ConnectStorageRequest,
  StorageConnection,
  StorageDestinationDto,
  StorageItemDto,
  StorageTestResultDto,
  UpdateStorageRequest,
  BusinessProfileDto,
  InvoiceDto,
  InvoiceLineDto,
  InvoicePaymentDto,
  MileageSummaryDto,
  MileageTripDto,
  MissingReceiptsDto,
  PartyDto,
  PartyReportDto,
  PaymentCandidateDto,
  PnlDto,
  PnlLineDto,
  ScheduleCDto,
  TaxEstimateDto,
  TaxLineDto,
  TaxLineSuggestionDto,
  CreateBillRequest,
  CreateInvoiceRequest,
  CreatePartyRequest,
  CreateTripRequest,
  RecordPaymentRequest,
  SendInvoiceRequest,
  UpdateBillRequest,
  UpdateBusinessProfileRequest,
  UpdateInvoiceRequest,
  UpdatePartyRequest,
  UpdateTripRequest,
  AccountingExportFormat,
  DepositCandidateDto,
  MemberTotalsDto,
  PayslipLineDto,
  WithholdingDto,
  CreateEmployerRequest,
  CreatePayslipRequest,
  EmployerDto,
  MemberReportDto,
  PayslipDto,
  PayslipSummaryDto,
  UpdateEmployerRequest,
  UpdatePayslipRequest,
} from '@montra/schemas';

// ----- Payroll (PRL-01..05, ADR-0034) -----
export type CreatePersonInput = z.input<typeof CreatePersonRequest>;
export type UpdatePersonInput = z.input<typeof UpdatePersonRequest>;
export type RevealInput = z.input<typeof RevealRequest>;
export type CreateW4Input = z.input<typeof CreateW4Request>;
export type CreateW9Input = z.input<typeof CreateW9Request>;
export type SaveI9Section1Input = z.input<typeof SaveI9Section1Request>;
export type SaveI9Section2Input = z.input<typeof SaveI9Section2Request>;
export type AddI9DocumentInput = z.input<typeof AddI9DocumentRequest>;
export type { I9Dto, PayrollFileDto, PayrollPersonDto, PersonKind, RevealResponse, W4Dto, W9Dto };
export type CreatePayScheduleInput = z.input<typeof CreatePayScheduleRequest>;
export type UpdatePayScheduleInput = z.input<typeof UpdatePayScheduleRequest>;
export type CreatePayRunInput = z.input<typeof CreatePayRunRequest>;
export type UpdatePayRunInput = z.input<typeof UpdatePayRunRequest>;
export type UpdatePaycheckInput = z.input<typeof UpdatePaycheckRequest>;
export type ApprovePayRunInput = z.input<typeof ApprovePayRunRequest>;
export type CreateReimbursementInput = z.input<typeof CreateReimbursementRequest>;
export type DecideReimbursementInput = z.input<typeof DecideReimbursementRequest>;
export type { PayRunDto, PayScheduleDto, PaycheckDto, ReimbursementDto, ReimbursementStatus };
export type CreateDe4Input = z.input<typeof CreateDe4Request>;
export type UpdatePayrollSettingsInput = z.input<typeof UpdatePayrollSettingsRequest>;
export type RecordDepositInput = z.input<typeof RecordDepositRequest>;
export type WorksheetForm = '941' | '940' | 'de9' | 'de9c';
export type {
  De4Dto,
  DepositObligationDto,
  PayrollDepositDto,
  PayrollSettingsDto,
  PayrollTaxesDto,
  PayrollTaxKind,
  PreTaxCode,
  WorksheetDto,
};
export type CreateWorkspaceInput = z.input<typeof CreateWorkspaceRequest>;
export type AnalyzeMigrationInput = z.input<typeof AnalyzeMigrationRequest>;
export type StartMigrationInput = z.input<typeof StartMigrationRequest>;
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
export type CreatePartyInput = z.input<typeof CreatePartyRequest>;
export type UpdatePartyInput = z.input<typeof UpdatePartyRequest>;
export type CreateInvoiceInput = z.input<typeof CreateInvoiceRequest>;
export type UpdateInvoiceInput = z.input<typeof UpdateInvoiceRequest>;
export type SendInvoiceInput = z.input<typeof SendInvoiceRequest>;
export type RecordPaymentInput = z.input<typeof RecordPaymentRequest>;
export type CreateBillInput = z.input<typeof CreateBillRequest>;
export type UpdateBillInput = z.input<typeof UpdateBillRequest>;
export type CreateTripInput = z.input<typeof CreateTripRequest>;
export type UpdateTripInput = z.input<typeof UpdateTripRequest>;
export type UpdateBusinessInput = z.input<typeof UpdateBusinessProfileRequest>;
export type ReportFiltersInput = z.input<typeof ReportFilters>;
export type CreateSavedReportInput = z.input<typeof CreateSavedReportRequest>;
export type AskInput = z.input<typeof AskRequest>;
export type UpdateNotificationPrefsInput = z.input<typeof UpdateNotificationPrefsRequest>;
export type CreateBackupInput = z.input<typeof CreateBackupRequest>;
export type CreateTaxPackageInput = z.input<typeof CreateTaxPackageRequest>;
export type SaveBackupScheduleInput = z.input<typeof SaveBackupScheduleRequest>;
export type ConnectStorageInput = z.input<typeof ConnectStorageRequest>;
export type UpdateStorageInput = z.input<typeof UpdateStorageRequest>;
export type StorageConnectionInput = z.input<typeof StorageConnection>;
export type ConfirmRestoreInput = z.input<typeof ConfirmRestoreRequest>;
export type RequestDeletionInput = z.input<typeof RequestDeletionRequest>;
export type CreatePropertyInput = z.input<typeof CreatePropertyRequest>;
export type UpdatePropertyInput = z.input<typeof UpdatePropertyRequest>;
export type CreateUnitInput = z.input<typeof CreateUnitRequest>;
export type UpdateUnitInput = z.input<typeof UpdateUnitRequest>;
export type CreateTenantInput = z.input<typeof CreateTenantRequest>;
export type UpdateTenantInput = z.input<typeof UpdateTenantRequest>;
export type CreateLeaseInput = z.input<typeof CreateLeaseRequest>;
export type UpdateLeaseInput = z.input<typeof UpdateLeaseRequest>;
export type UpdateChargeInput = z.input<typeof UpdateChargeRequest>;
export type RentPaymentInput = z.input<typeof RentPaymentRequest>;
export type DepositEventInput = z.input<typeof DepositEventRequest>;
export type CreateAllocationRuleInput = z.input<typeof CreateAllocationRuleRequest>;
export type AllocateTransactionInput = z.input<typeof AllocateTransactionRequest>;
export type CreateLoanInput = z.input<typeof CreateLoanRequest>;
export type UpdateLoanInput = z.input<typeof UpdateLoanRequest>;
export type LoanPaymentInput = z.input<typeof LoanPaymentRequest>;
export type CreateDepreciationInput = z.input<typeof CreateDepreciationRequest>;
export type CreateReminderInput = z.input<typeof CreateReminderRequest>;
export type UpdateReminderInput = z.input<typeof UpdateReminderRequest>;
export type CreateMaintenanceInput = z.input<typeof CreateMaintenanceRequest>;
export type UpdateMaintenanceInput = z.input<typeof UpdateMaintenanceRequest>;
export type SavePropertyBudgetInput = z.input<typeof SavePropertyBudgetRequest>;
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
  /** RNT-11: what's on one property. */
  propertyId?: string;
  /** RPT-05: `coffee >20 tag:travel`. */
  q?: string;
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

/** Lists travel as comma-separated text in a report's query. */
function reportQuery<T extends ReportFiltersInput>(f: T) {
  const list = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
  return { ...f, accountIds: list(f.accountIds), categoryIds: list(f.categoryIds), tags: list(f.tags) };
}

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

  /** A file response, with its name from Content-Disposition. Errors come back as JSON like any other request. */
  async requestFile(path: string): Promise<{ blob: Blob; fileName: string }> {
    const h: Record<string, string> = { ...(await this.extraHeaders?.()) };
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, { method: 'GET', headers: h, cache: 'no-store' });
    } catch (err) {
      throw new ApiError(0, 'network_error', (err as Error).message || 'Network error');
    }
    if (!res.ok) {
      const text = await res.text();
      throw toApiError(res.status, text ? safeJson(text) : undefined);
    }
    const match = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
    return { blob: await res.blob(), fileName: match?.[1] ?? 'download' };
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

  // ----- Plans, support and help (ADR-0020) --------------------------------------------------------
  getBilling(workspaceId: string) {
    return this.request<BillingDto>('GET', this.ws(workspaceId, '/billing'));
  }
  startCheckout(workspaceId: string, input: { interval: 'month' | 'year' }) {
    return this.request<BillingLinkDto>('POST', this.ws(workspaceId, '/billing/checkout'), input);
  }
  openBillingPortal(workspaceId: string) {
    return this.request<BillingLinkDto>('POST', this.ws(workspaceId, '/billing/portal'));
  }
  listSupportGrants(workspaceId: string) {
    return this.request<{ data: SupportGrantDto[] }>('GET', this.ws(workspaceId, '/support-grants')).then(
      (r) => r.data,
    );
  }
  createSupportGrant(workspaceId: string, input: { hours?: number; reason?: string }) {
    return this.request<SupportGrantDto>('POST', this.ws(workspaceId, '/support-grants'), input);
  }
  revokeSupportGrant(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/support-grants/${enc(id)}`));
  }
  createSupportRequest(input: z.input<typeof CreateSupportRequest>) {
    return this.request<{ id: string }>('POST', '/v1/support/requests', input);
  }
  listSupportRequests() {
    return this.request<{
      data: { id: string; kind: string; subject: string; status: string; createdAt: string }[];
    }>('GET', '/v1/support/requests').then((r) => r.data);
  }
  reportClientError(input: ClientErrorRequest) {
    return this.request<void>('POST', '/v1/client-errors', input);
  }
  getStatus() {
    return this.request<StatusDto>('GET', '/v1/status');
  }

  // ----- The staff console (OPS-01) ----------------------------------------------------------------
  adminMe() {
    return this.request<StaffMeDto>('GET', '/v1/admin/me');
  }
  adminAccounts(q: string) {
    return this.request<{ data: AdminAccountDto[] }>('GET', `/v1/admin/accounts${query({ q })}`).then(
      (r) => r.data,
    );
  }
  adminAccountWorkspaces(id: string) {
    return this.request<{ data: AdminWorkspaceDto[] }>(
      'GET',
      `/v1/admin/accounts/${enc(id)}/workspaces`,
    ).then((r) => r.data);
  }
  adminSetPlan(workspaceId: string, input: AdminSetPlanRequest) {
    return this.request<void>('PUT', `/v1/admin/workspaces/${enc(workspaceId)}/plan`, input);
  }
  adminSupportView(workspaceId: string) {
    return this.request<SupportViewDto>('GET', `/v1/admin/support/${enc(workspaceId)}`);
  }
  adminFlags() {
    return this.request<{ data: FeatureFlagDto[] }>('GET', '/v1/admin/flags').then((r) => r.data);
  }
  adminSaveFlag(input: SaveFeatureFlagRequest) {
    return this.request<void>('PUT', '/v1/admin/flags', input);
  }
  adminDeleteFlag(key: string) {
    return this.request<void>('DELETE', `/v1/admin/flags/${enc(key)}`);
  }
  adminNotices() {
    return this.request<{ data: (SystemNoticeDto & { showFrom: string })[] }>(
      'GET',
      '/v1/admin/notices',
    ).then((r) => r.data);
  }
  adminCreateNotice(input: z.input<typeof CreateNoticeRequest>) {
    return this.request<{ id: string }>('POST', '/v1/admin/notices', input);
  }
  adminEndNotice(id: string) {
    return this.request<void>('POST', `/v1/admin/notices/${enc(id)}/end`);
  }
  adminAppVersions() {
    return this.request<AppVersionsDto>('GET', '/v1/admin/app-versions');
  }
  adminSaveAppVersions(input: AppVersionsDto) {
    return this.request<void>('PUT', '/v1/admin/app-versions', input);
  }
  adminImportFailures(days: number) {
    return this.request<{ data: ImportFailureRowDto[] }>(
      'GET',
      `/v1/admin/analytics/imports${query({ days })}`,
    ).then((r) => r.data);
  }
  adminAiAccuracy(days: number) {
    return this.request<{ data: AiAccuracyRowDto[] }>('GET', `/v1/admin/analytics/ai${query({ days })}`).then(
      (r) => r.data,
    );
  }
  adminSupportRequests() {
    return this.request<{ data: AdminSupportRequestDto[] }>('GET', '/v1/admin/support-requests').then(
      (r) => r.data,
    );
  }
  adminCloseSupportRequest(id: string) {
    return this.request<void>('POST', `/v1/admin/support-requests/${enc(id)}/close`);
  }
  adminSupportScreenshot(id: string) {
    return this.requestFile(`/v1/admin/support-requests/${enc(id)}/screenshot`).then((f) => f.blob);
  }
  adminMerchants(q: string) {
    return this.request<{
      data: {
        id: string;
        displayName: string;
        matchKey: string;
        categoryHint: string | null;
        version: number;
      }[];
    }>('GET', `/v1/admin/reference/merchants${query({ q })}`).then((r) => r.data);
  }
  adminSaveMerchant(input: z.input<typeof SaveMerchantRequest>) {
    return this.request<void>('PUT', '/v1/admin/reference/merchants', input);
  }
  adminMileageRates() {
    return this.request<{
      data: { country: string; effectiveFrom: string; tenthsOfCent: number; source: string }[];
    }>('GET', '/v1/admin/reference/mileage-rates').then((r) => r.data);
  }
  adminSaveMileageRate(input: SaveMileageRateRequest) {
    return this.request<void>('PUT', '/v1/admin/reference/mileage-rates', input);
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
  /** ADR-0033: what moving the account to other books would do; nothing changes. */
  previewAccountMove(workspaceId: string, accountId: string, entityId: string) {
    return this.request<AccountMovePreviewDto>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/move${query({ entityId })}`),
    );
  }
  moveAccount(workspaceId: string, accountId: string, entityId: string) {
    return this.request<AccountMovePreviewDto>(
      'POST',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/move`),
      {
        entityId,
      },
    );
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
  interestEarned(workspaceId: string, accountId: string) {
    return this.request<InterestEarnedDto>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/interest-earned`),
    );
  }
  cardStatements(workspaceId: string) {
    return this.request<{ data: CardStatementDto[] }>('GET', this.ws(workspaceId, '/card-statements')).then(
      (r) => r.data,
    );
  }
  cardStatement(workspaceId: string, accountId: string) {
    return this.request<{ data: CardStatementDto | null }>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/statement`),
    ).then((r) => r.data);
  }
  accountPerformance(workspaceId: string, accountId: string, range: BalanceRangeDto = '1y') {
    return this.request<InvestmentPerformanceDto>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/performance${query({ range })}`),
    );
  }
  listValuations(workspaceId: string, accountId: string) {
    return this.request<{ data: AccountValuationDto[] }>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/valuations`),
    ).then((r) => r.data);
  }
  addValuations(workspaceId: string, accountId: string, input: z.input<typeof AddValuationsRequest>) {
    return this.request<{ data: AccountValuationDto[] }>(
      'POST',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/valuations`),
      input,
    ).then((r) => r.data);
  }
  removeValuation(workspaceId: string, accountId: string, valuationId: string) {
    return this.request<{ data: AccountValuationDto[] }>(
      'DELETE',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/valuations/${enc(valuationId)}`),
    ).then((r) => r.data);
  }
  accountBalanceHistory(workspaceId: string, accountId: string, range: BalanceRangeDto = '1y') {
    return this.request<AccountBalanceHistoryDto>(
      'GET',
      this.ws(workspaceId, `/accounts/${enc(accountId)}/balance-history${query({ range })}`),
    );
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
  /** A plain transaction becomes a transfer to or from `accountId`, absorbing the other side if it was recorded. */
  makeTransfer(workspaceId: string, id: string, input: MakeTransferRequest) {
    return this.request<MakeTransferDto>(
      'POST',
      this.ws(workspaceId, `/transactions/${enc(id)}/make-transfer`),
      input,
    );
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
  // ----- Switching from another app (IMP-13) ---------------------------------------------------------------
  getMigrationEligibility(workspaceId: string) {
    return this.request<MigrationEligibilityDto>('GET', this.ws(workspaceId, '/migrations/eligibility'));
  }
  analyzeMigration(workspaceId: string, input: AnalyzeMigrationInput) {
    return this.request<MigrationAnalysisDto>('POST', this.ws(workspaceId, '/migrations/analyze'), input);
  }
  startMigration(workspaceId: string, input: StartMigrationInput) {
    return this.request<MigrationDto>('POST', this.ws(workspaceId, '/migrations'), input);
  }
  getMigration(workspaceId: string, id: string) {
    return this.request<MigrationDto>('GET', this.ws(workspaceId, `/migrations/${enc(id)}`));
  }
  commitMigration(workspaceId: string, id: string) {
    return this.request<MigrationDto>('POST', this.ws(workspaceId, `/migrations/${enc(id)}/commit`));
  }
  makeMigrationTransfers(workspaceId: string, id: string) {
    return this.request<{ made: number; migration: MigrationDto }>(
      'POST',
      this.ws(workspaceId, `/migrations/${enc(id)}/transfers`),
    );
  }
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

  // ----- Small business (BIZ-01..13, AI-10) ------------------------------------------------------------------
  listBusinesses(workspaceId: string) {
    return this.request<{ data: BusinessProfileDto[] }>('GET', this.ws(workspaceId, '/businesses')).then(
      (r) => r.data,
    );
  }
  getBusiness(workspaceId: string, entityId: string) {
    return this.request<BusinessProfileDto>('GET', this.ws(workspaceId, `/businesses/${enc(entityId)}`));
  }
  updateBusiness(workspaceId: string, entityId: string, input: UpdateBusinessInput) {
    return this.request<BusinessProfileDto>(
      'PATCH',
      this.ws(workspaceId, `/businesses/${enc(entityId)}`),
      input,
    );
  }
  /** ADR-0032: a PNG or JPEG, checked by its content on the server. */
  setBusinessLogo(workspaceId: string, entityId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<BusinessLogoDto>(
      'POST',
      this.ws(workspaceId, `/businesses/${enc(entityId)}/logo`),
      form,
    );
  }
  removeBusinessLogo(workspaceId: string, entityId: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/businesses/${enc(entityId)}/logo`));
  }
  /** Where the logo is served; through the web's API proxy it needs no token. The file id refreshes a cached copy. */
  businessLogoPath(workspaceId: string, entityId: string, fileId: string) {
    return this.ws(workspaceId, `/businesses/${enc(entityId)}/logo?v=${enc(fileId)}`);
  }
  getBusinessDashboard(
    workspaceId: string,
    entityId: string,
    opts: { months?: number; month?: string } = {},
  ) {
    return this.request<BusinessDashboardDto>(
      'GET',
      this.ws(workspaceId, `/businesses/${enc(entityId)}/dashboard${query(opts)}`),
    );
  }
  uploadBusinessFile(workspaceId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<{ fileId: string }>('POST', this.ws(workspaceId, '/businesses/files'), form);
  }
  listParties(workspaceId: string, opts: { entityId: string; kind?: PartyDto['kind'] }) {
    return this.request<{ data: PartyDto[] }>('GET', this.ws(workspaceId, `/parties${query(opts)}`)).then(
      (r) => r.data,
    );
  }
  createParty(workspaceId: string, input: CreatePartyInput) {
    return this.request<PartyDto>('POST', this.ws(workspaceId, '/parties'), input);
  }
  updateParty(workspaceId: string, id: string, input: UpdatePartyInput) {
    return this.request<PartyDto>('PATCH', this.ws(workspaceId, `/parties/${enc(id)}`), input);
  }
  listInvoices(
    workspaceId: string,
    opts: { entityId: string; status?: InvoiceDto['status']; partyId?: string },
  ) {
    return this.request<{ data: InvoiceDto[] }>('GET', this.ws(workspaceId, `/invoices${query(opts)}`)).then(
      (r) => r.data,
    );
  }
  getInvoice(workspaceId: string, id: string) {
    return this.request<InvoiceDto>('GET', this.ws(workspaceId, `/invoices/${enc(id)}`));
  }
  createInvoice(workspaceId: string, input: CreateInvoiceInput) {
    return this.request<InvoiceDto>('POST', this.ws(workspaceId, '/invoices'), input);
  }
  updateInvoice(workspaceId: string, id: string, input: UpdateInvoiceInput) {
    return this.request<InvoiceDto>('PATCH', this.ws(workspaceId, `/invoices/${enc(id)}`), input);
  }
  deleteInvoice(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/invoices/${enc(id)}`));
  }
  sendInvoice(workspaceId: string, id: string, input: SendInvoiceInput) {
    return this.request<InvoiceDto>('POST', this.ws(workspaceId, `/invoices/${enc(id)}/send`), input);
  }
  voidInvoice(workspaceId: string, id: string, input: { version: number }) {
    return this.request<InvoiceDto>('POST', this.ws(workspaceId, `/invoices/${enc(id)}/void`), input);
  }
  /** The PDF through the authenticated proxy, for a link. */
  invoicePdfPath(workspaceId: string, id: string) {
    return this.baseUrl + this.ws(workspaceId, `/invoices/${enc(id)}/pdf`);
  }
  listInvoiceCandidates(workspaceId: string, id: string) {
    return this.request<{ data: PaymentCandidateDto[] }>(
      'GET',
      this.ws(workspaceId, `/invoices/${enc(id)}/candidates`),
    ).then((r) => r.data);
  }
  recordInvoicePayment(workspaceId: string, id: string, input: RecordPaymentInput) {
    return this.request<InvoiceDto>('POST', this.ws(workspaceId, `/invoices/${enc(id)}/payments`), input);
  }
  removeInvoicePayment(workspaceId: string, id: string, paymentId: string) {
    return this.request<InvoiceDto>(
      'DELETE',
      this.ws(workspaceId, `/invoices/${enc(id)}/payments/${enc(paymentId)}`),
    );
  }
  listBills(workspaceId: string, opts: { entityId: string; status?: BillDto['status']; partyId?: string }) {
    return this.request<{ data: BillDto[] }>('GET', this.ws(workspaceId, `/bills${query(opts)}`)).then(
      (r) => r.data,
    );
  }
  createBill(workspaceId: string, input: CreateBillInput) {
    return this.request<BillDto>('POST', this.ws(workspaceId, '/bills'), input);
  }
  updateBill(workspaceId: string, id: string, input: UpdateBillInput) {
    return this.request<BillDto>('PATCH', this.ws(workspaceId, `/bills/${enc(id)}`), input);
  }
  listBillCandidates(workspaceId: string, id: string) {
    return this.request<{ data: PaymentCandidateDto[] }>(
      'GET',
      this.ws(workspaceId, `/bills/${enc(id)}/candidates`),
    ).then((r) => r.data);
  }
  payBill(workspaceId: string, id: string, input: RecordPaymentInput) {
    return this.request<BillDto>('POST', this.ws(workspaceId, `/bills/${enc(id)}/payment`), input);
  }
  removeBillPayment(workspaceId: string, id: string) {
    return this.request<BillDto>('DELETE', this.ws(workspaceId, `/bills/${enc(id)}/payment`));
  }
  billFilePath(workspaceId: string, id: string, fileId: string) {
    return this.baseUrl + this.ws(workspaceId, `/bills/${enc(id)}/files/${enc(fileId)}`);
  }
  getMileage(workspaceId: string, opts: { entityId: string; year?: number }) {
    return this.request<MileageSummaryDto>('GET', this.ws(workspaceId, `/mileage-trips${query(opts)}`));
  }
  createMileageTrip(workspaceId: string, input: CreateTripInput) {
    return this.request<MileageTripDto>('POST', this.ws(workspaceId, '/mileage-trips'), input);
  }
  updateMileageTrip(workspaceId: string, id: string, input: UpdateTripInput) {
    return this.request<MileageTripDto>('PATCH', this.ws(workspaceId, `/mileage-trips/${enc(id)}`), input);
  }
  deleteMileageTrip(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/mileage-trips/${enc(id)}`));
  }
  getTaxEstimate(workspaceId: string, opts: { entityId: string; year?: number }) {
    return this.request<TaxEstimateDto>('GET', this.ws(workspaceId, `/tax/estimates${query(opts)}`));
  }
  listTaxLines(workspaceId: string, form?: 'schedule_c' | 'schedule_e') {
    return this.request<{ data: TaxLineDto[] }>(
      'GET',
      this.ws(workspaceId, `/tax/lines${query({ form })}`),
    ).then((r) => r.data);
  }
  setTaxLine(workspaceId: string, categoryId: string, taxLineCode: string | null) {
    return this.request<void>('PATCH', this.ws(workspaceId, `/categories/${enc(categoryId)}/tax-line`), {
      taxLineCode,
    });
  }
  suggestTaxLines(workspaceId: string, entityId: string) {
    return this.request<{ data: TaxLineSuggestionDto[] }>(
      'POST',
      this.ws(workspaceId, `/businesses/${enc(entityId)}/tax-lines/suggest`),
    ).then((r) => r.data);
  }
  getPnl(workspaceId: string, opts: { entityId: string; from?: string; to?: string }) {
    return this.request<PnlDto>('GET', this.ws(workspaceId, `/reports/pnl${query(opts)}`));
  }
  getPartyReport(
    workspaceId: string,
    opts: { entityId: string; kind: PartyDto['kind']; from?: string; to?: string },
  ) {
    return this.request<PartyReportDto>('GET', this.ws(workspaceId, `/reports/parties${query(opts)}`));
  }
  getScheduleC(workspaceId: string, opts: { entityId: string; year?: number }) {
    return this.request<ScheduleCDto>('GET', this.ws(workspaceId, `/reports/schedule-c${query(opts)}`));
  }
  getMissingReceipts(workspaceId: string, opts: { entityId: string; year?: number }) {
    return this.request<MissingReceiptsDto>(
      'GET',
      this.ws(workspaceId, `/reports/missing-receipts${query(opts)}`),
    );
  }
  /** BIZ-13: the journal as a file. Goes through `fetch` so a refusal comes back as an error, not a saved page. */
  async downloadAccountingExport(
    workspaceId: string,
    opts: { entityId: string; from: string; to: string; format: AccountingExportFormat },
  ): Promise<{ blob: Blob; fileName: string }> {
    return this.requestFile(this.ws(workspaceId, `/exports/accounting${query(opts)}`));
  }

  // ----- Rental properties (RNT-01..14, UP-10) ------------------------------------------------------------
  listProperties(workspaceId: string, entityId: string) {
    return this.request<{ data: PropertyDto[] }>(
      'GET',
      this.ws(workspaceId, `/properties${query({ entityId })}`),
    ).then((r) => r.data);
  }
  getProperty(workspaceId: string, id: string) {
    return this.request<PropertyDto>('GET', this.ws(workspaceId, `/properties/${enc(id)}`));
  }
  createProperty(workspaceId: string, input: CreatePropertyInput) {
    return this.request<PropertyDto>('POST', this.ws(workspaceId, '/properties'), input);
  }
  updateProperty(workspaceId: string, id: string, input: UpdatePropertyInput) {
    return this.request<PropertyDto>('PATCH', this.ws(workspaceId, `/properties/${enc(id)}`), input);
  }
  createUnit(workspaceId: string, propertyId: string, input: CreateUnitInput) {
    return this.request<PropertyDto>(
      'POST',
      this.ws(workspaceId, `/properties/${enc(propertyId)}/units`),
      input,
    );
  }
  updateUnit(workspaceId: string, id: string, input: UpdateUnitInput) {
    return this.request<PropertyDto>('PATCH', this.ws(workspaceId, `/units/${enc(id)}`), input);
  }
  listTenants(workspaceId: string, entityId: string) {
    return this.request<{ data: TenantDto[] }>(
      'GET',
      this.ws(workspaceId, `/tenants${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createTenant(workspaceId: string, input: CreateTenantInput) {
    return this.request<TenantDto>('POST', this.ws(workspaceId, '/tenants'), input);
  }
  updateTenant(workspaceId: string, id: string, input: UpdateTenantInput) {
    return this.request<TenantDto>('PATCH', this.ws(workspaceId, `/tenants/${enc(id)}`), input);
  }
  listLeases(workspaceId: string, opts: { entityId: string; propertyId?: string }) {
    return this.request<{ data: LeaseDto[] }>('GET', this.ws(workspaceId, `/leases${query(opts)}`)).then(
      (r) => r.data,
    );
  }
  getLease(workspaceId: string, id: string) {
    return this.request<LeaseDto>('GET', this.ws(workspaceId, `/leases/${enc(id)}`));
  }
  createLease(workspaceId: string, input: CreateLeaseInput) {
    return this.request<LeaseDto>('POST', this.ws(workspaceId, '/leases'), input);
  }
  updateLease(workspaceId: string, id: string, input: UpdateLeaseInput) {
    return this.request<LeaseDto>('PATCH', this.ws(workspaceId, `/leases/${enc(id)}`), input);
  }
  getRentRoll(workspaceId: string, entityId: string, month?: string) {
    return this.request<RentRollDto>('GET', this.ws(workspaceId, `/rent-roll${query({ entityId, month })}`));
  }
  getArrears(workspaceId: string, entityId: string) {
    return this.request<ArrearsDto>('GET', this.ws(workspaceId, `/arrears${query({ entityId })}`));
  }
  updateRentCharge(workspaceId: string, id: string, input: UpdateChargeInput) {
    return this.request<RentChargeDto>('PATCH', this.ws(workspaceId, `/rent-charges/${enc(id)}`), input);
  }
  listRentPayments(workspaceId: string, leaseId: string) {
    return this.request<{ data: RentPaymentDto[] }>(
      'GET',
      this.ws(workspaceId, `/leases/${enc(leaseId)}/payments`),
    ).then((r) => r.data);
  }
  listLeaseCandidates(workspaceId: string, leaseId: string) {
    return this.request<{ data: LeaseCandidateDto[] }>(
      'GET',
      this.ws(workspaceId, `/leases/${enc(leaseId)}/candidates`),
    ).then((r) => r.data);
  }
  recordRentPayment(workspaceId: string, leaseId: string, input: RentPaymentInput) {
    return this.request<LeaseDto>('POST', this.ws(workspaceId, `/leases/${enc(leaseId)}/payments`), input);
  }
  removeRentPayment(workspaceId: string, leaseId: string, paymentId: string) {
    return this.request<void>(
      'DELETE',
      this.ws(workspaceId, `/leases/${enc(leaseId)}/payments/${enc(paymentId)}`),
    );
  }
  addDepositEvent(workspaceId: string, leaseId: string, input: DepositEventInput) {
    return this.request<LeaseDto>(
      'POST',
      this.ws(workspaceId, `/leases/${enc(leaseId)}/deposit-events`),
      input,
    );
  }
  removeDepositEvent(workspaceId: string, leaseId: string, eventId: string) {
    return this.request<LeaseDto>(
      'DELETE',
      this.ws(workspaceId, `/leases/${enc(leaseId)}/deposit-events/${enc(eventId)}`),
    );
  }
  listAllocationRules(workspaceId: string, entityId: string) {
    return this.request<{ data: AllocationRuleDto[] }>(
      'GET',
      this.ws(workspaceId, `/allocation-rules${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createAllocationRule(workspaceId: string, input: CreateAllocationRuleInput) {
    return this.request<{ id: string }>('POST', this.ws(workspaceId, '/allocation-rules'), input);
  }
  deleteAllocationRule(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/allocation-rules/${enc(id)}`));
  }
  allocateTransaction(workspaceId: string, id: string, input: AllocateTransactionInput) {
    return this.request<TransactionDto>(
      'POST',
      this.ws(workspaceId, `/transactions/${enc(id)}/allocate`),
      input,
    );
  }
  listLoans(workspaceId: string, entityId?: string) {
    return this.request<{ data: LoanDto[] }>(
      'GET',
      this.ws(workspaceId, `/loans${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createLoan(workspaceId: string, input: CreateLoanInput) {
    return this.request<LoanDto>('POST', this.ws(workspaceId, '/loans'), input);
  }
  updateLoan(workspaceId: string, id: string, input: UpdateLoanInput) {
    return this.request<LoanDto>('PATCH', this.ws(workspaceId, `/loans/${enc(id)}`), input);
  }
  getLoanSchedule(workspaceId: string, id: string) {
    return this.request<{ data: AmortizationRowDto[] }>(
      'GET',
      this.ws(workspaceId, `/loans/${enc(id)}/schedule`),
    ).then((r) => r.data);
  }
  recordLoanPayment(workspaceId: string, id: string, input: LoanPaymentInput) {
    return this.request<LoanDto>('POST', this.ws(workspaceId, `/loans/${enc(id)}/payments`), input);
  }
  removeLoanPayment(workspaceId: string, id: string, number: number) {
    return this.request<LoanDto>('DELETE', this.ws(workspaceId, `/loans/${enc(id)}/payments/${number}`));
  }
  listDepreciation(workspaceId: string, propertyId: string, year?: number) {
    return this.request<{ data: DepreciationDto[] }>(
      'GET',
      this.ws(workspaceId, `/properties/${enc(propertyId)}/depreciation${query({ year })}`),
    ).then((r) => r.data);
  }
  createDepreciation(workspaceId: string, input: CreateDepreciationInput) {
    return this.request<{ id: string }>('POST', this.ws(workspaceId, '/depreciation'), input);
  }
  deleteDepreciation(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/depreciation/${enc(id)}`));
  }
  listReminders(workspaceId: string, entityId: string) {
    return this.request<{ data: ReminderDto[] }>(
      'GET',
      this.ws(workspaceId, `/reminders${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createReminder(workspaceId: string, input: CreateReminderInput) {
    return this.request<ReminderDto>('POST', this.ws(workspaceId, '/reminders'), input);
  }
  updateReminder(workspaceId: string, id: string, input: UpdateReminderInput) {
    return this.request<ReminderDto>('PATCH', this.ws(workspaceId, `/reminders/${enc(id)}`), input);
  }
  listMaintenance(workspaceId: string, opts: { entityId: string; propertyId?: string }) {
    return this.request<{ data: MaintenanceDto[] }>(
      'GET',
      this.ws(workspaceId, `/maintenance${query(opts)}`),
    ).then((r) => r.data);
  }
  createMaintenance(workspaceId: string, input: CreateMaintenanceInput) {
    return this.request<MaintenanceDto>('POST', this.ws(workspaceId, '/maintenance'), input);
  }
  updateMaintenance(workspaceId: string, id: string, input: UpdateMaintenanceInput) {
    return this.request<MaintenanceDto>('PATCH', this.ws(workspaceId, `/maintenance/${enc(id)}`), input);
  }
  uploadRentalFile(workspaceId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<{ fileId: string }>('POST', this.ws(workspaceId, '/rentals/files'), form);
  }
  getPropertyBudget(workspaceId: string, propertyId: string, month?: string) {
    return this.request<PropertyBudgetDto>(
      'GET',
      this.ws(workspaceId, `/properties/${enc(propertyId)}/budget${query({ month })}`),
    );
  }
  savePropertyBudget(workspaceId: string, propertyId: string, input: SavePropertyBudgetInput) {
    return this.request<PropertyBudgetDto>(
      'PUT',
      this.ws(workspaceId, `/properties/${enc(propertyId)}/budget`),
      input,
    );
  }
  getRentalReport(workspaceId: string, opts: { entityId: string; from?: string; to?: string }) {
    return this.request<PortfolioReportDto>('GET', this.ws(workspaceId, `/reports/rental${query(opts)}`));
  }
  getScheduleE(workspaceId: string, opts: { entityId: string; year?: number }) {
    return this.request<ScheduleEDto>('GET', this.ws(workspaceId, `/reports/schedule-e${query(opts)}`));
  }
  downloadScheduleE(
    workspaceId: string,
    opts: { entityId: string; year?: number; format: ScheduleEExportFormat },
  ) {
    return this.requestFile(this.ws(workspaceId, `/exports/schedule-e${query(opts)}`));
  }

  // ----- Reports, search and asking (RPT-01..06) ------------------------------------------------------------
  getReport(workspaceId: string, type: ReportType, filters: ReportFiltersInput = {}) {
    return this.request<ReportDto>(
      'GET',
      this.ws(workspaceId, `/reports/catalog/${enc(type)}${query(reportQuery(filters))}`),
    );
  }
  downloadReport(
    workspaceId: string,
    type: ReportType,
    opts: ReportFiltersInput & { format: ReportExportFormat },
  ) {
    return this.requestFile(
      this.ws(workspaceId, `/reports/catalog/${enc(type)}/export${query(reportQuery(opts))}`),
    );
  }
  listSavedReports(workspaceId: string) {
    return this.request<{ data: SavedReportDto[] }>('GET', this.ws(workspaceId, '/saved-reports')).then(
      (r) => r.data,
    );
  }
  createSavedReport(workspaceId: string, input: CreateSavedReportInput) {
    return this.request<SavedReportDto>('POST', this.ws(workspaceId, '/saved-reports'), input);
  }
  deleteSavedReport(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/saved-reports/${enc(id)}`));
  }
  search(workspaceId: string, q: string) {
    return this.request<SearchResultsDto>('GET', this.ws(workspaceId, `/search${query({ q })}`));
  }
  ask(workspaceId: string, input: AskInput) {
    return this.request<AskAnswerDto>('POST', this.ws(workspaceId, '/ask'), input);
  }

  // ----- Notifications (NOT-01..03) ----------------------------------------------------------------------------
  listNotifications(workspaceId: string, opts: { limit?: number; unread?: boolean } = {}) {
    return this.request<NotificationListDto>(
      'GET',
      this.ws(
        workspaceId,
        `/notifications${query({ limit: opts.limit, unread: opts.unread ? 'true' : undefined })}`,
      ),
    );
  }
  notificationsUnread(workspaceId: string) {
    return this.request<{ unread: number }>('GET', this.ws(workspaceId, '/notifications/unread-count')).then(
      (r) => r.unread,
    );
  }
  markNotificationRead(workspaceId: string, id: string) {
    return this.request<void>('POST', this.ws(workspaceId, `/notifications/${enc(id)}/read`));
  }
  markAllNotificationsRead(workspaceId: string) {
    return this.request<void>('POST', this.ws(workspaceId, '/notifications/read-all'));
  }
  getNotificationPrefs() {
    return this.request<NotificationPrefsDto>('GET', '/v1/me/notification-prefs');
  }
  updateNotificationPrefs(input: UpdateNotificationPrefsInput) {
    return this.request<NotificationPrefsDto>('PATCH', '/v1/me/notification-prefs', input);
  }

  // ----- Data ownership (NFR-06, BAK-04..09, AUTH-12) -------------------------------------------------------------
  listBackups(workspaceId: string) {
    return this.request<{ data: ExportJobDto[] }>('GET', this.ws(workspaceId, '/backups')).then(
      (r) => r.data,
    );
  }
  createBackup(workspaceId: string, input: CreateBackupInput) {
    return this.request<ExportJobDto>('POST', this.ws(workspaceId, '/backups'), input);
  }
  createTaxPackage(workspaceId: string, input: CreateTaxPackageInput) {
    return this.request<ExportJobDto>('POST', this.ws(workspaceId, '/tax-package'), input);
  }
  getBackup(workspaceId: string, id: string) {
    return this.request<ExportJobDto>('GET', this.ws(workspaceId, `/backups/${enc(id)}`));
  }
  downloadBackup(workspaceId: string, id: string) {
    return this.requestFile(this.ws(workspaceId, `/backups/${enc(id)}/download`));
  }
  backupDownloadPath(workspaceId: string, id: string) {
    return this.baseUrl + this.ws(workspaceId, `/backups/${enc(id)}/download`);
  }
  getBackupSchedule(workspaceId: string) {
    return this.request<{ schedule: BackupScheduleDto | null }>(
      'GET',
      this.ws(workspaceId, '/backup-schedule'),
    ).then((r) => r.schedule);
  }
  saveBackupSchedule(workspaceId: string, input: SaveBackupScheduleInput) {
    return this.request<BackupScheduleDto>('PUT', this.ws(workspaceId, '/backup-schedule'), input);
  }
  deleteBackupSchedule(workspaceId: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, '/backup-schedule'));
  }
  listTrash(workspaceId: string) {
    return this.request<{ data: TrashItemDto[] }>('GET', this.ws(workspaceId, '/trash')).then((r) => r.data);
  }
  restoreFromTrash(workspaceId: string, kind: TrashItemDto['kind'], id: string) {
    return this.request<void>('POST', this.ws(workspaceId, `/trash/${enc(kind)}/${enc(id)}/restore`));
  }
  getStorageUsage(workspaceId: string) {
    return this.request<StorageUsageDto>('GET', this.ws(workspaceId, '/storage'));
  }
  /** The workspace's own storage (ADR-0031). Owners only. */
  getStorageDestination(workspaceId: string) {
    return this.request<{ destination: StorageDestinationDto | null }>(
      'GET',
      this.ws(workspaceId, '/storage-destination'),
    ).then((r) => r.destination);
  }
  testStorageDestination(workspaceId: string, connection: StorageConnectionInput, folder?: string) {
    return this.request<StorageTestResultDto>('POST', this.ws(workspaceId, '/storage-destination/test'), {
      connection,
      ...(folder ? { folder } : {}),
    });
  }
  connectStorageDestination(workspaceId: string, input: ConnectStorageInput) {
    return this.request<StorageDestinationDto>('POST', this.ws(workspaceId, '/storage-destination'), input);
  }
  updateStorageDestination(workspaceId: string, input: UpdateStorageInput) {
    return this.request<StorageDestinationDto>('PATCH', this.ws(workspaceId, '/storage-destination'), input);
  }
  disconnectStorageDestination(workspaceId: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, '/storage-destination'));
  }
  backfillStorageDestination(workspaceId: string) {
    return this.request<{ queued: number }>('POST', this.ws(workspaceId, '/storage-destination/backfill'));
  }
  retryStorageDestination(workspaceId: string) {
    return this.request<{ queued: number }>('POST', this.ws(workspaceId, '/storage-destination/retry'));
  }
  listStorageItems(workspaceId: string, status: StorageItemDto['status'] = 'failed') {
    return this.request<{ data: StorageItemDto[] }>(
      'GET',
      this.ws(workspaceId, `/storage-destination/items?status=${status}`),
    ).then((r) => r.data);
  }
  listRestores() {
    return this.request<{ data: RestoreJobDto[] }>('GET', '/v1/me/restores').then((r) => r.data);
  }
  uploadRestore(file: Blob, fileName: string, password?: string) {
    const form = new FormData();
    if (password) form.append('password', password);
    form.append('file', file, fileName);
    return this.request<RestoreJobDto>('POST', '/v1/me/restores', form);
  }
  getRestore(id: string, workspaceId?: string) {
    return this.request<RestoreJobDto>('GET', `/v1/me/restores/${enc(id)}${query({ workspaceId })}`);
  }
  confirmRestore(id: string, input: ConfirmRestoreInput) {
    return this.request<RestoreJobDto>('POST', `/v1/me/restores/${enc(id)}/confirm`, input);
  }
  getSecurityActivity() {
    return this.request<{ data: SecurityEventDto[] }>('GET', '/v1/me/security-activity').then((r) => r.data);
  }
  getDeletionStatus() {
    return this.request<DeletionStatusDto>('GET', '/v1/me/deletion');
  }
  requestDeletion(input: RequestDeletionInput) {
    return this.request<DeletionStatusDto>('POST', '/v1/me/deletion', input);
  }
  cancelDeletion() {
    return this.request<DeletionStatusDto>('DELETE', '/v1/me/deletion');
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
  /** `period`: any date in the period to show (default today); only the income, spending and budget figures follow it. */
  getDashboard(workspaceId: string, opts: { entityId?: string; memberId?: string; period?: string } = {}) {
    return this.request<DashboardDto>('GET', this.ws(workspaceId, `/dashboard${query(opts)}`));
  }
  /** The Home charts: monthly flows and net worth, budget so far, top spending, changes (DashboardChartsDto). */
  getDashboardCharts(
    workspaceId: string,
    opts: { months?: number; entityId?: string; memberId?: string } = {},
  ) {
    return this.request<DashboardChartsDto>('GET', this.ws(workspaceId, `/dashboard/charts${query(opts)}`));
  }
  /** Explore spending's "Make this my budget": one category, this period (the budget is created if needed). */
  setCategoryBudget(workspaceId: string, input: SetCategoryBudgetRequest) {
    return this.request<SetCategoryBudgetDto>('POST', this.ws(workspaceId, '/budgets/set-category'), input);
  }
  /** Explore spending: the picked categories month by month (SpendingExploreDto). */
  /** Month in review: the figures for one month (default last month), worded by AI or in plain sentences. */
  getMonthSummary(workspaceId: string, opts: { month?: string; entityId?: string; memberId?: string } = {}) {
    return this.request<MonthSummaryDto>('GET', this.ws(workspaceId, `/summary/month${query(opts)}`));
  }
  getSpendingExplore(
    workspaceId: string,
    opts: { months?: number; categoryIds?: string[]; entityId?: string; memberId?: string } = {},
  ) {
    const { categoryIds, ...rest } = opts;
    return this.request<SpendingExploreDto>(
      'GET',
      this.ws(
        workspaceId,
        `/spending/explore${query({ ...rest, ...(categoryIds?.length ? { categoryIds: categoryIds.join(',') } : {}) })}`,
      ),
    );
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
  /** UP-09: this week's receipts kept and missing, the streak, and the latest still waiting. */
  getReceiptHabit(workspaceId: string) {
    return this.request<ReceiptHabitDto>('GET', this.ws(workspaceId, '/receipts/habit'));
  }
  /** Spending without a receipt that's worth one (RCP-11, UP-09). */
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
  // ----- Payroll (PRL-01..05, ADR-0034) ----------------------------------------------------------------------
  listPayrollPeople(workspaceId: string, opts: { entityId: string; kind?: PersonKind }) {
    return this.request<{ data: PayrollPersonDto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/people${query(opts)}`),
    ).then((r) => r.data);
  }
  getPayrollPerson(workspaceId: string, id: string) {
    return this.request<PayrollPersonDto>('GET', this.ws(workspaceId, `/payroll/people/${enc(id)}`));
  }
  createPayrollPerson(workspaceId: string, input: CreatePersonInput) {
    return this.request<PayrollPersonDto>('POST', this.ws(workspaceId, '/payroll/people'), input);
  }
  updatePayrollPerson(workspaceId: string, id: string, input: UpdatePersonInput) {
    return this.request<PayrollPersonDto>('PATCH', this.ws(workspaceId, `/payroll/people/${enc(id)}`), input);
  }
  deletePayrollPerson(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/payroll/people/${enc(id)}`));
  }
  /** One full value; needs a recent sign-in, and is logged. */
  revealPayrollField(workspaceId: string, personId: string, input: RevealInput) {
    return this.request<RevealResponse>(
      'POST',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/reveal`),
      input,
    );
  }
  listW4(workspaceId: string, personId: string) {
    return this.request<{ data: W4Dto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/w4`),
    ).then((r) => r.data);
  }
  createW4(workspaceId: string, personId: string, input: CreateW4Input) {
    return this.request<W4Dto>('POST', this.ws(workspaceId, `/payroll/people/${enc(personId)}/w4`), input);
  }
  w4PdfPath(workspaceId: string, personId: string, id: string) {
    return this.baseUrl + this.ws(workspaceId, `/payroll/people/${enc(personId)}/w4/${enc(id)}/pdf`);
  }
  listW9(workspaceId: string, personId: string) {
    return this.request<{ data: W9Dto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/w9`),
    ).then((r) => r.data);
  }
  createW9(workspaceId: string, personId: string, input: CreateW9Input) {
    return this.request<W9Dto>('POST', this.ws(workspaceId, `/payroll/people/${enc(personId)}/w9`), input);
  }
  w9PdfPath(workspaceId: string, personId: string, id: string) {
    return this.baseUrl + this.ws(workspaceId, `/payroll/people/${enc(personId)}/w9/${enc(id)}/pdf`);
  }
  getI9(workspaceId: string, personId: string) {
    return this.request<{ data: I9Dto | null }>(
      'GET',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9`),
    ).then((r) => r.data);
  }
  saveI9Section1(workspaceId: string, personId: string, input: SaveI9Section1Input) {
    return this.request<I9Dto>(
      'PUT',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9/section1`),
      input,
    );
  }
  saveI9Section2(workspaceId: string, personId: string, input: SaveI9Section2Input) {
    return this.request<I9Dto>(
      'PUT',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9/section2`),
      input,
    );
  }
  addI9Document(workspaceId: string, personId: string, input: AddI9DocumentInput) {
    return this.request<I9Dto>(
      'POST',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9/documents`),
      input,
    );
  }
  removeI9Document(workspaceId: string, personId: string, documentId: string) {
    return this.request<I9Dto>(
      'DELETE',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9/documents/${enc(documentId)}`),
    );
  }
  destroyI9(workspaceId: string, personId: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9`));
  }
  i9PdfPath(workspaceId: string, personId: string) {
    return this.baseUrl + this.ws(workspaceId, `/payroll/people/${enc(personId)}/i9/pdf`);
  }
  i9DocumentFilePath(workspaceId: string, personId: string, documentId: string, fileId: string) {
    return (
      this.baseUrl +
      this.ws(
        workspaceId,
        `/payroll/people/${enc(personId)}/i9/documents/${enc(documentId)}/files/${enc(fileId)}`,
      )
    );
  }
  /** A copy of an identity document; sealed before it's stored. */
  uploadPayrollFile(workspaceId: string, entityId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<PayrollFileDto>(
      'POST',
      this.ws(workspaceId, `/payroll/files${query({ entityId })}`),
      form,
    );
  }
  // ----- Pay runs and reimbursements (PRL-06..11) --------------------------------------------------------------
  listPaySchedules(workspaceId: string, entityId: string) {
    return this.request<{ data: PayScheduleDto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/schedules${query({ entityId })}`),
    ).then((r) => r.data);
  }
  createPaySchedule(workspaceId: string, input: CreatePayScheduleInput) {
    return this.request<PayScheduleDto>('POST', this.ws(workspaceId, '/payroll/schedules'), input);
  }
  updatePaySchedule(workspaceId: string, id: string, input: UpdatePayScheduleInput) {
    return this.request<PayScheduleDto>(
      'PATCH',
      this.ws(workspaceId, `/payroll/schedules/${enc(id)}`),
      input,
    );
  }
  listPayRuns(workspaceId: string, entityId: string) {
    return this.request<{ data: PayRunDto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/runs${query({ entityId })}`),
    ).then((r) => r.data);
  }
  getPayRun(workspaceId: string, id: string) {
    return this.request<PayRunDto>('GET', this.ws(workspaceId, `/payroll/runs/${enc(id)}`));
  }
  createPayRun(workspaceId: string, input: CreatePayRunInput) {
    return this.request<PayRunDto>('POST', this.ws(workspaceId, '/payroll/runs'), input);
  }
  updatePayRun(workspaceId: string, id: string, input: UpdatePayRunInput) {
    return this.request<PayRunDto>('PATCH', this.ws(workspaceId, `/payroll/runs/${enc(id)}`), input);
  }
  deletePayRun(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/payroll/runs/${enc(id)}`));
  }
  updatePaycheck(workspaceId: string, runId: string, paycheckId: string, input: UpdatePaycheckInput) {
    return this.request<PayRunDto>(
      'PATCH',
      this.ws(workspaceId, `/payroll/runs/${enc(runId)}/paychecks/${enc(paycheckId)}`),
      input,
    );
  }
  approvePayRun(workspaceId: string, id: string, input: ApprovePayRunInput) {
    return this.request<PayRunDto>('POST', this.ws(workspaceId, `/payroll/runs/${enc(id)}/approve`), input);
  }
  reopenPayRun(workspaceId: string, id: string, version: number) {
    return this.request<PayRunDto>('POST', this.ws(workspaceId, `/payroll/runs/${enc(id)}/reopen`), {
      version,
    });
  }
  payslipPath(workspaceId: string, paycheckId: string) {
    return this.baseUrl + this.ws(workspaceId, `/payroll/paychecks/${enc(paycheckId)}/payslip`);
  }
  /** The payslip PDF as a file, for clients that can't open an authenticated link (the phone). */
  downloadPayslip(workspaceId: string, paycheckId: string) {
    return this.requestFile(this.ws(workspaceId, `/payroll/paychecks/${enc(paycheckId)}/payslip`));
  }
  listReimbursements(
    workspaceId: string,
    opts: { entityId: string; status?: ReimbursementStatus; personId?: string },
  ) {
    return this.request<{ data: ReimbursementDto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/reimbursements${query(opts)}`),
    ).then((r) => r.data);
  }
  createReimbursement(workspaceId: string, input: CreateReimbursementInput) {
    return this.request<ReimbursementDto>('POST', this.ws(workspaceId, '/payroll/reimbursements'), input);
  }
  decideReimbursement(workspaceId: string, id: string, input: DecideReimbursementInput) {
    return this.request<ReimbursementDto>(
      'POST',
      this.ws(workspaceId, `/payroll/reimbursements/${enc(id)}/decision`),
      input,
    );
  }
  reimbursementFilePath(workspaceId: string, id: string, fileId: string) {
    return this.baseUrl + this.ws(workspaceId, `/payroll/reimbursements/${enc(id)}/files/${enc(fileId)}`);
  }
  /** A receipt photo or PDF for a reimbursement (not sealed, unlike ID copies). */
  uploadReceiptForReimbursement(workspaceId: string, entityId: string, file: Blob, fileName: string) {
    const form = new FormData();
    form.append('file', file, fileName);
    return this.request<PayrollFileDto>(
      'POST',
      this.ws(workspaceId, `/payroll/files${query({ entityId, purpose: 'receipt' })}`),
      form,
    );
  }
  // ----- Payroll, stage 3: employer tax (PRL-12..16) -------------------------------------------------------------

  listDe4(workspaceId: string, personId: string) {
    return this.request<{ data: De4Dto[] }>(
      'GET',
      this.ws(workspaceId, `/payroll/people/${enc(personId)}/de4`),
    ).then((r) => r.data);
  }
  createDe4(workspaceId: string, personId: string, input: CreateDe4Input) {
    return this.request<De4Dto>('POST', this.ws(workspaceId, `/payroll/people/${enc(personId)}/de4`), input);
  }
  de4PdfPath(workspaceId: string, personId: string, id: string) {
    return this.baseUrl + this.ws(workspaceId, `/payroll/people/${enc(personId)}/de4/${enc(id)}/pdf`);
  }
  getPayrollSettings(workspaceId: string, entityId: string) {
    return this.request<PayrollSettingsDto>(
      'GET',
      this.ws(workspaceId, `/payroll/settings${query({ entityId })}`),
    );
  }
  updatePayrollSettings(workspaceId: string, entityId: string, input: UpdatePayrollSettingsInput) {
    return this.request<PayrollSettingsDto>(
      'PUT',
      this.ws(workspaceId, `/payroll/settings${query({ entityId })}`),
      input,
    );
  }
  getPayrollTaxes(workspaceId: string, entityId: string, year: number) {
    return this.request<PayrollTaxesDto>(
      'GET',
      this.ws(workspaceId, `/payroll/taxes${query({ entityId, year: String(year) })}`),
    );
  }
  recordPayrollDeposit(workspaceId: string, input: RecordDepositInput) {
    return this.request<PayrollDepositDto>('POST', this.ws(workspaceId, '/payroll/deposits'), input);
  }
  deletePayrollDeposit(workspaceId: string, id: string) {
    return this.request<void>('DELETE', this.ws(workspaceId, `/payroll/deposits/${enc(id)}`));
  }
  getPayrollWorksheet(
    workspaceId: string,
    entityId: string,
    form: WorksheetForm,
    year: number,
    quarter?: number,
  ) {
    return this.request<WorksheetDto>(
      'GET',
      this.ws(
        workspaceId,
        `/payroll/worksheets/${enc(form)}${query({
          entityId,
          year: String(year),
          ...(quarter ? { quarter: String(quarter) } : {}),
        })}`,
      ),
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
  AskAnswerDto,
  BackupScheduleDto,
  StorageDestinationDto,
  StorageItemDto,
  StorageTestResultDto,
  DeletionStatusDto,
  ExportJobDto,
  NotificationDto,
  NotificationListDto,
  NotificationPrefsDto,
  ReportDto,
  ReportExportFormat,
  ReportType,
  RestoreJobDto,
  SavedReportDto,
  SearchResultsDto,
  SecurityEventDto,
  StorageUsageDto,
  TrashItemDto,
  AllocationRuleDto,
  AmortizationRowDto,
  ArrearsDto,
  DepreciationDto,
  LeaseCandidateDto,
  LeaseDto,
  LoanDto,
  MaintenanceDto,
  PortfolioReportDto,
  PropertyBudgetDto,
  PropertyDto,
  ReminderDto,
  RentChargeDto,
  RentPaymentDto,
  RentRollDto,
  ScheduleEDto,
  ScheduleEExportFormat,
  TenantDto,
  BillDto,
  AccountMovePreviewDto,
  BusinessDashboardDto,
  BusinessLogoDto,
  BusinessProfileDto,
  InvoiceDto,
  InvoiceLineDto,
  InvoicePaymentDto,
  MileageSummaryDto,
  MileageTripDto,
  MissingReceiptsDto,
  PartyDto,
  PartyReportDto,
  PaymentCandidateDto,
  PnlDto,
  PnlLineDto,
  ScheduleCDto,
  TaxEstimateDto,
  TaxLineDto,
  TaxLineSuggestionDto,
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
  AccountBalanceHistoryDto,
  AccountDto,
  AccountValuationDto,
  CardStatementDto,
  InvestmentPerformanceDto,
  InterestEarnedDto,
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
  ReceiptHabitDto,
  ReceiptRecommendationDto,
  TripDto,
  BudgetDto,
  BudgetMoveDto,
  BudgetPeriodDto,
  CalendarDto,
  DashboardDto,
  DraftBudgetDto,
  ExpectedIncomeDto,
  DashboardChartsDto,
  SetCategoryBudgetDto,
  SetCategoryBudgetRequest,
  MonthSummaryDto,
  SpendingExploreDto,
  ForecastDto,
  GoalDto,
  NetWorthDto,
  PlanningSettingsDto,
  RecommendationDto,
  SankeyDto,
};

export type {
  AdminAccountDto,
  AdminSupportRequestDto,
  AdminWorkspaceDto,
  AppVersionsDto,
  BillingDto,
  FeatureFlagDto,
  StatusDto,
  SupportGrantDto,
  SystemNoticeDto,
};
