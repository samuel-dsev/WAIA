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

export const CUSTOMER_CAPABILITIES = Object.freeze([
  'attendance.read', 'attendance.edit', 'attendance.simulate', 'attendance.publish',
  'conversations.read', 'conversations.reply', 'conversations.pause', 'leads.read',
]);
const coreCapabilities = new Set(CUSTOMER_CAPABILITIES.filter((value) => value.startsWith('attendance.')));
const active = (status) => ['ativo', 'active'].includes(status);
const suspended = (status) => ['suspenso', 'suspended'].includes(status);
const operationalCapabilities = new Set(['attendance.simulate', 'attendance.publish', 'conversations.reply', 'conversations.pause']);
const canonicalRole = (role) => ({ administrador: 'tenant_admin', operador: 'tenant_operator' }[role] || role);

export function effectiveCustomerCapabilities(membership) {
  if (!membership || !active(membership.status)) return [];
  if (['arquivada', 'archived'].includes(membership.companyStatus)) return [];
  const granted = new Set(Array.isArray(membership.permissions) ? membership.permissions : []);
  const enabled = new Set(Array.isArray(membership.enabledCapabilities) ? membership.enabledCapabilities : []);
  return CUSTOMER_CAPABILITIES.filter((capability) => granted.has(capability)
    && (coreCapabilities.has(capability) || enabled.has(capability))
    && (!operationalCapabilities.has(capability) || ['ativo', 'ativa', 'active'].includes(membership.companyStatus)));
}

export function membershipFor(principal, empresaId) {
  return principal?.memberships?.find((membership) => membership.empresaId === empresaId
    && (principal.audience === 'customer' ? active(membership.status) : !suspended(membership.status))) || null;
}

export function evaluateAccess(principal, operation, empresaId, { legacy } = {}) {
  // Customer is evaluated first: global role, ownership and legacy flags grant nothing.
  if (principal?.audience === 'customer') {
    if (principal.user?.status && !active(principal.user.status)) return false;
    return effectiveCustomerCapabilities(membershipFor(principal, empresaId)).includes(operation);
  }
  if (principal?.platformRole === 'platform_admin' && principal.audience === 'admin') return true;
  const membership = membershipFor(principal, empresaId);
  const role = canonicalRole(membership?.role);
  if (!membership || !['tenant_admin', 'tenant_operator'].includes(role)) return false;
  if (legacy) return !(legacy.adminOnly || legacy.write) || role === 'tenant_admin'
    || Boolean(legacy.permission && membership.permissions?.includes(legacy.permission));
  return (ROLE_PERMISSIONS[role] || []).includes(operation);
}

export function permissionsFor(principal, empresaId) {
  if (principal?.audience === 'customer') {
    if (principal.user?.status && !active(principal.user.status)) return [];
    return effectiveCustomerCapabilities(membershipFor(principal, empresaId));
  }
  if (principal?.platformRole === 'platform_admin' && principal.audience === 'admin') return ROLE_PERMISSIONS.platform_admin;
  const membership = membershipFor(principal, empresaId);
  return membership ? ROLE_PERMISSIONS[canonicalRole(membership.role)] || [] : [];
}

export function hasPermission(principal, permission, empresaId) {
  return evaluateAccess(principal, permission, empresaId);
}

export function requirePermission(principal, permission, empresaId) {
  if (!hasPermission(principal, permission, empresaId)) throw new AuthorizationDeniedError();
  return membershipFor(principal, empresaId);
}

export function requireCustomerAccess(principal, capability, empresaId) {
  if (principal?.audience !== 'customer' || !evaluateAccess(principal, capability, empresaId)) {
    throw new AuthorizationDeniedError();
  }
  return membershipFor(principal, empresaId);
}
