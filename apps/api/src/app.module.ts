import { Module, type DynamicModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { CONFIG, loadConfig, type AppConfig } from './config.js';
import { Db } from './db/database.js';
import { AUTH_PORT, AuthGuard, DevAuthAdapter, WorkspaceGuard } from './auth/auth.js';
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

@Module({})
export class AppModule {
  static forRoot(config: AppConfig = loadConfig()): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WorkspacesController, AccountsController, TransactionsController],
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: APP_FILTER, useClass: ProblemFilter },
        // Phase 1 replaces this with the Ory Kratos adapter when AUTH_MODE=kratos.
        { provide: AUTH_PORT, useClass: DevAuthAdapter },
        Db,
        AuthGuard,
        WorkspaceGuard,
        IdempotencyInterceptor,
        LedgerService,
        WorkspacesService,
        AccountsService,
        TransactionsService,
      ],
    };
  }
}
