import { randomUUID, createHash } from "node:crypto";
import { withPlatformTransaction, withTenantTransaction } from "../../infra/postgres/transaction.js";
import { encryptCredentialSecret, decryptCredentialSecret } from "../../security/credential-crypto.js";
import { normalizePilotPhone } from "../../integrations/whatsapp-web/group-session.js";
import { verifyCompiledTenantRuntimeConfigV2 } from "../configuration/compiler.js";
import { AdminError } from "../admin/errors.js";

const MESSAGES = {
  INVALID_PHONE: "Informe o número dedicado em formato internacional, com +55 e DDD.",
  INVALID_ID: "Identificador inválido.", INVALID_GROUP: "Selecione um grupo válido.", INVALID_ROUTE: "Os dados do destino são inválidos.",
  NOTIFIER_KEYRING_REQUIRED: "O cofre da plataforma precisa estar disponível para conectar o remetente.",
  NOTIFIER_DISCONNECT_FIRST: "Desconecte o remetente antes de iniciar um novo vínculo.",
  NOTIFIER_GROUP_NOT_VERIFIED: "Conecte o remetente e atualize os grupos antes de habilitar esse destino.",
  COMPANY_NOT_FOUND: "Empresa não encontrada.", ROUTE_VERSION_CONFLICT: "O destino foi alterado. Atualize a tela antes de salvar.",
  GROUP_ALREADY_ASSIGNED: "Esse grupo já está associado a outra empresa.", NOTIFIER_LEASE_LOST: "A sessão não possui mais a trava exclusiva de envio.",
};
const fail = (code, status = 409) => new AdminError(MESSAGES[code] || "Não foi possível concluir a operação do remetente.", { code, status });
const uuid = (value) => {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw fail("INVALID_ID", 400);
  return value;
};
const groupId = (value) => {
  if (typeof value !== "string" || !/^\d+(?:-\d+)?@g\.us$/u.test(value)) throw fail("INVALID_GROUP", 400);
  return value;
};
const binding = (epoch, type, id) => ({ empresaId: "waia-platform", provider: "whatsapp-web", purpose: "group-notifier-auth",
  credentialId: `${epoch}:${createHash("sha256").update(`${type}:${id}`).digest("hex")}` });

export class PostgresGroupNotifierRepository {
  constructor(pool, keyring) { this.pool = pool; this.keyring = keyring; }
  platform(fn, actorId) { return withPlatformTransaction(this.pool, { usuarioId: actorId }, ({ client }) => fn(client)); }
  tenant(empresaId, fn, actorId) { return withTenantTransaction(this.pool, { empresaId: uuid(empresaId), usuarioId: actorId }, ({ client }) => fn(client)); }
  encrypt(epoch, type, id, secret) {
    if (!this.keyring) throw fail("NOTIFIER_KEYRING_REQUIRED");
    return encryptCredentialSecret({ secret, keyring: this.keyring, binding: binding(epoch, type, id) });
  }
  decrypt(epoch, type, id, envelope) { return decryptCredentialSecret({ envelope, keyring: this.keyring, binding: binding(epoch, type, id) }); }
  async audit(client, { actorId, empresaId = null, action, resourceId = "central" }) {
    await client.query(`INSERT INTO logs_auditoria(id,empresa_id,ator_usuario_id,acao,recurso_tipo,recurso_id,resultado,campos_alterados_redigidos)
      VALUES ($1,$2,$3,$4,'group_notifier',$5,'sucesso','{"fields":[]}'::jsonb)`, [randomUUID(), empresaId, actorId, action, resourceId]);
  }
  async status(actorId) {
    return this.platform(async (client) => {
      const row = (await client.query(`SELECT desired,phone,epoch,phase,error_code,heartbeat_at,lease_until,qr_envelope,qr_expires_at FROM group_notifier_connection WHERE id`)).rows[0];
      const fresh = row.lease_until && Date.parse(row.lease_until) > Date.now();
      return { desired: row.desired, phase: fresh ? row.phase : "offline", phone: row.phone ? `••••${row.phone.slice(-4)}` : null,
        heartbeatAt: row.heartbeat_at, error: row.error_code, qr: fresh && row.qr_envelope && Date.parse(row.qr_expires_at) > Date.now()
          ? this.decrypt(row.epoch, "qr", "current", row.qr_envelope) : null };
    }, actorId);
  }
  configure(phone, actorId) {
    if (!this.keyring) throw fail("NOTIFIER_KEYRING_REQUIRED");
    let normalized;
    try { normalized = normalizePilotPhone(phone); } catch { throw fail("INVALID_PHONE", 400); }
    return this.platform(async (client) => {
      const old = (await client.query("SELECT desired,phase FROM group_notifier_connection WHERE id FOR UPDATE")).rows[0];
      if (old.desired && ["connected", "connecting", "qr", "reconnecting"].includes(old.phase)) throw fail("NOTIFIER_DISCONNECT_FIRST");
      await client.query(`UPDATE group_notifier_connection SET desired=true,phone=$1,epoch=epoch+1,phase='connecting',
        qr_envelope=NULL,qr_expires_at=NULL,error_code=NULL,updated_at=now() WHERE id`, [normalized]);
      await client.query("DELETE FROM group_notifier_auth"); await client.query("DELETE FROM group_notifier_groups");
      await this.audit(client, { actorId, action: "group_notifier.connect" });
      return { started: true };
    }, actorId);
  }
  revoke(actorId) {
    return this.platform(async (client) => {
      await client.query(`UPDATE group_notifier_connection SET desired=false,epoch=epoch+1,phase='disconnecting',qr_envelope=NULL,qr_expires_at=NULL,updated_at=now() WHERE id`);
      await client.query("DELETE FROM group_notifier_auth"); await client.query("DELETE FROM group_notifier_groups");
      await this.audit(client, { actorId, action: "group_notifier.disconnect" });
      return { requested: true };
    }, actorId);
  }
  groups() {
    return this.platform(async (client) => (await client.query(`SELECT g.group_id AS id,g.name,g.verified_at AS "verifiedAt"
      FROM group_notifier_groups g JOIN group_notifier_connection c ON c.id AND c.epoch=g.epoch
      WHERE c.desired AND c.phase='connected' AND c.lease_until>now() AND g.verified_at>now()-interval '2 minutes' ORDER BY g.name`)).rows);
  }
  route(empresaId) { return this.tenant(empresaId, async (client) => (await client.query(`SELECT empresa_id AS "empresaId",group_id AS "groupId",group_name AS "groupName",enabled,revision
    FROM group_notifier_routes WHERE empresa_id=$1`, [empresaId])).rows[0] || null); }
  saveRoute(empresaId, { groupId: id, enabled, revision = 0 }, actorId) {
    uuid(empresaId); groupId(id);
    if (typeof enabled !== "boolean" || !Number.isSafeInteger(revision) || revision < 0) throw fail("INVALID_ROUTE", 400);
    return this.platform(async (client) => {
      const company = (await client.query("SELECT id FROM empresas WHERE id=$1 AND deleted_at IS NULL FOR SHARE", [empresaId])).rows[0];
      if (!company) throw fail("COMPANY_NOT_FOUND", 404);
      const old = (await client.query("SELECT * FROM group_notifier_routes WHERE empresa_id=$1 FOR UPDATE", [empresaId])).rows[0];
      if (Number(old?.revision || 0) !== revision) throw fail("ROUTE_VERSION_CONFLICT");
      if (!enabled && old?.group_id === id) {
        await client.query("UPDATE group_notifier_routes SET enabled=false,revision=revision+1,updated_at=now() WHERE empresa_id=$1", [empresaId]);
        await client.query("UPDATE group_notifier_deliveries SET status='cancelled',error_code='ROUTE_DISABLED',updated_at=now() WHERE empresa_id=$1 AND status='pending'", [empresaId]);
        await this.audit(client, { actorId, empresaId, action: "group_notifier.route.disabled", resourceId: empresaId });
        return { saved: true, revision: revision + 1 };
      }
      const sender = (await client.query("SELECT * FROM group_notifier_connection WHERE id FOR SHARE")).rows[0];
      const group = (await client.query(`SELECT * FROM group_notifier_groups WHERE group_id=$1 AND epoch=$2 AND verified_at>now()-interval '2 minutes'`, [id, sender.epoch])).rows[0];
      if (!group || !sender.desired || sender.phase !== "connected" || !(Date.parse(sender.lease_until) > Date.now())) throw fail("NOTIFIER_GROUP_NOT_VERIFIED");
      const collision = (await client.query("SELECT 1 FROM group_notifier_routes WHERE group_id=$1 AND empresa_id<>$2", [id, empresaId])).rowCount;
      if (collision) throw fail("GROUP_ALREADY_ASSIGNED");
      await client.query(`INSERT INTO group_notifier_routes(empresa_id,group_id,group_name,sender_phone,enabled)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT (empresa_id) DO UPDATE SET group_id=$2,group_name=$3,sender_phone=$4,enabled=$5,
        revision=group_notifier_routes.revision+1,updated_at=now()`, [empresaId, id, group.name, sender.phone, enabled]);
      await client.query(`UPDATE group_notifier_deliveries SET status='cancelled',error_code='ROUTE_CHANGED',updated_at=now()
        WHERE empresa_id=$1 AND status='pending'`, [empresaId]);
      await this.audit(client, { actorId, empresaId, action: "group_notifier.route.updated", resourceId: empresaId });
      return { saved: true, revision: revision + 1 };
    }, actorId);
  }
  leads(empresaId) {
    return this.tenant(empresaId, async (client) => (await client.query(`SELECT l.id,l.conversa_id AS "conversationId",l.name,l.summary,l.qualification,
      l.phone,l.created_at AS "createdAt",d.status AS "notificationStatus",d.error_code AS "notificationError"
      FROM qualified_leads l LEFT JOIN group_notifier_deliveries d ON d.empresa_id=l.empresa_id AND d.lead_id=l.id
      WHERE l.empresa_id=$1 AND l.redacted_at IS NULL ORDER BY l.created_at DESC,l.id DESC LIMIT 100`, [empresaId])).rows);
  }
  lease(owner) {
    return this.platform(async (client) => (await client.query(`UPDATE group_notifier_connection
      SET lease_owner=$1,lease_until=now()+interval '30 seconds',heartbeat_at=now()
      WHERE id AND (lease_owner=$1 OR lease_until IS NULL OR lease_until<now()) RETURNING *`, [uuid(owner)])).rows[0] || null);
  }
  async fence(client, owner, epoch) {
    const row = (await client.query(`SELECT 1 FROM group_notifier_connection WHERE id AND lease_owner=$1 AND epoch=$2 AND lease_until>now() FOR SHARE`, [owner, epoch])).rows[0];
    if (!row) throw fail("NOTIFIER_LEASE_LOST");
  }
  publish(owner, epoch, state) {
    const qrEnvelope = state.qr ? this.encrypt(epoch, "qr", "current", state.qr) : null;
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      await client.query(`UPDATE group_notifier_connection SET phase=$3,error_code=$4,qr_envelope=$5::jsonb,
        qr_expires_at=$6,updated_at=now() WHERE id AND lease_owner=$1 AND epoch=$2`,
      [owner, epoch, state.phase, state.error || null, qrEnvelope ? JSON.stringify(qrEnvelope) : null, state.qr ? new Date(state.qrAt + 55_000) : null]);
    });
  }
  cacheGroups(owner, epoch, groups) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch); await client.query("DELETE FROM group_notifier_groups");
      for (const group of groups) await client.query(`INSERT INTO group_notifier_groups(group_id,name,epoch) VALUES ($1,$2,$3)`, [groupId(group.id), group.name.slice(0, 128), epoch]);
    });
  }
  authStore(owner, epoch) {
    const load = (type, ids) => this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      const rows = (await client.query("SELECT key_id,envelope FROM group_notifier_auth WHERE epoch=$1 AND key_type=$2 AND key_id=ANY($3::text[])", [epoch, type, ids])).rows;
      return Object.fromEntries(rows.map((row) => [row.key_id, this.decrypt(epoch, type, row.key_id, row.envelope)]));
    });
    const save = (categories, stringify) => this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      for (const [type, values] of Object.entries(categories)) {
        for (const [id, value] of Object.entries(values)) {
          if (value == null) await client.query("DELETE FROM group_notifier_auth WHERE epoch=$1 AND key_type=$2 AND key_id=$3", [epoch, type, id]);
          else await client.query(`INSERT INTO group_notifier_auth(epoch,key_type,key_id,envelope) VALUES ($1,$2,$3,$4::jsonb)
            ON CONFLICT(epoch,key_type,key_id) DO UPDATE SET envelope=$4::jsonb,updated_at=now()`, [epoch, type, id, JSON.stringify(this.encrypt(epoch, type, id, stringify(value)))]);
        }
      }
    });
    let serialize, parse;
    return {
      async open(provider) {
        serialize = (value) => JSON.stringify(value, provider.BufferJSON.replacer);
        parse = (value) => JSON.parse(value, provider.BufferJSON.reviver);
        const loaded = await load("creds", ["current"]);
        const creds = loaded.current ? parse(loaded.current) : provider.initAuthCreds();
        return { creds, keys: {
          async get(type, ids) {
            const raw = await load(type, ids), result = {};
            for (const id of ids) {
              let value = raw[id] ? parse(raw[id]) : undefined;
              if (type === "app-state-sync-key" && value) value = provider.proto.Message.AppStateSyncKeyData.fromObject(value);
              result[id] = value;
            }
            return result;
          },
          async set(values) { await save(values, serialize); },
        } };
      },
      async saveCredentials(creds) { await save({ creds: { current: creds } }, serialize); },
      clear: () => this.platform(async (client) => { await this.fence(client, owner, epoch); await client.query("DELETE FROM group_notifier_auth WHERE epoch=$1", [epoch]); }),
    };
  }
  recover(owner, epoch) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      await client.query(`UPDATE group_notifier_deliveries SET status='unconfirmed',error_code='SENDER_RESTARTED',updated_at=now()
        WHERE status='sending'`);
    });
  }
  candidate(owner, epoch) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      // Retention of lead snapshots follows the company's message retention.
      await client.query(`UPDATE qualified_leads l SET name=NULL,summary=NULL,qualification=NULL,phone=NULL,redacted_at=now()
        FROM empresas e WHERE e.id=l.empresa_id AND l.redacted_at IS NULL
        AND l.created_at<now()-make_interval(days=>e.retencao_mensagens_dias)`);
      return (await client.query(`SELECT id,group_id FROM group_notifier_deliveries WHERE status='pending' AND available_at<=now() ORDER BY created_at,id LIMIT 1`)).rows[0] || null;
    });
  }
  beginSend(owner, epoch, deliveryId) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      const row = (await client.query(`SELECT d.*,l.name,l.summary,l.qualification,l.phone,l.redacted_at,l.config_version,
        e.nome_exibicao AS company_name,e.status AS company_status,e.deleted_at AS company_deleted,
        e.configuracao_runtime_modo,e.versao_configuracao,e.configuracao_ativa_versao,
        c.status AS conversation_status,ct.deleted_at AS contact_deleted,ct.bloqueado AS blocked,ct.anonimizado_at,
        ct.bot_pausado AS contact_paused,n.status AS number_status,n.deleted_at AS number_deleted,
        r.enabled AS route_enabled,r.group_id AS current_group,r.revision AS current_revision,r.sender_phone AS current_sender,
        s.desired,s.phone AS actual_sender,s.phase,s.lease_until,
        cr.configuracao_compilada AS compiled
        FROM group_notifier_deliveries d JOIN qualified_leads l ON l.empresa_id=d.empresa_id AND l.id=d.lead_id
        JOIN empresas e ON e.id=d.empresa_id JOIN conversas c ON c.empresa_id=l.empresa_id AND c.id=l.conversa_id
        JOIN contatos ct ON ct.empresa_id=l.empresa_id AND ct.id=l.contato_id
        JOIN numeros_whatsapp n ON n.empresa_id=c.empresa_id AND n.id=c.numero_whatsapp_id
        LEFT JOIN group_notifier_routes r ON r.empresa_id=d.empresa_id
        JOIN group_notifier_connection s ON s.id
        LEFT JOIN configuracoes_revisoes cr ON cr.empresa_id=e.id AND cr.config_version=e.configuracao_ativa_versao
        WHERE d.id=$1 AND d.status='pending' FOR UPDATE OF d`, [uuid(deliveryId)])).rows[0];
      if (!row) return null;
      const validConfig = row.configuracao_runtime_modo === "versionado" && Number(row.versao_configuracao) === Number(row.configuracao_ativa_versao)
        && row.compiled && verifyCompiledTenantRuntimeConfigV2(row.compiled)
        && row.compiled.empresaId === row.empresa_id && row.compiled.configVersion === Number(row.config_version)
        && row.compiled.configuration.ai.enabled && row.compiled.configuration.ai.leadQualificationEnabled === true;
      const allowed = validConfig && row.company_status === "ativa" && !row.company_deleted && row.conversation_status === "aberta"
        && !row.contact_deleted && !row.blocked && !row.anonimizado_at && !row.contact_paused && !row.redacted_at
        && row.number_status === "ativo" && !row.number_deleted && row.route_enabled
        && row.current_group === row.group_id && Number(row.current_revision) === Number(row.route_revision)
        && row.current_sender === row.sender_phone && row.actual_sender === row.sender_phone;
      if (!allowed) {
        await client.query(`UPDATE group_notifier_deliveries SET status='cancelled',error_code='POLICY_CHANGED',updated_at=now() WHERE id=$1`, [deliveryId]);
        return null;
      }
      if (!row.desired || row.phase !== "connected" || !(Date.parse(row.lease_until) > Date.now())) return null;
      await client.query(`UPDATE group_notifier_deliveries SET status='sending',lease_owner=$2,updated_at=now() WHERE id=$1`, [deliveryId, owner]);
      return row;
    });
  }
  complete(owner, deliveryId, result) {
    return this.platform((client) => client.query(`UPDATE group_notifier_deliveries SET status=$3,message_id=$4,error_code=$5,updated_at=now()
      WHERE id=$1 AND lease_owner=$2 AND status='sending'`, [deliveryId, owner, result.messageId ? "accepted" : "unconfirmed", result.messageId || null, result.messageId ? null : "SEND_UNCONFIRMED"]));
  }
  deferCandidate(owner, epoch, deliveryId) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      await client.query(`UPDATE group_notifier_deliveries SET available_at=now()+interval '60 seconds',error_code='GROUP_CHECK_FAILED',updated_at=now()
        WHERE id=$1 AND status='pending'`, [deliveryId]);
    });
  }
  release(owner) {
    return this.platform((client) => client.query(`UPDATE group_notifier_connection SET lease_owner=NULL,lease_until=NULL,qr_envelope=NULL,qr_expires_at=NULL WHERE id AND lease_owner=$1`, [owner]));
  }
}
