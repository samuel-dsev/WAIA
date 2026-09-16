import { TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION } from "./action-catalog.js";
import { configurationChecksum, stableJson } from "./stable-json.js";
import { ConfigurationValidationError, parseTenantRuntimeConfigV2 } from "./tenant-runtime-config-v2.js";

export const TENANT_RUNTIME_CONFIG_V2_COMPILER_VERSION = 1;
const CHECKSUM_DOMAIN = "WAIA:TENANT_RUNTIME_CONFIG_V2";

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function envelopeError(code, path, message) {
  throw new ConfigurationValidationError(Object.freeze({ code, path, severity: "error", message }));
}

function envelopeId(value, path) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/u.test(value)) {
    envelopeError("INVALID_ID", path, "O identificador do envelope é inválido.");
  }
  return value;
}

function envelopeVersion(value, path) {
  if (!Number.isSafeInteger(value) || value < 1) envelopeError("INVALID_INTEGER", path, "A versão do envelope deve ser um inteiro positivo.");
  return value;
}

function checksumInput({ empresaId, configVersion, draftVersion, configuration }) {
  return {
    domain: CHECKSUM_DOMAIN,
    compilerVersion: TENANT_RUNTIME_CONFIG_V2_COMPILER_VERSION,
    empresaId,
    configVersion,
    ...(draftVersion === undefined ? {} : { draftVersion }),
    configuration,
  };
}

export function compileTenantRuntimeConfigV2(draft, { empresaId, configVersion, draftVersion } = {}) {
  const tenantId = envelopeId(empresaId, "/empresaId");
  const revision = envelopeVersion(configVersion, "/configVersion");
  const optimisticVersion = draftVersion == null ? undefined : envelopeVersion(draftVersion, "/draftVersion");
  const configuration = parseTenantRuntimeConfigV2(draft);
  const checksum = configurationChecksum(checksumInput({
    empresaId: tenantId,
    configVersion: revision,
    draftVersion: optimisticVersion,
    configuration,
  }));
  return deepFreeze({
    kind: "TenantRuntimeConfigV2",
    schemaVersion: TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION,
    compilerVersion: TENANT_RUNTIME_CONFIG_V2_COMPILER_VERSION,
    empresaId: tenantId,
    configVersion: revision,
    ...(optimisticVersion === undefined ? {} : { draftVersion: optimisticVersion }),
    checksumAlgorithm: "sha256",
    checksum,
    configuration,
  });
}

export function verifyCompiledTenantRuntimeConfigV2(compiled) {
  if (!compiled || typeof compiled !== "object" || Array.isArray(compiled)) return false;
  try {
    stableJson(compiled);
  } catch {
    return false;
  }
  const allowedEnvelopeKeys = new Set([
    "kind", "schemaVersion", "compilerVersion", "empresaId", "configVersion", "draftVersion",
    "checksumAlgorithm", "checksum", "configuration",
  ]);
  if (Object.keys(compiled).some((key) => !allowedEnvelopeKeys.has(key))) return false;
  if (compiled.kind !== "TenantRuntimeConfigV2") return false;
  if (compiled.schemaVersion !== TENANT_RUNTIME_CONFIG_V2_SCHEMA_VERSION) return false;
  if (compiled.compilerVersion !== TENANT_RUNTIME_CONFIG_V2_COMPILER_VERSION) return false;
  if (compiled.checksumAlgorithm !== "sha256" || !/^[a-f0-9]{64}$/u.test(String(compiled.checksum || ""))) return false;
  try {
    const parsed = parseTenantRuntimeConfigV2(compiled.configuration);
    envelopeId(compiled.empresaId, "/empresaId");
    envelopeVersion(compiled.configVersion, "/configVersion");
    if (compiled.draftVersion != null) envelopeVersion(compiled.draftVersion, "/draftVersion");
    if (stableJson(parsed) !== stableJson(compiled.configuration)) return false;
    return configurationChecksum(checksumInput({
      empresaId: compiled.empresaId,
      configVersion: compiled.configVersion,
      draftVersion: compiled.draftVersion,
      configuration: parsed,
    })) === compiled.checksum;
  } catch {
    return false;
  }
}
