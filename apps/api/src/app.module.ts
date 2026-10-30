import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CONFIG, loadConfig, type AppConfig } from './config.js';
import { Db } from './db/database.js';
import { AUTH_PORT, AuthGuard, DevAuthAdapter, WorkspaceGuard } from './auth/auth.js';
import { KratosAuthAdapter } from './auth/kratos.adapter.js';
import { SessionsController } from './auth/sessions.controller.js';
import { KratosHooksController } from './auth/kratos-hooks.controller.js';
import { AccountSecurityController } from './auth/account-security.controller.js';
import { ProblemFilter } from './common/problem.filter.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import { LedgerService } from './ledger/ledger.service.js';
import { WorkspacesService } from './workspaces/workspaces.service.js';
import { WorkspacesController } from './workspaces/workspaces.controller.js';
import { AccountsService } from './accounts/accounts.service.js';
import { AccountsController } from './accounts/accounts.controller.js';
import { TransactionsService } from './transactions/transactions.service.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { HealthController } from './health/health.controller.js';
import { FieldCrypto, KMS_PORT, LocalKms } from './crypto/crypto.service.js';
import { TransactionPoster } from './transactions/poster.js';
import { EntitiesController, FamilyMembersController, MeController } from './settings/settings.controller.js';
import { JournalsController } from './journals/journals.controller.js';
import { InviteAcceptController, SharingController } from './sharing/sharing.controller.js';
import { RecurringService } from './recurring/recurring.service.js';
import { RecurringController } from './recurring/recurring.controller.js';
import { SyncController } from './sync/sync.controller.js';
import { RealtimeService } from './realtime/realtime.service.js';
import { mailProvider } from './mail/mail.service.js';
import { storageProvider } from './storage/storage.js';
import { JobQueue, Worker } from './jobs/queue.js';
import { ImportsService } from './imports/imports.service.js';
import { ImportJobs } from './imports/import-jobs.js';
import { ImportsController, UploadsController } from './imports/imports.controller.js';
import { ReconciliationController } from './reconciliation/reconciliation.controller.js';

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
      UploadsController,
      ImportsController,
      ReconciliationController,
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
        TransactionsService,
        TransactionPoster,
        RecurringService,
        // Production binds the AWS KMS adapter here.
        { provide: KMS_PORT, useClass: LocalKms },
        FieldCrypto,
        ...(opts.worker ? [] : [RealtimeService]),
        mailProvider(config),
        storageProvider(config),
        JobQueue,
        Worker,
        ImportsService,
        ImportJobs,
      ],
    };
  }
}
