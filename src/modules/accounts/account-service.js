import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from '../auth/password.js';
import { encryptCredentialSecret, decryptCredentialSecret } from '../../security/credential-crypto.js';
import { AccountError, invalidSession } from './errors.js';

const email = z.string().trim().toLowerCase().email().max(254);
const name = z.string().trim().min(2).max(160);
const password = z.string().min(12).max(128).refine((s) => !s.includes('\0') && s.normalize('NFKC').length >= 12 && s.normalize('NFKC').length <= 128);
const schemas = {
  register: z.object({ name, email, password, acceptedTerms: z.literal(true) }).strict(),
  email: z.object({ email }).strict(),
  login: z.object({ email, password: z.string().min(1).max(256) }).strict(),
  verify: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict(),
  reset: z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), password }).strict(),
  change: z.object({ currentPassword: z.string().min(1).max(256), password }).strict(),
  profile: z.object({ name }).strict(),
  company: z.object({ name }).strict(),
};
const digest = (v) => createHash('sha256').update(v).digest();
const neutral = Object.freeze({ message: 'Se os dados permitirem, enviaremos as instruções por e-mail.' });
const binding = (id) => ({ empresaId: 'platform-accounts', credentialId: id, provider: 'email', purpose: 'account-delivery' });

export class AccountService {
  constructor({ repository, codec, keyring, limiter, origin, clock = () => new Date(), companyLimit = 1,
    sessionMs = 12 * 3600_000, idleMs = 3600_000, verifyMs = 24 * 3600_000, resetMs = 30 * 60_000 }) {
    Object.assign(this, { repository, codec, keyring, limiter, origin, clock, companyLimit, sessionMs, idleMs, verifyMs, resetMs });
    if (new URL(origin).origin !== origin || !Number.isInteger(companyLimit) || companyLimit < 1) throw new Error('Configuração de contas inválida.');
    for (const n of [sessionMs, idleMs, verifyMs, resetMs]) if (!Number.isSafeInteger(n) || n < 60_000) throw new Error('Prazo de conta inválido.');
  }
  parse(kind, body) {
    const result = schemas[kind].safeParse(body);
    if (!result.success) throw new AccountError('VALIDATION_ERROR', 422, 'Confira os campos informados. Senhas novas devem ter de 12 a 128 caracteres.');
    return result.data;
  }
  async rate(operation, identity, ip, maximum = 3) {
    for (const [key, max] of [[`global:${operation}`, 300], [`ip:${operation}:${this.codec.fingerprint(ip)}`, 30],
      [`identity:${operation}:${this.codec.fingerprint(identity)}`, maximum]]) {
      const r = await this.limiter.consume({ key, max });
      if (!r.allowed) {
        const e = new AccountError('RATE_LIMITED', 429, 'Muitas tentativas. Aguarde alguns minutos.');
        e.retryAfter = Math.ceil(r.retryAfterMs / 1000); throw e;
      }
    }
  }
  #mail({ email: to, purpose, token }) {
    const id = randomUUID();
    const payload = { to, purpose, ...(token ? { url: `${this.origin}/portal/#${purpose}=${token}` } : {}) };
    return { id, envelope: encryptCredentialSecret({ secret: JSON.stringify(payload), keyring: this.keyring, binding: binding(id) }),
      expiresAt: new Date(this.clock().getTime() + (purpose === 'reset' ? this.resetMs : this.verifyMs)) };
  }
  #token(to, purpose) {
    const token = randomBytes(32).toString('base64url');
    const mail = this.#mail({ email: to, purpose, token });
    return { mail, token: { id: randomUUID(), digest: digest(token), purpose, expiresAt: mail.expiresAt } };
  }
  async #neutral(work) {
    const start = Date.now();
    try { await work(); return neutral; }
    finally { await delay(Math.max(0, 250 - (Date.now() - start))); }
  }
  async register(body, ip) {
    const input = this.parse('register', body);
    await this.rate('register', input.email, ip);
    return this.#neutral(async () => {
      const passwordHash = await hashPassword(input.password);
      await this.repository.register({ ...input, userId: randomUUID(), passwordHash, ...this.#token(input.email, 'verify') });
    });
  }
  async requestToken(body, purpose, ip) {
    const input = this.parse('email', body);
    await this.rate(purpose, input.email, ip);
    return this.#neutral(async () => {
      const u = await this.repository.findCredentials(input.email);
      const material = this.#token(input.email, purpose);
      if (u) await this.repository.requestToken({ userId: u.id, ...material });
    });
  }
  async verify(body, ip) {
    const { token } = this.parse('verify', body);
    await this.rate('token', token, ip, 5);
    await this.repository.consumeToken({ digest: digest(token), purpose: 'verify', now: this.clock() });
  }
  async reset(body, ip) {
    const { token, password: value } = this.parse('reset', body);
    await this.rate('token', token, ip, 5);
    await this.repository.consumeToken({ digest: digest(token), purpose: 'reset', passwordHash: await hashPassword(value),
      now: this.clock(), mail: (u) => this.#mail({ email: u.email, purpose: 'password_changed' }) });
  }
  async login(body, ip, oldToken) {
    const input = this.parse('login', body);
    await this.rate('login', `${ip}:${input.email}`, ip, 5);
    const u = await this.repository.findCredentials(input.email);
    const valid = await verifyPassword(input.password, u?.password_hash || DUMMY_PASSWORD_HASH);
    if (!u || !valid || u.status !== 'ativo') throw new AccountError('INVALID_CREDENTIALS', 401, 'E-mail ou senha inválidos.');
    // MFA sera entregue na F2; nunca permitir bypass em conta ja protegida.
    if (u.mfa_habilitado) throw new AccountError('MFA_REQUIRED', 403, 'Esta conta requer autenticação adicional. Procure o suporte.');
    const issued = this.codec.issue();
    const user = await this.repository.login({ userId: u.id, passwordHash: u.password_hash, tokenHash: issued.tokenHash,
      oldHash: this.codec.hash(oldToken), now: this.clock(), expiresAt: new Date(this.clock().getTime() + this.sessionMs) });
    return { user, token: issued.token, csrfToken: issued.csrfToken };
  }
  authenticate(token) {
    const tokenHash = this.codec.hash(token);
    if (!tokenHash) throw invalidSession();
    return this.repository.authenticate({ tokenHash, now: this.clock(), idleMs: this.idleMs });
  }
  logout(auth) { return this.repository.logout({ userId: auth.user.id, sessionId: auth.sessionId, now: this.clock() }); }
  profile(auth, body) { return this.repository.updateProfile({ userId: auth.user.id, ...this.parse('profile', body) }); }
  async changePassword(auth, body) {
    const input = this.parse('change', body);
    const u = await this.repository.findCredentials(auth.user.email);
    if (!u || u.id !== auth.user.id || !await verifyPassword(input.currentPassword, u.password_hash)) throw invalidSession();
    await this.repository.changePassword({ userId: u.id, previousHash: u.password_hash, passwordHash: await hashPassword(input.password),
      mail: this.#mail({ email: u.email, purpose: 'password_changed' }), now: this.clock() });
  }
  companies(auth) { return this.repository.listCompanies(auth.user.id); }
  async company(auth, id) {
    if (!z.string().uuid().safeParse(id).success) throw new AccountError('COMPANY_NOT_FOUND', 404, 'Empresa não encontrada.');
    const found = (await this.companies(auth)).find((c) => c.id === id);
    if (!found) throw new AccountError('COMPANY_NOT_FOUND', 404, 'Empresa não encontrada.');
    return found;
  }
  createCompany(auth, body, key) {
    const input = this.parse('company', body);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new AccountError('IDEMPOTENCY_KEY_REQUIRED', 422, 'Reenvie a solicitação com uma chave válida.');
    return this.repository.createCompany({ userId: auth.user.id, ...input, key, payloadHash: digest(JSON.stringify(input)).toString('hex'),
      limit: this.companyLimit, now: this.clock() });
  }
  async deliverNext(transport) {
    const mail = await this.repository.claimMail(this.clock());
    if (!mail) return false;
    let success = false;
    try {
      const message = JSON.parse(decryptCredentialSecret({ envelope: mail.envelope, keyring: this.keyring, binding: binding(mail.id) }));
      await transport.send({ ...message, idempotencyKey: mail.id });
      success = true;
    } catch { /* Somente estado; nunca registrar resposta externa ou link secreto. */ }
    await this.repository.finishMail({ id: mail.id, lease: mail.lease_id, attempts: mail.attempts, success, now: this.clock() });
    return true;
  }
}
