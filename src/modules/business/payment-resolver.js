import { withTenantTransaction } from "../../infra/postgres/transaction.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function credentialId(reference) {
  const value = String(reference || "").trim();
  if (!value.startsWith("credential:")) return null;
  const id = value.slice("credential:".length);
  return UUID_PATTERN.test(id) ? id : null;
}

function publicText(value, fallback, max = 300) {
  const text = String(value || "").trim();
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/u.test(text) ? text : fallback;
}

/**
 * Resolve o binding operacional de pagamento sem colocar o valor protegido na
 * revisão publicada. Tenants versionados informam uma referência exata ao
 * cofre; o caminho por tabela permanece apenas para o runtime legado.
 */
export class PostgresPaymentResolver {
  constructor(pool, { credentialVault } = {}) {
    this.pool = pool;
    this.credentialVault = credentialVault;
  }

  async #resolveVersioned({ empresaId, reference, recipient, instructions }) {
    const id = credentialId(reference);
    if (!id || !this.credentialVault) return null;
    const metadata = await this.credentialVault.getCredentialMetadata({ empresaId, credentialId: id });
    if (metadata?.empresaId !== empresaId || metadata?.provider !== "payment"
        || metadata?.status !== "active" || metadata?.configured !== true) return null;
    let value = await this.credentialVault.getCredentialForUse({ empresaId, credentialId: id });
    try {
      return {
        value,
        recipient: publicText(recipient, "Empresa configurada"),
        instructions: publicText(
          instructions,
          "Use somente a chave informada neste atendimento e aguarde a conferência da equipe.",
          1_000,
        ),
      };
    } finally {
      value = null;
    }
  }

  async #resolveLegacy({ empresaId, type }) {
    const row = await withTenantTransaction(this.pool, { empresaId }, async ({ client }) => {
      const result = await client.query(
        `SELECT tipo, nome, identificador_mascarado, favorecido, instrucoes, credencial_id
           FROM formas_pagamento
          WHERE empresa_id = $1 AND tipo = $2 AND ativa AND deleted_at IS NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [empresaId, type],
      );
      return result.rows[0] || null;
    });
    if (!row) return null;
    const value = row.credencial_id && this.credentialVault
      ? await this.credentialVault.getCredentialForUse({ empresaId, credentialId: row.credencial_id })
      : row.identificador_mascarado || row.nome;
    return { value, recipient: row.favorecido || row.nome, instructions: row.instrucoes || "" };
  }

  resolve({ empresaId, type, credentialRef = null, recipient = null, instructions = null }) {
    return credentialRef
      ? this.#resolveVersioned({ empresaId, reference: credentialRef, recipient, instructions })
      : this.#resolveLegacy({ empresaId, type });
  }
}
