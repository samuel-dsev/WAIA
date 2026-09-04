import { AuthenticationRequiredError, AuthError, InvalidCredentialsError } from "./errors.js";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./password.js";

function requiredMethod(target, method, name) {
  if (typeof target?.[method] !== "function") throw new TypeError(`${name}.${method} é obrigatório.`);
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new InvalidCredentialsError();
  }
  return email;
}

function cleanUserAgent(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 500) || null;
}

function canonicalPlatformRole(value) {
  return value === "platform_admin" || value === "administrador" ? "platform_admin" : null;
}

function canonicalMembership(value) {
  if (!value || value.status === "suspended" || value.status === "suspenso") return null;
  const role = value.role === "tenant_admin" || value.role === "administrador"
    ? "tenant_admin"
    : value.role === "tenant_operator" || value.role === "operador" ? "tenant_operator" : null;
  if (!role || !value.empresaId) return null;
  return Object.freeze({
    empresaId: String(value.empresaId),
    role,
    permissions: Object.freeze(Array.isArray(value.permissions) ? [...new Set(value.permissions.map(String))] : []),
  });
}

function principalFrom(user, memberships, session) {
  return Object.freeze({
    sessionId: session.id,
    user: Object.freeze({ id: user.id, email: user.email, name: user.name }),
    platformRole: canonicalPlatformRole(user.platformRole),
    memberships: Object.freeze((memberships || []).map(canonicalMembership).filter(Boolean)),
    issuedAt: new Date(session.createdAt),
    expiresAt: new Date(session.expiresAt),
  });
}

function auditWriter(value) {
  const write = typeof value === "function" ? value : value?.write?.bind(value) || value?.record?.bind(value);
  if (!write) throw new TypeError("auditWriter é obrigatório.");
  return write;
}

export class AuthService {
  constructor({
    repository,
    tokenCodec,
    rateLimiter,
    audit,
    sessionTtlMs = 12 * 60 * 60 * 1_000,
    dummyPasswordHash = DUMMY_PASSWORD_HASH,
    clock = () => new Date(),
  } = {}) {
    for (const method of [
      "findUserByEmail", "listMemberships", "createSession", "findSessionByTokenHash",
      "revokeSession", "revokeByTokenHash", "touchSession", "findUserById", "changePassword",
    ]) requiredMethod(repository, method, "repository");
    requiredMethod(tokenCodec, "issue", "tokenCodec");
    requiredMethod(tokenCodec, "hash", "tokenCodec");
    requiredMethod(tokenCodec, "verifyCsrf", "tokenCodec");
    requiredMethod(tokenCodec, "fingerprint", "tokenCodec");
    requiredMethod(rateLimiter, "consume", "rateLimiter");
    if (!Number.isInteger(sessionTtlMs) || sessionTtlMs < 60_000) throw new TypeError("sessionTtlMs inválido.");
    this.repository = repository;
    this.tokenCodec = tokenCodec;
    this.rateLimiter = rateLimiter;
    this.writeAudit = auditWriter(audit);
    this.sessionTtlMs = sessionTtlMs;
    this.dummyPasswordHash = dummyPasswordHash;
    this.clock = clock;
  }

  async login({ email: emailInput, password, ip = null, userAgent = null, existingSessionToken = null } = {}) {
    let email;
    try {
      email = normalizeEmail(emailInput);
    } catch (error) {
      await this.#audit("auth.login_failed", {
        result: "denied",
        subjectFingerprint: this.tokenCodec.fingerprint(emailInput),
        ip,
        details: { reason: "invalid_credentials" },
      });
      throw error;
    }
    const rateKey = `${this.tokenCodec.fingerprint(ip)}:${this.tokenCodec.fingerprint(email)}`;
    const rate = await this.rateLimiter.consume({ key: rateKey, now: this.clock() });
    if (!rate?.allowed) {
      await this.#audit("auth.login_rate_limited", {
        result: "denied",
        subjectFingerprint: this.tokenCodec.fingerprint(email),
        ip,
        details: { retryAfterMs: rate?.retryAfterMs || null },
      });
      throw new AuthError("Muitas tentativas de autenticação.", {
        code: "AUTH_RATE_LIMITED",
        status: 429,
        retryAfterMs: rate?.retryAfterMs,
      });
    }

    const user = await this.repository.findUserByEmail(email);
    const passwordValid = await verifyPassword(password, user?.passwordHash || this.dummyPasswordHash);
    if (!user || !passwordValid || user.status !== "active") {
      await this.#audit("auth.login_failed", {
        actorUserId: user?.id || null,
        result: "denied",
        subjectFingerprint: this.tokenCodec.fingerprint(email),
        ip,
        details: { reason: "invalid_credentials" },
      });
      throw new InvalidCredentialsError();
    }

    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    const issued = this.tokenCodec.issue();
    if (existingSessionToken) {
      const oldHash = this.tokenCodec.hash(existingSessionToken);
      if (oldHash) await this.repository.revokeByTokenHash(oldHash, { revokedAt: now, reason: "rotated_on_login" });
    }
    const session = await this.repository.createSession({
      userId: user.id,
      tokenHash: issued.tokenHash,
      ip,
      userAgent: cleanUserAgent(userAgent),
      createdAt: now,
      expiresAt,
    });
    const memberships = await this.repository.listMemberships(user.id);
    const principal = principalFrom(user, memberships, session);
    await this.#audit("auth.login_succeeded", {
      actorUserId: user.id,
      result: "success",
      ip,
      details: { sessionId: session.id },
    });
    return Object.freeze({
      principal,
      credentials: Object.freeze({
        sessionToken: issued.token,
        csrfToken: issued.csrfToken,
        expiresAt,
      }),
    });
  }

  async authenticate(sessionToken) {
    const tokenHash = this.tokenCodec.hash(sessionToken);
    if (!tokenHash) throw new AuthenticationRequiredError();
    const found = await this.repository.findSessionByTokenHash(tokenHash, { now: this.clock() });
    if (!found || found.user?.status !== "active") throw new AuthenticationRequiredError();
    await this.repository.touchSession(found.session.id, { seenAt: this.clock() });
    return principalFrom(found.user, found.memberships, found.session);
  }

  verifyCsrf({ sessionToken, csrfToken }) {
    return this.tokenCodec.verifyCsrf(sessionToken, csrfToken);
  }

  async logout({ sessionId, userId, ip = null } = {}) {
    if (!sessionId || !userId) throw new AuthenticationRequiredError();
    await this.repository.revokeSession(sessionId, { userId, revokedAt: this.clock(), reason: "logout" });
    await this.#audit("auth.logout", {
      actorUserId: userId,
      result: "success",
      ip,
      details: { sessionId },
    });
  }

  async changePassword({ sessionId, userId, currentPassword, newPassword, ip = null } = {}) {
    if (!sessionId || !userId) throw new AuthenticationRequiredError();
    const user = await this.repository.findUserById(userId);
    const currentValid = await verifyPassword(currentPassword, user?.passwordHash || this.dummyPasswordHash);
    if (!user || user.status !== "active" || !currentValid) {
      await this.#audit("auth.password_change_failed", {
        actorUserId: user?.id || userId,
        result: "denied",
        ip,
        details: { reason: "invalid_current_password" },
      });
      throw new InvalidCredentialsError();
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new AuthError("A nova senha deve ser diferente da senha atual.", {
        code: "PASSWORD_REUSE_NOT_ALLOWED",
        status: 422,
      });
    }
    let passwordHash;
    try {
      passwordHash = await hashPassword(newPassword);
    } catch {
      throw new AuthError("A nova senha deve possuir entre 12 e 256 caracteres.", {
        code: "PASSWORD_POLICY_VIOLATION",
        status: 422,
      });
    }
    const changedAt = this.clock();
    await this.repository.changePassword({ userId, passwordHash, keepSessionId: sessionId, changedAt });
    await this.#audit("auth.password_changed", {
      actorUserId: userId,
      result: "success",
      ip,
      details: { sessionId, otherSessionsRevoked: true },
    });
  }

  async #audit(action, event) {
    const safe = {
      action,
      actorUserId: event.actorUserId || null,
      empresaId: event.empresaId || null,
      result: event.result,
      subjectFingerprint: event.subjectFingerprint || null,
      ip: event.ip || null,
      occurredAt: this.clock(),
      details: event.details || {},
    };
    await this.writeAudit(safe);
  }
}

export function publicPrincipal(principal) {
  return Object.freeze({
    user: principal.user,
    platformRole: principal.platformRole,
    memberships: principal.memberships,
    expiresAt: principal.expiresAt,
  });
}

export function authErrorResponse(error) {
  return Object.freeze({
    error: error instanceof AuthError ? error.code : "AUTH_ERROR",
    message: error instanceof AuthError ? error.message : "Falha de autenticação.",
    ...(error?.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
  });
}
