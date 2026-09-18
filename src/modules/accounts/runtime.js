import { AccountRepository } from './account-repository.js';
import { AccountService } from './account-service.js';
import { AccountRateLimiter } from './rate-limiter.js';
import { createSessionTokenCodec } from '../auth/token-codec.js';
import { keyringFromSerialized } from '../../security/keyring-config.js';
import { FakeEmailTransport, HttpEmailTransport } from '../../integrations/email/transport.js';

export function createAccountsRuntime({ pool, redis, config }) {
  if (!config.accounts?.enabled) return null;
  const settings = config.accounts;
  if (Buffer.byteLength(String(config.security.sessionPepper || '')) < 32) throw new Error('Pepper de sessão insuficiente.');
  if (config.environment === 'production' && (!settings.origin.startsWith('https://') || !config.security.cookieSecure)) throw new Error('Portal requer HTTPS e cookie seguro.');
  const transport = settings.emailMode === 'fake'
    ? new FakeEmailTransport({ environment: config.environment })
    : settings.emailMode === 'http' ? new HttpEmailTransport({ endpoint: settings.emailEndpoint, token: settings.emailToken, from: settings.emailFrom }) : null;
  if (!transport) throw new Error('Configure o adaptador de e-mail antes de habilitar contas.');
  const service = new AccountService({ repository: new AccountRepository(pool),
    codec: createSessionTokenCodec({ pepper: `${config.security.sessionPepper}:customer` }),
    keyring: keyringFromSerialized(config.security.masterKeyring),
    limiter: new AccountRateLimiter({ redis, environment: config.environment }),
    origin: settings.origin, companyLimit: settings.companyLimit,
    sessionMs: settings.sessionMs, idleMs: settings.idleMs, verifyMs: settings.verifyMs, resetMs: settings.resetMs });
  return { service, transport };
}
