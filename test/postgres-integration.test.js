import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PrivateMediaStore } from "../src/infra/media/private-media-store.js";
import { PostgresJobHandlerRepository } from "../src/modules/jobs/handlers.js";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

test("papel da aplicação não possui DDL e respeita o tenant definido na transação", { skip: !enabled }, async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL é obrigatória no teste de privilégios");
  assert.ok(process.env.DATABASE_MIGRATOR_URL, "DATABASE_MIGRATOR_URL é obrigatória no teste de privilégios");
  assert.notEqual(process.env.DATABASE_URL, process.env.DATABASE_MIGRATOR_URL);

  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const migratorPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await migratorPool.connect();
  const suffix = randomUUID();
  let tenantA;
  let tenantB;

  try {
    const roles = await appPool.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
              has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema_object,
              has_database_privilege(current_user, current_database(), 'TEMP') AS can_create_temp
         FROM pg_roles
        WHERE rolname = current_user`,
    );
    assert.deepEqual(roles.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolbypassrls: false,
      can_create_schema_object: false,
      can_create_temp: false,
    });
    await assert.rejects(
      appPool.query(`CREATE TABLE privilege_escape_${suffix.replaceAll("-", "_")} (id integer)`),
      (error) => error?.code === "42501",
    );
    await assert.rejects(
      appPool.query("ALTER TABLE empresas ADD COLUMN privilege_escape boolean"),
      (error) => error?.code === "42501",
    );

    await owner.query("BEGIN");
    const tenants = await owner.query(
      `INSERT INTO empresas (slug, nome, nome_exibicao, status)
       VALUES ($1, 'Tenant A', 'Tenant A', 'ativa'),
              ($2, 'Tenant B', 'Tenant B', 'ativa')
       RETURNING id, slug`,
      [`priv-a-${suffix}`, `priv-b-${suffix}`],
    );
    tenantA = tenants.rows.find((row) => row.slug.startsWith("priv-a-")).id;
    tenantB = tenants.rows.find((row) => row.slug.startsWith("priv-b-")).id;
    await owner.query(
      `INSERT INTO contatos (empresa_id, telefone_normalizado)
       VALUES ($1, '5511000000001'), ($2, '5511000000002')`,
      [tenantA, tenantB],
    );
    await owner.query("COMMIT");

    const app = await appPool.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.empresa_id', $1, true)", [tenantA]);
      const visible = await app.query("SELECT empresa_id FROM contatos ORDER BY empresa_id");
      assert.deepEqual(visible.rows, [{ empresa_id: tenantA }]);
      await assert.rejects(
        app.query(
          "INSERT INTO contatos (empresa_id, telefone_normalizado) VALUES ($1, '5511000000003')",
          [tenantB],
        ),
        (error) => error?.code === "42501",
      );
      await app.query("ROLLBACK");
    } finally {
      app.release();
    }
  } finally {
    await owner.query("ROLLBACK").catch(() => {});
    if (tenantA || tenantB) {
      await owner.query("DELETE FROM empresas WHERE id = ANY($1::uuid[])", [[tenantA, tenantB].filter(Boolean)]).catch(() => {});
    }
    owner.release();
    await appPool.end();
    await migratorPool.end();
  }
});

test("PostgreSQL reserva e libera a capacidade real de um horário", { skip: !enabled }, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const suffix = randomUUID();

  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");

    const empresa = await client.query(
      `INSERT INTO empresas (slug, nome, nome_exibicao, status)
       VALUES ($1, 'Empresa de integração', 'Empresa de integração', 'ativa')
       RETURNING id`,
      [`integration-${suffix}`],
    );
    const empresaId = empresa.rows[0].id;
    const contato = await client.query(
      `INSERT INTO contatos (empresa_id, telefone_normalizado)
       VALUES ($1, $2)
       RETURNING id`,
      [empresaId, `55${suffix.replaceAll("-", "").slice(0, 11).replace(/[^1-9]/gu, "7")}`],
    );
    const servico = await client.query(
      `INSERT INTO produtos_servicos (empresa_id, tipo, nome, preco)
       VALUES ($1, 'servico', 'Consulta de integração', 100)
       RETURNING id`,
      [empresaId],
    );
    const disponibilidade = await client.query(
      `INSERT INTO disponibilidades_servico
         (empresa_id, produto_servico_id, inicio_at, fim_at, capacidade)
       VALUES ($1, $2, now() + interval '1 day', now() + interval '1 day 1 hour', 1)
       RETURNING id, inicio_at, fim_at`,
      [empresaId, servico.rows[0].id],
    );
    const slot = disponibilidade.rows[0];

    const appointmentValues = [
      empresaId,
      contato.rows[0].id,
      servico.rows[0].id,
      slot.id,
      slot.inicio_at,
      slot.fim_at,
      randomUUID(),
    ];
    await client.query(
      `INSERT INTO agendamentos
         (empresa_id, contato_id, produto_servico_id, disponibilidade_id,
          inicio_at, fim_at, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      appointmentValues,
    );
    const reserved = await client.query(
      "SELECT reservados FROM disponibilidades_servico WHERE empresa_id = $1 AND id = $2",
      [empresaId, slot.id],
    );
    assert.equal(reserved.rows[0].reservados, 1);

    await client.query("SAVEPOINT capacity_check");
    await assert.rejects(
      client.query(
        `INSERT INTO agendamentos
           (empresa_id, contato_id, produto_servico_id, disponibilidade_id,
            inicio_at, fim_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [...appointmentValues.slice(0, 6), randomUUID()],
      ),
      (error) => error?.code === "23514",
    );
    await client.query("ROLLBACK TO SAVEPOINT capacity_check");

    await client.query(
      `UPDATE agendamentos
          SET status = 'cancelado'
        WHERE empresa_id = $1 AND disponibilidade_id = $2`,
      [empresaId, slot.id],
    );
    const released = await client.query(
      "SELECT reservados FROM disponibilidades_servico WHERE empresa_id = $1 AND id = $2",
      [empresaId, slot.id],
    );
    assert.equal(released.rows[0].reservados, 0);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    await pool.end();
  }
});

test("PostgreSQL persiste metadados verificáveis da mídia privada", { skip: !enabled }, async () => {
  assert.ok(process.env.MEDIA_STORAGE_ROOT, "MEDIA_STORAGE_ROOT é obrigatória no teste de mídia");
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();
  const correlationId = randomUUID();
  const store = new PrivateMediaStore({ root: process.env.MEDIA_STORAGE_ROOT, maxBytes: 1024 });
  let empresaId;
  let messageId;
  let storageKey;
  try {
    await owner.query("BEGIN");
    empresaId = (await owner.query(
      "INSERT INTO empresas (slug, nome, nome_exibicao, status) VALUES ($1, 'Mídia integração', 'Mídia integração', 'ativa') RETURNING id",
      [`media-${suffix}`],
    )).rows[0].id;
    const numberId = (await owner.query(
      "INSERT INTO numeros_whatsapp (empresa_id, phone_number_id, status) VALUES ($1, $2, 'ativo') RETURNING id",
      [empresaId, `phone-${suffix}`],
    )).rows[0].id;
    const contactId = (await owner.query(
      "INSERT INTO contatos (empresa_id, telefone_normalizado) VALUES ($1, $2) RETURNING id",
      [empresaId, `55${suffix.replaceAll("-", "").replace(/[^0-9]/gu, "7").slice(0, 11)}`],
    )).rows[0].id;
    const conversationId = (await owner.query(
      "INSERT INTO conversas (empresa_id, contato_id, numero_whatsapp_id, correlation_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [empresaId, contactId, numberId, correlationId],
    )).rows[0].id;
    messageId = (await owner.query(
      `INSERT INTO mensagens (empresa_id, conversa_id, contato_id, numero_whatsapp_id, direcao, tipo,
         media_external_id, external_message_id, status, sequence, correlation_id)
       VALUES ($1,$2,$3,$4,'entrada','imagem',$5,$6,'enfileirada',1,$7) RETURNING id`,
      [empresaId, conversationId, contactId, numberId, `media-${suffix}`, `wamid-${suffix}`, correlationId],
    )).rows[0].id;
    await owner.query("COMMIT");

    const stored = await store.put({ empresaId, messageId, data: Buffer.from("receipt"), mimeType: "image/jpeg" });
    storageKey = stored.storageKey;
    await new PostgresJobHandlerRepository(appPool).markMediaStored({
      empresaId, messageId, mediaId: `media-${suffix}`, stored,
    });
    const app = await appPool.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.empresa_id', $1, true)", [empresaId]);
      const row = (await app.query(
        "SELECT media_storage_key, media_mime_type, media_size_bytes::int, media_sha256 FROM mensagens WHERE empresa_id = $1 AND id = $2",
        [empresaId, messageId],
      )).rows[0];
      assert.deepEqual(row, {
        media_storage_key: stored.storageKey,
        media_mime_type: "image/jpeg",
        media_size_bytes: 7,
        media_sha256: stored.sha256,
      });
      assert.deepEqual(await store.read({ empresaId, storageKey, expectedSha256: stored.sha256 }), Buffer.from("receipt"));
      await app.query("ROLLBACK");
    } finally {
      app.release();
    }
  } finally {
    await owner.query("ROLLBACK").catch(() => {});
    if (empresaId) {
      await owner.query("DELETE FROM mensagens WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM conversas WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM contatos WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM numeros_whatsapp WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM empresas WHERE id = $1", [empresaId]).catch(() => {});
    }
    if (storageKey) await store.delete({ empresaId, storageKey }).catch(() => {});
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});
