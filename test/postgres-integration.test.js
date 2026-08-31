import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PrivateMediaStore } from "../src/infra/media/private-media-store.js";
import { AdminService, PostgresAdminRepository } from "../src/modules/admin/index.js";
import { PostgresJobHandlerRepository, createWorkerHandlers } from "../src/modules/jobs/handlers.js";
import { PostgresJobRepository } from "../src/modules/jobs/postgres-repository.js";
import { PostgresGoogleSheetsSnapshotMapper } from "../src/integrations/google-sheets/postgres-adapters.js";

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

test("PostgreSQL enfileira e conclui resposta humana idempotente e auditada", { skip: !enabled }, async () => {
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();
  const idempotencyKey = randomUUID();
  const correlationId = randomUUID();
  let empresaId;
  let operatorId;
  try {
    await owner.query("BEGIN");
    empresaId = (await owner.query(
      "INSERT INTO empresas (slug, nome, nome_exibicao, status) VALUES ($1, 'Humano integração', 'Humano integração', 'ativa') RETURNING id",
      [`human-${suffix}`],
    )).rows[0].id;
    operatorId = (await owner.query(
      "INSERT INTO usuarios (email, nome, password_hash) VALUES ($1, 'Operador integração', 'synthetic-hash') RETURNING id",
      [`operator-${suffix}@example.invalid`],
    )).rows[0].id;
    await owner.query(
      "INSERT INTO usuarios_empresas (empresa_id, usuario_id, papel, status) VALUES ($1,$2,'operador','ativo')",
      [empresaId, operatorId],
    );
    const numberId = (await owner.query(
      "INSERT INTO numeros_whatsapp (empresa_id, phone_number_id, status) VALUES ($1,$2,'ativo') RETURNING id",
      [empresaId, `human-phone-${suffix}`],
    )).rows[0].id;
    const contactId = (await owner.query(
      "INSERT INTO contatos (empresa_id, telefone_normalizado) VALUES ($1,$2) RETURNING id",
      [empresaId, `55${suffix.replaceAll("-", "").replace(/[^0-9]/gu, "7").slice(0, 11)}`],
    )).rows[0].id;
    const conversationId = (await owner.query(
      `INSERT INTO conversas (
         empresa_id, contato_id, numero_whatsapp_id, modo_atendimento, operador_usuario_id, correlation_id
       ) VALUES ($1,$2,$3,'humano',$4,$5) RETURNING id`,
      [empresaId, contactId, numberId, operatorId, correlationId],
    )).rows[0].id;
    await owner.query("COMMIT");

    const service = new AdminService({ repository: new PostgresAdminRepository(appPool) });
    const auth = {
      user: { id: operatorId },
      memberships: [{ empresaId, role: "tenant_operator", permissions: [] }],
    };
    const input = {
      auth,
      empresaId,
      conversationId,
      body: { text: "Resposta humana sintética", idempotencyKey },
      correlationId,
    };
    const first = await service.sendHumanMessage(input);
    const duplicate = await service.sendHumanMessage(input);
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.duplicate, true);

    const persisted = (await owner.query(
      `SELECT m.id, m.status, m.origem_resposta, m.operador_usuario_id,
              count(o.id)::int AS jobs,
              min(o.job_type) AS job_type,
              min(o.payload::text) AS payload
         FROM mensagens m
         JOIN outbox_jobs o ON o.empresa_id = m.empresa_id AND o.mensagem_id = m.id
        WHERE m.empresa_id = $1 AND m.client_idempotency_key = $2
        GROUP BY m.id`,
      [empresaId, idempotencyKey],
    )).rows[0];
    assert.equal(persisted.status, "enfileirada");
    assert.equal(persisted.origem_resposta, "operador");
    assert.equal(persisted.operador_usuario_id, operatorId);
    assert.equal(persisted.jobs, 1);
    assert.equal(persisted.job_type, "send_human_message");
    assert.deepEqual(JSON.parse(persisted.payload), { payloadVersion: 1 });

    const job = (await owner.query(
      `UPDATE outbox_jobs SET status = 'publicado', published_at = now()
        WHERE empresa_id = $1 AND mensagem_id = $2
      RETURNING id, conversa_id, mensagem_id, job_type, correlation_id`,
      [empresaId, first.id],
    )).rows[0];
    const reference = {
      jobId: job.id,
      empresaId,
      conversationId: job.conversa_id,
      messageId: job.mensagem_id,
      statusEventId: null,
      type: job.job_type,
      correlationId: job.correlation_id,
      payloadVersion: 1,
    };
    assert.equal((await new PostgresJobRepository(appPool).claim(reference)).outcome, "claimed");
    const handlers = createWorkerHandlers({
      repository: new PostgresJobHandlerRepository(appPool),
      conversationService: { async getConversation() {}, async recordMessage() {}, async applyMetaStatus() {} },
      tenantDefinitionRepository: { async load() {} },
      metaGateway: { async sendReply(context, payload) {
        assert.deepEqual(context, { empresaId, numeroWhatsappId: numberId });
        assert.equal(payload.text, "Resposta humana sintética");
        return { messages: [{ id: `wamid-human-${suffix}` }] };
      } },
    });
    const result = await handlers.send_human_message(reference);
    await new PostgresJobRepository(appPool).complete(reference, { result });

    const completed = (await owner.query(
      `SELECT m.status, m.external_message_id, o.status AS job_status,
              (SELECT count(*)::int FROM logs_auditoria a
                WHERE a.empresa_id = $1 AND a.acao = 'conversation.message.send'
                  AND a.recurso_id = m.id::text) AS audits
         FROM mensagens m
         JOIN outbox_jobs o ON o.empresa_id = m.empresa_id AND o.mensagem_id = m.id
        WHERE m.empresa_id = $1 AND m.id = $2`,
      [empresaId, first.id],
    )).rows[0];
    assert.equal(completed.status, "enviada");
    assert.equal(completed.external_message_id, `wamid-human-${suffix}`);
    assert.equal(completed.job_status, "concluido");
    assert.equal(completed.audits, 2);

    const failedMessage = await service.sendHumanMessage({
      ...input,
      body: { text: "Resposta que exercita retry", idempotencyKey: randomUUID() },
      correlationId: randomUUID(),
    });
    const failedJob = (await owner.query(
      `UPDATE outbox_jobs SET status = 'publicado', published_at = now()
        WHERE empresa_id = $1 AND mensagem_id = $2
      RETURNING id, conversa_id, mensagem_id, job_type, correlation_id`,
      [empresaId, failedMessage.id],
    )).rows[0];
    const failedReference = {
      jobId: failedJob.id,
      empresaId,
      conversationId: failedJob.conversa_id,
      messageId: failedJob.mensagem_id,
      statusEventId: null,
      type: failedJob.job_type,
      correlationId: failedJob.correlation_id,
      payloadVersion: 1,
    };
    const jobRepository = new PostgresJobRepository(appPool);
    assert.equal((await jobRepository.claim(failedReference, { attempt: 1 })).outcome, "claimed");
    await jobRepository.retry(failedReference, { attempt: 1, error: { code: "META_TIMEOUT", message: "Falha temporária." } });
    assert.equal((await owner.query(
      "SELECT status FROM mensagens WHERE empresa_id = $1 AND id = $2",
      [empresaId, failedMessage.id],
    )).rows[0].status, "enfileirada");
    assert.equal((await jobRepository.claim(failedReference, { attempt: 2 })).outcome, "claimed");
    await jobRepository.fail(failedReference, {
      attempt: 2,
      maxAttempts: 2,
      error: { code: "META_REQUEST_FAILED", message: "Falha permanente." },
    });
    const failedState = (await owner.query(
      `SELECT m.status, o.status AS job_status,
              (SELECT count(*)::int FROM jobs_falhos f
                WHERE f.empresa_id = $1 AND f.mensagem_id = m.id) AS dead_letters
         FROM mensagens m
         JOIN outbox_jobs o ON o.empresa_id = m.empresa_id AND o.mensagem_id = m.id
        WHERE m.empresa_id = $1 AND m.id = $2`,
      [empresaId, failedMessage.id],
    )).rows[0];
    assert.deepEqual(failedState, { status: "falhou", job_status: "falhou", dead_letters: 1 });

    await owner.query(
      "UPDATE usuarios_empresas SET papel = 'administrador' WHERE empresa_id = $1 AND usuario_id = $2",
      [empresaId, operatorId],
    );
    const adminAuth = {
      user: { id: operatorId },
      memberships: [{ empresaId, role: "tenant_admin", permissions: [] }],
    };
    const deadLetterId = (await owner.query(
      "SELECT id FROM jobs_falhos WHERE empresa_id = $1 AND outbox_job_id = $2",
      [empresaId, failedJob.id],
    )).rows[0].id;
    const listedFailures = await service.listFailedJobs({ auth: adminAuth, empresaId, query: { status: "open" } });
    assert.equal(listedFailures.items.some((item) => item.id === deadLetterId), true);
    assert.equal(Object.hasOwn(listedFailures.items.find((item) => item.id === deadLetterId), "payloadSanitized"), false);

    const retried = await service.retryFailedJob({
      auth: adminAuth,
      empresaId,
      failedJobId: deadLetterId,
      body: { reason: "Falha sintética corrigida antes da retentativa." },
      correlationId: randomUUID(),
    });
    assert.notEqual(retried.retryJobId, failedJob.id);
    const retryState = (await owner.query(
      `SELECT f.resolution_kind, f.resolution_note, f.resolved_by_usuario_id,
              o.status AS retry_status, o.tentativas AS retry_attempts,
              m.status AS message_status,
              (SELECT count(*)::int FROM logs_auditoria a
                WHERE a.empresa_id = $1 AND a.acao = 'failed_jobs.retry'
                  AND a.recurso_id = f.id::text) AS audits
         FROM jobs_falhos f
         JOIN outbox_jobs o ON o.empresa_id = f.empresa_id AND o.id = f.retry_job_id
         JOIN mensagens m ON m.empresa_id = f.empresa_id AND m.id = f.mensagem_id
        WHERE f.empresa_id = $1 AND f.id = $2`,
      [empresaId, deadLetterId],
    )).rows[0];
    assert.deepEqual(retryState, {
      resolution_kind: "reenfileirado",
      resolution_note: "Falha sintética corrigida antes da retentativa.",
      resolved_by_usuario_id: operatorId,
      retry_status: "pendente",
      retry_attempts: 0,
      message_status: "enfileirada",
      audits: 1,
    });

    const retryJob = (await owner.query(
      `UPDATE outbox_jobs SET status = 'publicado', published_at = now()
        WHERE empresa_id = $1 AND id = $2
      RETURNING id, conversa_id, mensagem_id, job_type, correlation_id`,
      [empresaId, retried.retryJobId],
    )).rows[0];
    const retryReference = {
      jobId: retryJob.id,
      empresaId,
      conversationId: retryJob.conversa_id,
      messageId: retryJob.mensagem_id,
      statusEventId: null,
      type: retryJob.job_type,
      correlationId: retryJob.correlation_id,
      payloadVersion: 1,
    };
    assert.equal((await jobRepository.claim(retryReference, { attempt: 1 })).outcome, "claimed");
    await jobRepository.fail(retryReference, {
      attempt: 1,
      maxAttempts: 1,
      error: { code: "META_STILL_UNAVAILABLE", message: "Falha sintética após retentativa." },
    });
    const retryDeadLetterId = (await owner.query(
      "SELECT id FROM jobs_falhos WHERE empresa_id = $1 AND outbox_job_id = $2",
      [empresaId, retryJob.id],
    )).rows[0].id;
    const resolved = await service.resolveFailedJob({
      auth: adminAuth,
      empresaId,
      failedJobId: retryDeadLetterId,
      body: { reason: "Incidente encerrado sem novo envio." },
      correlationId: randomUUID(),
    });
    assert.equal(resolved.resolutionKind, "resolvido");
    assert.equal(resolved.retryJobId, null);
    assert.equal((await owner.query(
      "SELECT status FROM mensagens WHERE empresa_id = $1 AND id = $2",
      [empresaId, failedMessage.id],
    )).rows[0].status, "falhou");
  } finally {
    await owner.query("ROLLBACK").catch(() => {});
    if (empresaId) {
      await owner.query("DELETE FROM logs_auditoria WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM jobs_falhos WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM outbox_jobs WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM mensagens WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM conversas WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM contatos WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM numeros_whatsapp WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM usuarios_empresas WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM empresas WHERE id = $1", [empresaId]).catch(() => {});
    }
    if (operatorId) await owner.query("DELETE FROM usuarios WHERE id = $1", [operatorId]).catch(() => {});
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});

test("PostgreSQL sincroniza agenda Google Sheets com RLS e desativa evento removido", { skip: !enabled }, async () => {
  const appPool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const ownerPool = new pg.Pool({ connectionString: process.env.DATABASE_MIGRATOR_URL });
  const owner = await ownerPool.connect();
  const suffix = randomUUID();
  let empresaId;
  try {
    empresaId = (await owner.query(
      "INSERT INTO empresas (slug, nome, nome_exibicao, status) VALUES ($1, 'Sheets integração', 'Sheets integração', 'ativa') RETURNING id",
      [`sheets-${suffix}`],
    )).rows[0].id;
    await owner.query(
      `INSERT INTO configuracoes_empresa (empresa_id, saudacao, mensagem_fallback, endereco)
       VALUES ($1, 'Olá', 'Contingência', 'Endereço anterior')`,
      [empresaId],
    );
    const mapper = new PostgresGoogleSheetsSnapshotMapper(appPool, { clock: () => new Date("2026-08-30T12:00:00-03:00") });
    const first = await mapper.map({
      agenda: [["evento-a", "2026-09-05", "Sábado", "20:00", "Banda A", "35,00", "VIP", "Observação", "Ativo"]],
      settings: [["endereco", "Rua Nova, 10"], ["chave_pix", "não importar"]],
    }, {}, { empresaId });
    assert.equal(first.events.length, 1);
    const persisted = (await owner.query(
      `SELECT e.external_id, e.status, e.local, p.preco::text, p.ativo
         FROM eventos e JOIN eventos_produtos ep ON ep.empresa_id = e.empresa_id AND ep.evento_id = e.id
         JOIN produtos_servicos p ON p.empresa_id = ep.empresa_id AND p.id = ep.produto_servico_id
        WHERE e.empresa_id = $1 AND e.origem_externa = 'google_sheets'`,
      [empresaId],
    )).rows[0];
    assert.deepEqual(persisted, { external_id: "evento-a", status: "publicado", local: "Rua Nova, 10", preco: "35.00", ativo: true });

    await mapper.map({
      agenda: [["evento-b", "2026-09-06", "Domingo", "18:00", "Banda B", "20", "", "", "Ativo"]],
      settings: [["endereco", "Rua Nova, 10"]],
    }, {}, { empresaId });
    const states = (await owner.query(
      `SELECT e.external_id, e.status, p.ativo
         FROM eventos e JOIN eventos_produtos ep ON ep.empresa_id = e.empresa_id AND ep.evento_id = e.id
         JOIN produtos_servicos p ON p.empresa_id = ep.empresa_id AND p.id = ep.produto_servico_id
        WHERE e.empresa_id = $1 AND e.origem_externa = 'google_sheets' ORDER BY e.external_id`,
      [empresaId],
    )).rows;
    assert.deepEqual(states, [
      { external_id: "evento-a", status: "cancelado", ativo: false },
      { external_id: "evento-b", status: "publicado", ativo: true },
    ]);
  } finally {
    if (empresaId) {
      await owner.query("DELETE FROM eventos_produtos WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM eventos WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM produtos_servicos WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM configuracoes_empresa WHERE empresa_id = $1", [empresaId]).catch(() => {});
      await owner.query("DELETE FROM empresas WHERE id = $1", [empresaId]).catch(() => {});
    }
    owner.release();
    await appPool.end();
    await ownerPool.end();
  }
});
