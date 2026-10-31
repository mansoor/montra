/** Runtime settings baked in at build time (app.config.ts `extra`). */
import Constants from 'expo-constants';
import type { AuthMode } from './auth/kratos';

export interface AppConfig {
  apiUrl: string;
  kratosUrl: string | null;
  authMode: AuthMode;
  projectId: string | null;
  version: string;
}

const extra = (Constants.expoConfig?.extra ?? {}) as Record<string, unknown>;

export const config: AppConfig = {
  apiUrl: String(extra.apiUrl ?? 'http://localhost:4000').replace(/\/$/, ''),
  kratosUrl: typeof extra.kratosUrl === 'string' ? extra.kratosUrl : null,
  authMode: extra.authMode === 'kratos' ? 'kratos' : 'dev',
  projectId: (extra.eas as { projectId?: string } | undefined)?.projectId ?? null,
  version: Constants.expoConfig?.version ?? '0.0.0',
};
