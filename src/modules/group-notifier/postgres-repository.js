import { randomUUID, createHash } from "node:crypto";
import { withPlatformTransaction, withTenantTransaction } from "../../infra/postgres/transaction.js";
import { encryptCredentialSecret, decryptCredentialSecret } from "../../security/credential-crypto.js";
import { normalizePilotPhone } from "../../integrations/whatsapp-web/group-session.js";
import { AdminError } from "../admin/errors.js";
import { readGroupDelivery, groupDeliveryAllowed, LEAD_IMAGE_MIME_TYPES } from "./delivery-images.js";

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
      await client.query(`UPDATE group_notifier_delivery_parts SET status='unconfirmed',error_code='SENDER_RESTARTED',updated_at=now() WHERE status='sending'`);
      await client.query(`UPDATE group_notifier_deliveries d SET status=CASE
        WHEN EXISTS(SELECT 1 FROM group_notifier_delivery_parts p WHERE p.delivery_id=d.id)
          AND NOT EXISTS(SELECT 1 FROM group_notifier_delivery_parts p WHERE p.delivery_id=d.id AND p.status='unconfirmed') THEN 'pending'
        ELSE 'unconfirmed' END,error_code='SENDER_RESTARTED',updated_at=now() WHERE d.status='sending'`);
    });
  }
  candidate(owner, epoch) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      // Retention of lead snapshots follows the company's message retention.
      await client.query(`UPDATE qualified_leads l SET name=NULL,summary=NULL,qualification=NULL,phone=NULL,redacted_at=now()
        FROM empresas e WHERE e.id=l.empresa_id AND l.redacted_at IS NULL
        AND l.created_at<now()-make_interval(days=>e.retencao_mensagens_dias)`);
      return (await client.query(`SELECT d.id,d.group_id,EXISTS(SELECT 1 FROM group_notifier_delivery_parts p WHERE p.delivery_id=d.id) AS multipart
        FROM group_notifier_deliveries d WHERE d.status='pending' AND d.available_at<=now() ORDER BY d.created_at,d.id LIMIT 1`)).rows[0] || null;
    });
  }
  beginSend(owner, epoch, deliveryId) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      const row = await readGroupDelivery(client, uuid(deliveryId));
      if (!row || row.status !== "pending") return null;
      if (!groupDeliveryAllowed(row)) {
        await client.query(`UPDATE group_notifier_deliveries SET status='cancelled',error_code='POLICY_CHANGED',updated_at=now() WHERE id=$1`, [deliveryId]);
        return null;
      }
      if (!row.desired || row.phase !== "connected" || !(Date.parse(row.lease_until) > Date.now())) return null;
      await client.query(`UPDATE group_notifier_deliveries SET status='sending',lease_owner=$2,updated_at=now() WHERE id=$1`, [deliveryId, owner]);
      const multipart = (await client.query("SELECT 1 FROM group_notifier_delivery_parts WHERE delivery_id=$1 LIMIT 1", [deliveryId])).rowCount > 0;
      return { ...row, multipart };
    });
  }

  beginPart(owner, epoch, deliveryId) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      const delivery = await readGroupDelivery(client, uuid(deliveryId));
      if (!delivery || delivery.status !== "sending" || delivery.lease_owner !== owner) return null;
      if (!delivery.desired || delivery.phase !== "connected" || !(Date.parse(delivery.lease_until) > Date.now())) return null;
      if (!groupDeliveryAllowed(delivery) || delivery.compiled.configuration.ai.leadImageHandoffEnabled !== true) {
        await client.query("UPDATE group_notifier_deliveries SET status='cancelled',error_code='POLICY_CHANGED',updated_at=now() WHERE id=$1", [deliveryId]); return null;
      }
      const part = (await client.query(`SELECT p.*,m.media_storage_key AS storage_key,m.media_sha256 AS sha256,m.media_mime_type AS mime_type,
        m.media_size_bytes AS size_bytes,m.redacted_at,m.expires_at,m.conversa_id,m.direcao,m.tipo
        FROM group_notifier_delivery_parts p LEFT JOIN mensagens m ON m.empresa_id=p.empresa_id AND m.id=p.source_message_id
        WHERE p.delivery_id=$1 AND p.status='pending' ORDER BY p.position LIMIT 1 FOR UPDATE OF p`, [deliveryId])).rows[0];
      if (!part) return null;
      if (part.kind === "image" && (!part.storage_key || !/^[a-f0-9]{64}$/u.test(part.sha256 || "") || part.redacted_at
        || part.expires_at && Date.parse(part.expires_at) <= Date.now() || part.conversa_id !== delivery.conversa_id
        || part.direcao !== "entrada" || part.tipo !== "imagem" || !LEAD_IMAGE_MIME_TYPES.includes(part.mime_type))) {
        await client.query("UPDATE group_notifier_delivery_parts SET status='cancelled',error_code='MEDIA_UNAVAILABLE',updated_at=now() WHERE id=$1", [part.id]);
        await client.query("UPDATE group_notifier_deliveries SET status='unconfirmed',error_code='MEDIA_UNAVAILABLE',updated_at=now() WHERE id=$1", [deliveryId]); return null;
      }
      await client.query("UPDATE group_notifier_delivery_parts SET status='sending',updated_at=now() WHERE id=$1", [part.id]);
      return part;
    });
  }

  canSendPart(owner, epoch, deliveryId, part) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      const delivery = await readGroupDelivery(client, uuid(deliveryId));
      if (!delivery || delivery.status !== "sending" || delivery.lease_owner !== owner || !groupDeliveryAllowed(delivery)
        || delivery.compiled.configuration.ai.leadImageHandoffEnabled !== true || !delivery.desired || delivery.phase !== "connected"
        || !(Date.parse(delivery.lease_until) > Date.now())) return false;
      return (await client.query(`SELECT 1 FROM group_notifier_delivery_parts p LEFT JOIN mensagens m ON m.empresa_id=p.empresa_id AND m.id=p.source_message_id
        WHERE p.id=$1 AND p.delivery_id=$2 AND p.status='sending' AND (p.kind='summary' OR
          m.direcao='entrada' AND m.tipo='imagem' AND m.conversa_id=$3 AND m.redacted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at>now())
          AND m.media_storage_key=$4 AND m.media_sha256=$5 AND m.media_mime_type=$6)`,
      [uuid(part.id), deliveryId, delivery.conversa_id, part.storage_key || null, part.sha256 || null, part.mime_type || null])).rowCount > 0;
    });
  }

  completePart(owner, epoch, deliveryId, partId, result) {
    return this.platform(async (client) => {
      await this.fence(client, owner, epoch);
      await client.query(`UPDATE group_notifier_delivery_parts p SET status=$4,message_id=$5,error_code=$6,updated_at=now()
        FROM group_notifier_deliveries d WHERE p.id=$1 AND d.id=$2 AND p.delivery_id=d.id AND d.lease_owner=$3 AND p.status='sending'`,
      [uuid(partId), uuid(deliveryId), owner, result.messageId ? "accepted" : "unconfirmed", result.messageId || null, result.messageId ? null : "SEND_UNCONFIRMED"]);
    });
  }
  complete(owner, deliveryId, result) {
    return this.platform(async (client) => {
      const delivery = await readGroupDelivery(client, uuid(deliveryId));
      if (!delivery || delivery.lease_owner !== owner || delivery.status !== "sending") return;
      const parts = (await client.query("SELECT status,message_id FROM group_notifier_delivery_parts WHERE delivery_id=$1 ORDER BY position", [deliveryId])).rows;
      let status = result.messageId ? "accepted" : "unconfirmed", error = result.messageId ? null : "SEND_UNCONFIRMED";
      if (parts.length) {
        status = parts.some((part) => ["sending", "unconfirmed", "cancelled"].includes(part.status)) ? "unconfirmed"
          : parts.some((part) => part.status === "pending") ? "pending" : "accepted";
        error = status === "unconfirmed" ? "PART_SEND_UNCONFIRMED" : null;
      }
      await client.query(`UPDATE group_notifier_deliveries SET status=$3,message_id=$4,error_code=$5,updated_at=now()
        WHERE id=$1 AND lease_owner=$2 AND status='sending'`, [deliveryId, owner, status, parts.find((part) => part.message_id)?.message_id || result.messageId || null, error]);
    });
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
