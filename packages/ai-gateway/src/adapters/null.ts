import type { CompletionResponse, ProviderAdapter } from '../types.js';

/** AI mode "off": never called by the gateway (it short-circuits), but safe if it is. */
export class NullAdapter implements ProviderAdapter {
  readonly id = 'null' as const;
  async complete(): Promise<CompletionResponse> {
    return { ok: false, reason: 'provider_error', detail: 'AI is off' };
  }
}
