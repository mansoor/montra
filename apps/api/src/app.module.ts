import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { CONFIG, loadConfig, type AppConfig } from './config.js';
import { Db } from './db/database.js';
import { AUTH_PORT, AuthGuard, DevAuthAdapter, WorkspaceGuard } from './auth/auth.js';
import { KratosAuthAdapter } from './auth/kratos.adapter.js';
import { SessionsController } from './auth/sessions.controller.js';
import { KratosHooksController } from './auth/kratos-hooks.controller.js';
import { AccountSecurityController } from './auth/account-security.controller.js';
import { PhoneController } from './sms/phone.controller.js';
import { ProblemFilter } from './common/problem.filter.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import { LedgerService } from './ledger/ledger.service.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { AccountMoveService } from './accounts/account-move.service.js';
import { AccountsService } from './accounts/accounts.service.js';
import { ValuationsService } from './accounts/valuations.service.js';
import { CardsService } from './accounts/cards.service.js';
import { CategoriesService } from './accounts/categories.service.js';
import { AccountsController } from './accounts/accounts.controller.js';
import { TransactionsService } from './transactions/transactions.service.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { HealthController } from './health/health.controller.js';
import { FieldCrypto, KMS_PORT } from './crypto/crypto.service.js';
import { createKms } from './crypto/kms.js';
import { AdminService } from './ops/admin.service.js';
import { BILLING_PORT, billingProvider } from './ops/billing.port.js';
import { BillingService } from './ops/billing.service.js';
import { Plans } from './ops/plans.js';
import { ProviderHealth, trackedProvider } from './ops/provider-health.js';
import { ServiceSettings } from './ops/service-settings.js';
import { SMS_PORT, smsProvider } from './sms/sms.js';
import { TextsService } from './sms/texts.service.js';
import { ProvidersService } from './ops/providers.service.js';
import { AdminPlansService } from './ops/admin-plans.service.js';
import { AdminAccountsService } from './ops/admin-accounts.service.js';
import { errorReporterProvider } from './ops/errors.js';
import { AppVersionInterceptor, MetricsService } from './ops/metrics.js';
import {
  AdminController,
  BillingWebhookController,
  MetricsController,
  PlansController,
  StatusController,
  SupportController,
  WorkspaceOpsController,
} from './ops/ops.controller.js';
import { OpsJobs } from './ops/ops-jobs.js';
import { AdminDb, StaffGuard, SupportDb } from './ops/staff.js';
import { StatusService, SupportService } from './ops/support.service.js';
import { TransactionPoster } from './transactions/poster.js';
import { EntitiesController, FamilyMembersController, MeController } from './settings/settings.controller.js';
import { JournalsController } from './journals/journals.controller.js';
import { InviteAcceptController, SharingController } from './sharing/sharing.controller.js';
import { RecurringService } from './recurring/recurring.service.js';
import { RecurringController } from './recurring/recurring.controller.js';
import { PushDevicesController, SyncController } from './sync/sync.controller.js';
import { SyncService } from './sync/sync.service.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { MAIL_PORT, mailProvider } from './mail/mail.service.js';
import { STORAGE_PORT, storageProvider } from './storage/storage.js';
import { StorageController } from './storage/storage.controller.js';
import { StorageDestinationsService } from './storage/storage-destinations.service.js';
import { FileBytes } from './storage/file-bytes.js';
import { MissingFilesController } from './storage/missing-files.controller.js';
import { MissingFiles } from './storage/missing-files.js';
import { StorageMirrorJobs } from './storage/storage-mirror.jobs.js';
import { fakeVaultTransport } from './storage/vault/fake.js';
import { guardedVaultTransport, VAULT_TRANSPORT } from './storage/vault/transport.js';
import {
  FakeVaultController,
  VaultController,
  VaultOpenController,
} from './storage/vault/vault.controller.js';
import { VaultFeed } from './storage/vault/vault.feed.js';
import { VaultJobs } from './storage/vault/vault.jobs.js';
import { VaultOpener } from './storage/vault/vault.open.js';
import { VaultService } from './storage/vault/vault.service.js';
import { JobQueue, Worker } from './jobs/queue.js';
import { ImportsService } from './imports/imports.service.js';
import { ImportJobs } from './imports/import-jobs.js';
import { ImportsController, UploadsController } from './imports/imports.controller.js';
import { MigrationsController } from './imports/migrations.controller.js';
import { MigrationsService } from './imports/migrations.service.js';
import { ReconciliationController } from './reconciliation/reconciliation.controller.js';
import { AiService } from './ai/ai.service.js';
import { AiController } from './ai/ai.controller.js';
import { Categorizer } from './categorization/categorizer.service.js';
import { MerchantDirectory } from './categorization/merchants.js';
import { RulesService } from './categorization/rules.service.js';
import { ReviewService } from './categorization/review.service.js';
import { InsightsService } from './categorization/insights.service.js';
import { CategorizationController } from './categorization/categorization.controller.js';
import { FX_HTTP, FxRatesService } from './fx/fx.service.js';
import { FxController } from './fx/fx.controller.js';
import { ReceiptsService } from './receipts/receipts.service.js';
import { ReceiptJobs } from './receipts/receipt-jobs.js';
import { ReceiptsController } from './receipts/receipts.controller.js';
import { TripsController, TripsService } from './trips/trips.js';
import type { HttpGet } from './fx/sources.js';
import { PlanningData } from './planning/data.js';
import { BudgetsService } from './planning/budgets.service.js';
import { GoalsService } from './planning/goals.service.js';
import { IncomeService } from './planning/income.service.js';
import { BillersService } from './planning/billers.service.js';
import { HouseholdBillsService } from './planning/household-bills.service.js';
import { HouseholdBillsController } from './planning/household-bills.controller.js';
import { FlowService } from './planning/flow.service.js';
import { MonthSummaryService } from './planning/month-summary.service.js';
import { RecommendationsService } from './planning/recommendations.service.js';
import { PlanningController } from './planning/planning.controller.js';
import { BillsService } from './business/bills.service.js';
import { BusinessController } from './business/business.controller.js';
import { BusinessJobs } from './business/business-jobs.service.js';
import { BusinessReportsService } from './business/business-reports.service.js';
import { BusinessService } from './business/business.service.js';
import { ExportService } from './business/export.service.js';
import { InvoicesService } from './business/invoices.service.js';
import { MileageService } from './business/mileage.service.js';
import { PaymentLinks } from './business/payment-links.service.js';
import { AssetsController } from './business/assets.controller.js';
import { AssetsService } from './business/assets.service.js';
import { ExpenseDetailsService } from './business/expense-details.service.js';
import { FormsService } from './payroll/forms.service.js';
import { PayRunsService } from './payroll/pay-runs.service.js';
import { PayrollTaxesService } from './payroll/payroll-taxes.service.js';
import { YearEndService } from './payroll/year-end.service.js';
import { ReimbursementsService } from './payroll/reimbursements.service.js';
import { BuiltInTaxEngine, PAYROLL_TAX_ENGINE } from './payroll/tax-engine.js';
import { PayrollController } from './payroll/payroll.controller.js';
import { PeopleService } from './payroll/people.service.js';
import { LeaveService } from './payroll/leave.service.js';
import { ContractorTimeService } from './payroll/contractor-time.service.js';
import { BackupService } from './data/backup.service.js';
import { AccountDataController, DataController, RestoresController } from './data/data.controller.js';
import { OwnershipService } from './data/ownership.service.js';
import { RestoreService } from './data/restore.service.js';
import { NotificationJobs } from './notifications/notification-jobs.service.js';
import {
  NotificationPrefsController,
  NotificationsController,
  UnsubscribeController,
} from './notifications/notifications.controller.js';
import { NotificationsService } from './notifications/notifications.service.js';
import { PUSH_PORT, pushProvider } from './notifications/push.js';
import { ReportsController } from './reports/reports.controller.js';
import { ReportsService } from './reports/reports.service.js';
import { SearchService } from './reports/search.service.js';
import { LoansService } from './rentals/loans.service.js';
import { PropertiesService } from './rentals/properties.service.js';
import { RentService } from './rentals/rent.service.js';
import { RentalJobs } from './rentals/rental-jobs.service.js';
import { RentalOpsService } from './rentals/rental-ops.service.js';
import { RentalPeopleService } from './rentals/rental-people.service.js';
import { RentalReportsService } from './rentals/rental-reports.service.js';
import { RentalsController } from './rentals/rentals.controller.js';
import { PayslipsService } from './payslips/payslips.service.js';
import { PayslipJobs } from './payslips/payslip-jobs.js';
import { ScanJobs } from './scans/scan-jobs.js';
import { IntakeJobs } from './intakes/intake-jobs.js';
import { IntakesController } from './intakes/intakes.controller.js';
import { IntakesService } from './intakes/intakes.service.js';
import { TaxFormsController } from './tax-forms/tax-forms.controller.js';
import { TaxFormsService } from './tax-forms/tax-forms.service.js';
import { TaxFormReading } from './tax-forms/tax-form-reading.js';
import { ScansController } from './scans/scans.controller.js';
import { ScansService } from './scans/scans.service.js';
import { MemberReportsService } from './payslips/member-reports.service.js';
import { PayslipsController } from './payslips/payslips.controller.js';

/** Outbound HTTP for the FX sources, with a timeout. */
const httpGet: HttpGet = (url) => fetch(url, { signal: AbortSignal.timeout(30_000) });

@Module({})
export class AppModule {
  /** `worker: true` builds the job-runner context (ADR-0002): same services, no HTTP controllers or sockets. */
  static forRoot(config: AppConfig = loadConfig(), opts: { worker?: boolean } = {}): DynamicModule {
    const controllers = [
      HealthController,
      MeController,
      SessionsController,
      KratosHooksController,
      AccountSecurityController,
      PhoneController,
      WorkspacesController,
      EntitiesController,
      FamilyMembersController,
      AccountsController,
      TransactionsController,
      JournalsController,
      SharingController,
      InviteAcceptController,
      RecurringController,
      SyncController,
      PushDevicesController,
      UploadsController,
      ImportsController,
      MigrationsController,
      ReconciliationController,
      AiController,
      CategorizationController,
      FxController,
      ReceiptsController,
      TripsController,
      PlanningController,
      PayslipsController,
      ScansController,
      IntakesController,
      TaxFormsController,
      HouseholdBillsController,
      BusinessController,
      AssetsController,
      PayrollController,
      RentalsController,
      WorkspaceOpsController,
      SupportController,
      StatusController,
      BillingWebhookController,
      MetricsController,
      AdminController,
      PlansController,
      ReportsController,
      NotificationsController,
      DataController,
      StorageController,
      VaultController,
      VaultOpenController,
      MissingFilesController,
      ...(config.FAMILY_VAULT_FAKE ? [FakeVaultController] : []),
      RestoresController,
      AccountDataController,
      NotificationPrefsController,
      UnsubscribeController,
    ];
    return {
      module: AppModule,
      controllers: opts.worker ? [] : controllers,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemFilter },
        { provide: AUTH_PORT, useClass: config.AUTH_MODE === 'kratos' ? KratosAuthAdapter : DevAuthAdapter },
        Db,
        AuthGuard,
        WorkspaceGuard,
        IdempotencyInterceptor,
        LedgerService,
        WorkspacesService,
        AccountsService,
        AccountMoveService,
        ValuationsService,
        CardsService,
        CategoriesService,
        TransactionsService,
        TransactionPoster,
        RecurringService,
        ...trackedProvider(KMS_PORT, 'keys', { useFactory: () => createKms(config) }),
        errorReporterProvider(config),
        ...trackedProvider(BILLING_PORT, 'payments', billingProvider(config), config.BILLING_MODE === 'off'),
        ProviderHealth,
        ...trackedProvider(SMS_PORT, 'sms', smsProvider(config), config.SMS_MODE === 'off'),
        TextsService,
        ServiceSettings,
        Plans,
        BillingService,
        AdminDb,
        SupportDb,
        StaffGuard,
        AdminService,
        AdminPlansService,
        AdminAccountsService,
        ProvidersService,
        SupportService,
        StatusService,
        MetricsService,
        OpsJobs,
        AppVersionInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: AppVersionInterceptor },
        FieldCrypto,
        ...(opts.worker ? [] : [RealtimeService]),
        ...trackedProvider(MAIL_PORT, 'email', mailProvider(config)),
        ...trackedProvider(STORAGE_PORT, 'storage', storageProvider(config)),
        JobQueue,
        Worker,
        ImportsService,
        MigrationsService,
        ImportJobs,
        AiService,
        Categorizer,
        MerchantDirectory,
        RulesService,
        ReviewService,
        InsightsService,
        SyncService,
        FxRatesService,
        ReceiptsService,
        ReceiptJobs,
        TripsService,
        PlanningData,
        BudgetsService,
        GoalsService,
        IncomeService,
        BillersService,
        HouseholdBillsService,
        FlowService,
        MonthSummaryService,
        RecommendationsService,
        PayslipsService,
        BusinessService,
        PaymentLinks,
        InvoicesService,
        BillsService,
        MileageService,
        BusinessReportsService,
        ExportService,
        BusinessJobs,
        AssetsService,
        ExpenseDetailsService,
        PeopleService,
        FormsService,
        PayRunsService,
        ReimbursementsService,
        { provide: PAYROLL_TAX_ENGINE, useClass: BuiltInTaxEngine },
        PayrollTaxesService,
        YearEndService,
        LeaveService,
        ContractorTimeService,
        PropertiesService,
        RentService,
        LoansService,
        RentalOpsService,
        RentalReportsService,
        RentalPeopleService,
        RentalJobs,
        BackupService,
        StorageDestinationsService,
        FileBytes,
        MissingFiles,
        StorageMirrorJobs,
        VaultService,
        VaultJobs,
        VaultFeed,
        VaultOpener,
        {
          provide: VAULT_TRANSPORT,
          // An answer may be a file Montra sent (ADR-0054 §5), as large as an upload may be.
          useFactory: () =>
            config.FAMILY_VAULT_FAKE
              ? fakeVaultTransport()
              : guardedVaultTransport({
                  maxBytes: Math.max(4 * 1024 * 1024, config.MAX_UPLOAD_BYTES + 1024 * 1024),
                }),
        },
        RestoreService,
        OwnershipService,
        NotificationsService,
        NotificationJobs,
        ...trackedProvider(PUSH_PORT, 'push', pushProvider),
        ReportsService,
        SearchService,
        PayslipJobs,
        ScansService,
        ScanJobs,
        IntakesService,
        IntakeJobs,
        TaxFormsService,
        TaxFormReading,
        MemberReportsService,
        { provide: FX_HTTP, useValue: httpGet },
      ],
    };
  }
}
