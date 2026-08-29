import { VersionedKeyring } from "./versioned-keyring.js";

export function keyringFromSerialized(value) {
  let parsed;
  try { parsed = JSON.parse(String(value || "")); }
  catch { throw new Error("MASTER_KEYRING deve ser JSON válido."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MASTER_KEYRING inválido.");
  return VersionedKeyring.fromBase64({ activeVersion: parsed.activeVersion, keys: parsed.keys });
}
