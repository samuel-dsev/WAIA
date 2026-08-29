import { AuthorizationDeniedError } from "./errors.js";

export const AUTH_ROLES = Object.freeze(["platform_admin", "tenant_admin", "tenant_operator"]);

export const ROLE_PERMISSIONS = Object.freeze({
  platform_admin: Object.freeze(["*"]),
  tenant_admin: Object.freeze([
    "tenant.read", "tenant.update", "users.read", "users.manage", "numbers.read", "numbers.manage",
    "credentials.read_masked", "credentials.manage", "modules.read", "modules.manage", "catalog.read",
    "catalog.manage", "events.read", "events.manage", "contacts.read", "contacts.update",
    "conversations.read", "conversations.update", "orders.read", "orders.update", "appointments.read",
    "appointments.update", "logs.read", "usage.read", "integrations.read", "integrations.manage", "exports.create",
  ]),
  tenant_operator: Object.freeze([
    "contacts.read", "contacts.update", "conversations.read", "conversations.update",
    "orders.read", "orders.update", "appointments.read", "appointments.update",
  ]),
});

function permissionMatches(granted, requested) {
  return granted === requested;
}

export function membershipFor(principal, empresaId) {
  return principal?.memberships?.find((membership) => membership.empresaId === empresaId) || null;
}

export function permissionsFor(principal, empresaId) {
  if (principal?.platformRole === "platform_admin") return ROLE_PERMISSIONS.platform_admin;
  const membership = membershipFor(principal, empresaId);
  if (!membership) return [];
  return ROLE_PERMISSIONS[membership.role] || [];
}

export function hasPermission(principal, permission, empresaId) {
  if (principal?.platformRole === "platform_admin") return true;
  if (!AUTH_ROLES.includes(principal?.platformRole) && principal?.platformRole != null) return false;
  return permissionsFor(principal, empresaId).some((granted) => permissionMatches(granted, permission));
}

export function requirePermission(principal, permission, empresaId) {
  if (!hasPermission(principal, permission, empresaId)) throw new AuthorizationDeniedError();
  return membershipFor(principal, empresaId);
}
