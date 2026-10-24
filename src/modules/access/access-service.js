import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requirePlatformAdmin } from '../admin/authorization.js';
import { CUSTOMER_CAPABILITIES } from '../auth/permissions.js';
import { hashPassword } from '../auth/password.js';
import { encryptCredentialSecret } from '../../security/credential-crypto.js';
import { AccessError, accessDenied } from './errors.js';

export const ACCESS_CAPABILITIES = Object.freeze(CUSTOMER_CAPABILITIES.filter((value) => value.startsWith('attendance.')));
const capabilities = z.array(z.enum(ACCESS_CAPABILITIES)).max(ACCESS_CAPABILITIES.length)
  .refine((values) => new Set(values).size === values.length);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const membership = z.object({ empresaId: z.string().uuid(), status: z.enum(['ativo', 'suspenso']).default('ativo'), capabilities }).strict();
const schemas = {
  create: z.object({ name: z.string().trim().min(2).max(160).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)), email: z.string().trim().toLowerCase().email().max(254),
    companies: z.array(membership).max(100).default([]) }).strict().refine((value) => new Set(value.companies.map((item) => item.empresaId)).size === value.companies.length),
  status: z.object({ status: z.enum(['ativo', 'bloqueado', 'desativado']), expectedVersion: version }).strict(),
  company: z.object({ status: z.enum(['ativo', 'suspenso']), capabilities, expectedVersion: version }).strict(),
  mutation: z.object({ expectedVersion: version }).strict(),
  reset: z.object({ expectedVersion: version, identityConfirmed: z.literal(true) }).strict(),
  query: z.object({ search: z.string().trim().max(160).default(''), page: z.coerce.number().int().min(1).max(100000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25), empresaId: z.string().uuid().optional(),
    status: z.enum(['ativo', 'bloqueado', 'desativado']).optional() }).strict(),
};
const digest = (value) => createHash('sha256').update(value).digest();
const orderedCapabilities = (values) => ACCESS_CAPABILITIES.filter((value) => values.includes(value));

export class AccessService {
  constructor({ repository, keyring, origin, limiter, clock = () => new Date(), activationMs = 86400000, resetMs = 1800000 }) {
    if (new URL(origin).origin !== origin) throw new TypeError('Origem de acesso inválida.');
    for (const duration of [activationMs, resetMs]) if (!Number.isSafeInteger(duration) || duration < 60000
      || !Number.isFinite(new Date(clock().getTime() + duration).getTime())) throw new TypeError('Prazo de acesso inválido.');
    Object.assign(this, { repository, keyring, origin, limiter, clock, activationMs, resetMs });
  }
  #authorize(auth) {
    try { requirePlatformAdmin(auth); } catch { throw accessDenied(); }
  }
  #parse(kind, body) {
    const result = schemas[kind].safeParse(body);
    if (!result.success) throw new AccessError('ACCESS_VALIDATION_ERROR', 422, 'Confira os dados, as capacidades e a versão do acesso.');
    const value = result.data;
    if (value.capabilities) value.capabilities = orderedCapabilities(value.capabilities);
    if (value.companies) value.companies = value.companies.map((item) => ({ ...item, capabilities: orderedCapabilities(item.capabilities) }))
      .sort((left, right) => left.empresaId.localeCompare(right.empresaId));
    return value;
  }
  #id(value) {
    if (!z.string().uuid().safeParse(value).success) throw new AccessError('ACCESS_NOT_FOUND', 404, 'Acesso ou empresa não encontrado.');
    return value.toLowerCase();
  }
  #options(auth, operation, input, key, meta, userId) {
    this.#authorize(auth);
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new AccessError('IDEMPOTENCY_KEY_REQUIRED', 422, 'Reenvie a solicitação com uma chave idempotente válida.');
    const correlationId = z.string().uuid().safeParse(meta?.correlationId).success ? meta.correlationId : randomUUID();
    const targetId = userId ? this.#id(userId) : undefined;
    return { auth, operation, input, key, userId: targetId,
      payloadHash: digest(JSON.stringify({ userId: targetId || null, ...input })).toString('hex'), meta: { correlationId } };
  }
  #material(email, purpose) {
    const rawToken = randomBytes(32).toString('base64url'), id = randomUUID(), now = this.clock();
    const expiresAt = new Date(now.getTime() + (purpose === 'activate' ? this.activationMs : this.resetMs));
    const envelope = encryptCredentialSecret({ keyring: this.keyring,
      secret: JSON.stringify({ to: email, purpose, url: `${this.origin}/portal/#${purpose}=${rawToken}` }),
      binding: { empresaId: 'platform-accounts', credentialId: id, provider: 'email', purpose: 'account-delivery' } });
    return { token: { id: randomUUID(), digest: digest(rawToken), purpose, expiresAt }, mail: { id, envelope, expiresAt } };
  }
  async #rateMail(userId, purpose) {
    if (!this.limiter?.consume) throw new AccessError('ACCESS_UNAVAILABLE', 503, 'Limite de envio temporariamente indisponível.');
    const value = await this.limiter.consume({ key: `admin-access-mail:${purpose}:${userId}`, max: 5 });
    if (!value?.allowed) throw new AccessError('RATE_LIMITED', 429, 'Limite de reenvios atingido. Aguarde antes de tentar novamente.');
  }
  list(auth, query = {}) {
    this.#authorize(auth);
    return this.repository.list({ auth, input: this.#parse('query', query) });
  }
  get(auth, userId) {
    this.#authorize(auth);
    return this.repository.get({ auth, userId: this.#id(userId) });
  }
  async create(auth, body, key, meta) {
    this.#authorize(auth);
    const input = this.#parse('create', body);
    const options = this.#options(auth, 'create', input, key, meta);
    // No usable initial password is returned, logged, persisted in clear or sent.
    const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
    return this.repository.create({ ...options, newUserId: randomUUID(), passwordHash,
      material: this.#material(input.email, 'activate') });
  }
  setStatus(auth, userId, body, key, meta) {
    this.#authorize(auth);
    return this.repository.setStatus(this.#options(auth, 'status', this.#parse('status', body), key, meta, userId));
  }
  putCompany(auth, userId, empresaId, body, key, meta) {
    this.#authorize(auth);
    const input = { ...this.#parse('company', body), empresaId: this.#id(empresaId) };
    return this.repository.putCompany(this.#options(auth, 'company.put', input, key, meta, userId));
  }
  removeCompany(auth, userId, empresaId, body, key, meta) {
    this.#authorize(auth);
    const input = { ...this.#parse('mutation', body), empresaId: this.#id(empresaId) };
    return this.repository.removeCompany(this.#options(auth, 'company.remove', input, key, meta, userId));
  }
  activation(auth, userId, body, key, meta) { return this.#issue(auth, userId, body, key, meta, 'activation'); }
  reset(auth, userId, body, key, meta) { return this.#issue(auth, userId, body, key, meta, 'reset'); }
  #issue(auth, userId, body, key, meta, operation) {
    this.#authorize(auth);
    const input = this.#parse(operation === 'reset' ? 'reset' : 'mutation', body);
    return this.repository.issue({ ...this.#options(auth, operation, input, key, meta, userId),
      materialForEmail: (email) => this.#material(email, operation === 'activation' ? 'activate' : 'reset'),
      rate: () => this.#rateMail(userId, operation) });
  }
  revokeSessions(auth, userId, body, key, meta) {
    this.#authorize(auth);
    return this.repository.revokeSessions(this.#options(auth, 'sessions.revoke', this.#parse('mutation', body), key, meta, userId));
  }
}
