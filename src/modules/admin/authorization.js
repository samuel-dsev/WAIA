import { AdminForbiddenError, AdminUnauthorizedError } from "./errors.js";

const ROLE_ALIASES = Object.freeze({
  administrador: "tenant_admin",
  operador: "tenant_operator",
});

export function normalizedAdminAuth(auth) {
  if (!auth?.user?.id) throw new AdminUnauthorizedError();
  const memberships = Array.isArray(auth.memberships) ? auth.memberships : [];
  return Object.freeze({
    actorId: String(auth.user.id),
    user: Object.freeze({
      id: String(auth.user.id),
      name: auth.user.name == null ? null : String(auth.user.name),
      email: auth.user.email == null ? null : String(auth.user.email),
    }),
    platformRole: auth.platformRole === "platform_admin" ? "platform_admin" : null,
    memberships: Object.freeze(memberships
      .filter((membership) => membership?.empresaId && membership?.role)
      .map((membership) => Object.freeze({
        empresaId: String(membership.empresaId),
        role: ROLE_ALIASES[membership.role] || membership.role,
        permissions: Object.freeze(Array.isArray(membership.permissions) ? membership.permissions.map(String) : []),
      }))),
  });
}

export function isPlatformAdmin(auth) {
  return normalizedAdminAuth(auth).platformRole === "platform_admin";
}

export function requirePlatformAdmin(auth) {
  const normalized = normalizedAdminAuth(auth);
  if (normalized.platformRole !== "platform_admin") throw new AdminForbiddenError();
  return normalized;
}

export function requireTenantAccess(auth, empresaId, { write = false, adminOnly = false, permission } = {}) {
  const normalized = normalizedAdminAuth(auth);
  if (normalized.platformRole === "platform_admin") {
    return { ...normalized, tenant: { empresaId: String(empresaId), role: "platform_admin", permissions: [] } };
  }
  const membership = normalized.memberships.find((item) => item.empresaId === String(empresaId));
  if (!membership) throw new AdminForbiddenError();
  if ((adminOnly || write) && membership.role !== "tenant_admin") {
    if (!permission || !membership.permissions.includes(permission)) throw new AdminForbiddenError();
  }
  return { ...normalized, tenant: membership };
}

