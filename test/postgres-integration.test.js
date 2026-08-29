import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

const enabled = process.env.RUN_POSTGRES_INTEGRATION === "true";

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
