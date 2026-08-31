import test from "node:test";
import assert from "node:assert/strict";
import { PostgresAuthRepository } from "../src/modules/auth/repositories.js";

test("reconstrói o id do usuário autenticado a partir da sessão PostgreSQL", async () => {
  const userId = "00000000-0000-4000-8000-000000000001";
  const sessionId = "00000000-0000-4000-8000-000000000002";
  const now = new Date("2026-08-31T12:00:00.000Z");
  const client = {
    async query(sql) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("set_config(")) return { rows: [] };
      if (sql.includes("FROM auth_sessions")) {
        return {
          rows: [{
            id: sessionId,
            usuario_id: userId,
            token_hash: Buffer.from("hash"),
            created_at: now,
            expires_at: new Date(now.getTime() + 60_000),
            last_seen_at: now,
            revoked_at: null,
            user_id_value: userId,
            email: "admin@example.invalid",
            nome: "Admin",
            password_hash: "hash-sintetico",
            papel_plataforma: "administrador",
            user_status: "ativo",
          }],
        };
      }
      if (sql.includes("FROM usuarios_empresas")) return { rows: [] };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
    release() {},
  };
  const repository = new PostgresAuthRepository({ async connect() { return client; } });

  const found = await repository.findSessionByTokenHash(Buffer.from("hash"), { now });

  assert.equal(found.user.id, userId);
  assert.equal(found.user.status, "active");
  assert.equal(found.session.id, sessionId);
});
