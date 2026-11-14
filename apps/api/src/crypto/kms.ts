import { previousMasterKey, type AppConfig } from '../config.js';
import { AwsKms, LocalKms, type KmsPort } from './crypto.service.js';
import { VaultKms } from './vault-kms.js';

type Mode = AppConfig['KMS_MODE'];

function adapter(config: AppConfig, mode: Mode, role: 'current' | 'previous'): KmsPort {
  if (mode === 'aws') return new AwsKms(config);
  if (mode === 'vault') return new VaultKms(config);
  return role === 'current'
    ? new LocalKms(config.MASTER_KEY)
    : new LocalKms(previousMasterKey(config), 'PREVIOUS_MASTER_KEY');
}

/**
 * During a move between modes (ADR-0050 §3): new keys are wrapped with the current adapter, and a key the current one
 * can't unwrap is tried with the previous one. `crypto:rewrap` moves the stored keys across while this runs.
 */
export class MovingKms implements KmsPort {
  constructor(
    readonly current: KmsPort,
    readonly previous: KmsPort,
  ) {}

  wrap(dataKey: Buffer): Promise<Buffer> {
    return this.current.wrap(dataKey);
  }

  async unwrap(wrapped: Buffer): Promise<Buffer> {
    try {
      return await this.current.unwrap(wrapped);
    } catch (first) {
      try {
        return await this.previous.unwrap(wrapped);
      } catch {
        throw first;
      }
    }
  }
}

/** The adapter for KMS_MODE, with KMS_PREVIOUS_MODE behind it while keys are being moved. */
export function createKms(config: AppConfig): KmsPort {
  const current = adapter(config, config.KMS_MODE, 'current');
  return config.KMS_PREVIOUS_MODE
    ? new MovingKms(current, adapter(config, config.KMS_PREVIOUS_MODE, 'previous'))
    : current;
}
