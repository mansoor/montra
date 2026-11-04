/**
 * Typed API calls the app makes outside the sync engine (05 §2). Pure over an injected `fetch` and token
 * source so it is unit-testable; the sync endpoints themselves go through `FetchTransport` in @montra/sync.
 */
import type {
  BudgetDto,
  BudgetPeriodDto,
  CalendarDto,
  DashboardDto,
  ForecastDto,
  GoalDto,
  NetWorthDto,
  RecommendationDto,
  SankeyDto,
  CategoryProposalsResponse,
  ColumnMappingDto,
  ImportBatchDto,
  ImportRowDto,
  MeDto,
  ParseQuickAddRequest,
  QuickAddDraftDto,
  BillDto,
  AccountDto,
  ArrearsDto,
  BusinessProfileDto,
  LeaseDto,
  RentPaymentRequest,
  RentRollDto,
  ConfirmPayslipRequest,
  CreateTripRequest,
  InvoiceDto,
  MileageSummaryDto,
  MileageTripDto,
  PnlDto,
  TaxEstimateDto,
  CreatePayslipRequest,
  EmployerDto,
  PayslipDto,
  ReceiptDto,
  ReceiptFileDto,
  ReceiptPageDto,
  RegisterPushDeviceRequest,
  SuggestionDto,
  SuggestRequest,
  UploadDto,
  WorkspaceDto,
} from '@montra/schemas';

/** Review edits sent from the phone (RCP-06): line categories and amounts in minor units. */
export interface ReceiptReviewInput {
  version: string;
  lines: Array<{
    id?: string;
    rawText: string;
    expandedName?: string | null;
    lineTotal: string;
    discount?: string;
    taxable?: boolean;
    categoryId?: string | null;
    memberId?: string | null;
  }>;
}

export type ApplyReceiptInput =
  | { transactionId: string; version: string }
  | { createTransaction: { accountId: string; date?: string }; version: string };

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
      throw new ApiError(
        res.status,
        p.code ?? `http_${res.status}`,
        p.detail ?? p.title ?? `HTTP ${res.status}`,
      );
    }
    return json as T;
  }

  const ws = (id: string) => `/v1/workspaces/${encodeURIComponent(id)}`;

  return {
    request,
    me: () => request<MeDto>('GET', '/v1/me'),
    workspaces: async () => (await request<{ data: WorkspaceDto[] }>('GET', '/v1/workspaces')).data,
    aiSettings: (w: string) => request<{ mode: string }>('GET', `${ws(w)}/ai/settings`),

    // Planning (Phase 6): online reads (cached on the device by useCached) and online-only budget writes.
    dashboard: (w: string) => request<DashboardDto>('GET', `${ws(w)}/dashboard`),
    budgets: async (w: string) => (await request<{ data: BudgetDto[] }>('GET', `${ws(w)}/budgets`)).data,
    createBudget: (w: string, input: { entityId: string; name: string }) =>
      request<BudgetDto>('POST', `${ws(w)}/budgets`, input),
    budgetPeriod: (w: string, id: string, start = 'current') =>
      request<BudgetPeriodDto>('GET', `${ws(w)}/budgets/${id}/periods/${start}`),
    assignBudget: (
      w: string,
      id: string,
      start: string,
      categoryId: string,
      assigned: string,
      version: number,
    ) =>
      request<BudgetPeriodDto>('PUT', `${ws(w)}/budgets/${id}/periods/${start}/lines/${categoryId}`, {
        assigned,
        version,
      }),
    moveBudget: (
      w: string,
      id: string,
      start: string,
      input: { from: string | null; to: string | null; amount: string; version: number },
    ) => request<BudgetPeriodDto>('POST', `${ws(w)}/budgets/${id}/periods/${start}/moves`, input),
    copyBudget: (w: string, id: string, start: string, from: 'last' | 'avg3', version: number) =>
      request<BudgetPeriodDto>('POST', `${ws(w)}/budgets/${id}/periods/${start}/copy`, { from, version }),
    goals: async (w: string) => (await request<{ data: GoalDto[] }>('GET', `${ws(w)}/goals`)).data,
    sankey: (w: string, from: string, to: string) =>
      request<SankeyDto>('GET', `${ws(w)}/flow/sankey?from=${from}&to=${to}`),
    forecast: (w: string, days: number) => request<ForecastDto>('GET', `${ws(w)}/flow/forecast?days=${days}`),
    calendar: (w: string, from: string, to: string) =>
      request<CalendarDto>('GET', `${ws(w)}/calendar?from=${from}&to=${to}`),
    netWorth: (w: string) => request<NetWorthDto>('GET', `${ws(w)}/net-worth?months=12`),
    recommendations: async (w: string) =>
      (await request<{ data: RecommendationDto[] }>('GET', `${ws(w)}/recommendations?status=open`)).data,
    refreshRecommendations: (w: string) =>
      request<{ created: number; expired: number }>('POST', `${ws(w)}/recommendations/refresh`),
    acceptRecommendation: (w: string, id: string) =>
      request<RecommendationDto>('POST', `${ws(w)}/recommendations/${id}/accept`, {}),
    dismissRecommendation: (w: string, id: string) =>
      request<RecommendationDto>('POST', `${ws(w)}/recommendations/${id}/dismiss`),
    suggest: (w: string, req: SuggestRequest) =>
      request<SuggestionDto>('POST', `${ws(w)}/categorize/suggest`, req),
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

    // ----- Receipts (TXN-08/09, RCP-06) -----
    uploadReceiptFile: (w: string, file: UploadFile) => {
      const form = new FormData();
      form.append('file', file as unknown as Blob);
      return request<ReceiptFileDto>('POST', `${ws(w)}/receipts/files`, undefined, form);
    },
    /** Idempotent with a client id: a replayed offline capture returns the existing receipt. */
    createReceipt: (w: string, input: { id: string; fileIds: string[]; transactionId?: string | null }) =>
      request<ReceiptDto>('POST', `${ws(w)}/receipts`, {
        id: input.id,
        fileIds: input.fileIds,
        source: 'camera',
        ...(input.transactionId ? { transactionId: input.transactionId } : {}),
      }),
    listReceipts: (w: string, status?: ReceiptDto['status']) =>
      request<ReceiptPageDto>('GET', `${ws(w)}/receipts?limit=100${status ? `&status=${status}` : ''}`),
    getReceipt: (w: string, id: string) => request<ReceiptDto>('GET', `${ws(w)}/receipts/${id}`),
    /** Path of a page image; load it with the bearer header. */
    receiptFilePath: (w: string, id: string, fileId: string) => `${ws(w)}/receipts/${id}/files/${fileId}`,
    updateReceipt: (w: string, id: string, input: ReceiptReviewInput) =>
      request<ReceiptDto>('PATCH', `${ws(w)}/receipts/${id}`, input),
    applyReceipt: (w: string, id: string, input: ApplyReceiptInput) =>
      request<ReceiptDto>('POST', `${ws(w)}/receipts/${id}/apply`, input),
    matchReceipt: (w: string, id: string) => request<ReceiptDto>('POST', `${ws(w)}/receipts/${id}/match`),
    rejectReceipt: (w: string, id: string) => request<ReceiptDto>('POST', `${ws(w)}/receipts/${id}/reject`),

    // ----- Business (08 §3): reads, and logging a trip. Invoices and bills are written on the web. ------------
    businesses: async (w: string) =>
      (await request<{ data: BusinessProfileDto[] }>('GET', `${ws(w)}/businesses`)).data,
    pnl: (w: string, entityId: string) => request<PnlDto>('GET', `${ws(w)}/reports/pnl?entityId=${entityId}`),
    invoices: async (w: string, entityId: string) =>
      (await request<{ data: InvoiceDto[] }>('GET', `${ws(w)}/invoices?entityId=${entityId}`)).data,
    bills: async (w: string, entityId: string) =>
      (await request<{ data: BillDto[] }>('GET', `${ws(w)}/bills?entityId=${entityId}`)).data,
    taxEstimate: (w: string, entityId: string) =>
      request<TaxEstimateDto>('GET', `${ws(w)}/tax/estimates?entityId=${entityId}`),
    mileage: (w: string, entityId: string) =>
      request<MileageSummaryDto>('GET', `${ws(w)}/mileage-trips?entityId=${entityId}`),
    createMileageTrip: (w: string, input: CreateTripRequest) =>
      request<MileageTripDto>('POST', `${ws(w)}/mileage-trips`, input),

    // ----- Rentals (08 §3): reads, and logging rent. The rest is managed on the web. ---------------
    rentalPortfolios: async (w: string) =>
      (
        await request<{ data: { id: string; name: string; type: string }[] }>('GET', `${ws(w)}/entities`)
      ).data.filter((e) => e.type === 'rental'),
    rentRoll: (w: string, entityId: string) =>
      request<RentRollDto>('GET', `${ws(w)}/rent-roll?entityId=${entityId}`),
    arrears: (w: string, entityId: string) =>
      request<ArrearsDto>('GET', `${ws(w)}/arrears?entityId=${entityId}`),
    accountList: async (w: string) =>
      (await request<{ data: AccountDto[] }>('GET', `${ws(w)}/accounts`)).data,
    recordRent: (w: string, leaseId: string, input: RentPaymentRequest) =>
      request<LeaseDto>('POST', `${ws(w)}/leases/${leaseId}/payments`, input),

    // ----- Payslips (PAY-03): read live, never stored on the device (PAY-09). --------------------------------
    listEmployers: async (w: string) =>
      (await request<{ data: EmployerDto[] }>('GET', `${ws(w)}/employers`)).data,
    uploadPayslipFile: (w: string, file: UploadFile) => {
      const form = new FormData();
      form.append('file', file as unknown as Blob);
      return request<ReceiptFileDto>('POST', `${ws(w)}/payslips/files`, undefined, form);
    },
    createPayslip: (w: string, input: Partial<CreatePayslipRequest> & { employerId: string }) =>
      request<PayslipDto>('POST', `${ws(w)}/payslips`, input),
    listPayslips: async (w: string) =>
      (await request<{ data: PayslipDto[] }>('GET', `${ws(w)}/payslips`)).data,
    getPayslip: (w: string, id: string) => request<PayslipDto>('GET', `${ws(w)}/payslips/${id}`),
    /** Path of a payslip's page; load it with the bearer header. */
    payslipFilePath: (w: string, id: string, fileId: string) => `${ws(w)}/payslips/${id}/files/${fileId}`,
    confirmPayslip: (w: string, id: string, input: ConfirmPayslipRequest) =>
      request<PayslipDto>('POST', `${ws(w)}/payslips/${id}/confirm`, input),
    deletePayslip: (w: string, id: string) => request<void>('DELETE', `${ws(w)}/payslips/${id}`),

    registerPushDevice: (req: RegisterPushDeviceRequest) =>
      request<{ id: string }>('POST', '/v1/me/push-devices', req),
    removePushDevice: (token: string) =>
      request<void>('DELETE', `/v1/me/push-devices/${encodeURIComponent(token)}`),
  };
}
