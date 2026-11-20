-- Individual, opt-in follow-up. No company or existing/new conversation is enabled.
CREATE TABLE follow_up_settings (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT false,
  profile text NOT NULL DEFAULT 'test' CHECK(profile IN ('test','standard')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  legacy_pilot boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE follow_up_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conversa_id uuid NOT NULL,
  contato_id uuid NOT NULL,
  profile text NOT NULL CHECK(profile IN ('test','standard')),
  generation bigint NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  enabled boolean NOT NULL DEFAULT true,
  state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','cancelled','completed','declined','exhausted','uncertain')),
  reason text,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id),
  FOREIGN KEY(empresa_id,conversa_id) REFERENCES conversas(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(empresa_id,contato_id) REFERENCES contatos(empresa_id,id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX follow_up_one_active ON follow_up_cycles(empresa_id,conversa_id) WHERE enabled;
CREATE TABLE follow_up_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  cycle_id uuid NOT NULL,
  slot smallint NOT NULL CHECK(slot BETWEEN 0 AND 4),
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','prepared','started','accepted','cancelled','blocked','uncertain','completed')),
  reason text,
  watermark bigint,
  config_version bigint,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,cycle_id,slot),
  FOREIGN KEY(empresa_id,cycle_id) REFERENCES follow_up_cycles(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(empresa_id,message_id) REFERENCES mensagens(empresa_id,id) ON DELETE RESTRICT
);
CREATE TABLE follow_up_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  cycle_id uuid NOT NULL,
  conversa_id uuid NOT NULL,
  contato_id uuid NOT NULL,
  config_version bigint NOT NULL,
  summary text, phone text, source_message_ids uuid[] NOT NULL DEFAULT '{}', redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(empresa_id,id), UNIQUE(empresa_id,cycle_id),
  FOREIGN KEY(empresa_id,cycle_id) REFERENCES follow_up_cycles(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(empresa_id,conversa_id) REFERENCES conversas(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(empresa_id,contato_id) REFERENCES contatos(empresa_id,id) ON DELETE RESTRICT
);
ALTER TABLE group_notifier_deliveries ALTER COLUMN lead_id DROP NOT NULL;
ALTER TABLE group_notifier_deliveries ADD COLUMN follow_up_handoff_id uuid;
ALTER TABLE group_notifier_deliveries ADD CONSTRAINT group_delivery_subject CHECK(num_nonnulls(lead_id,follow_up_handoff_id)=1);
ALTER TABLE group_notifier_deliveries ADD CONSTRAINT group_delivery_follow_up_fk FOREIGN KEY(empresa_id,follow_up_handoff_id) REFERENCES follow_up_handoffs(empresa_id,id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX group_delivery_follow_up_unique ON group_notifier_deliveries(empresa_id,follow_up_handoff_id) WHERE follow_up_handoff_id IS NOT NULL;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['follow_up_settings','follow_up_cycles','follow_up_actions','follow_up_handoffs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON %I USING ((empresa_id=app_current_empresa_id() AND app_current_audience()<>''customer'') OR app_is_platform_admin()) WITH CHECK ((empresa_id=app_current_empresa_id() AND app_current_audience()<>''customer'') OR app_is_platform_admin())',t);
  END LOOP;
END $$;

-- The ingress transaction already locks its conversation. Invalidate drafts
-- before a competing dispatch can claim them. Started sends are never retried.
CREATE FUNCTION follow_up_invalidate_on_inbound() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.direcao='entrada' AND NOT coalesce(NEW.outbound_payload->>'historical','false')='true' THEN
    UPDATE follow_up_actions a SET state='cancelled',reason='CUSTOMER_REPLIED',updated_at=now()
      FROM follow_up_cycles c WHERE a.empresa_id=NEW.empresa_id AND c.empresa_id=a.empresa_id AND c.id=a.cycle_id
      AND c.conversa_id=NEW.conversa_id AND a.state='prepared';
    UPDATE mensagens m SET status='ignorada_duplicidade' FROM follow_up_actions a
      WHERE a.empresa_id=NEW.empresa_id AND a.message_id=m.id AND a.state='cancelled' AND m.external_message_id IS NULL
        AND m.status='enfileirada';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_invalidate_follow_up AFTER INSERT ON mensagens FOR EACH ROW EXECUTE FUNCTION follow_up_invalidate_on_inbound();
CREATE FUNCTION follow_up_cancel_on_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.modo_atendimento<>'bot' OR NEW.status<>'aberta' OR NEW.lock_version<>OLD.lock_version THEN
    UPDATE follow_up_cycles SET enabled=false,state='cancelled',reason='BOT_STATE_CHANGED',updated_at=now()
      WHERE empresa_id=NEW.empresa_id AND conversa_id=NEW.id AND enabled;
    UPDATE follow_up_actions a SET state='cancelled',reason='BOT_STATE_CHANGED',updated_at=now()
      FROM follow_up_cycles c WHERE c.empresa_id=NEW.empresa_id AND c.conversa_id=NEW.id AND a.empresa_id=c.empresa_id
      AND a.cycle_id=c.id AND a.state IN ('pending','prepared');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER conversations_cancel_follow_up AFTER UPDATE OF modo_atendimento,status,lock_version ON conversas FOR EACH ROW EXECUTE FUNCTION follow_up_cancel_on_pause();
CREATE FUNCTION follow_up_redact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.anonimizado_at IS NOT NULL THEN
    UPDATE follow_up_handoffs SET summary=NULL,phone=NULL,redacted_at=coalesce(redacted_at,now()) WHERE empresa_id=NEW.empresa_id AND contato_id=NEW.id;
    UPDATE follow_up_cycles SET enabled=false,state='cancelled',reason='CONTACT_REDACTED' WHERE empresa_id=NEW.empresa_id AND contato_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_redact_follow_up AFTER UPDATE OF deleted_at,anonimizado_at ON contatos FOR EACH ROW EXECUTE FUNCTION follow_up_redact();
CREATE FUNCTION follow_up_redact_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.redacted_at IS NOT NULL THEN
    UPDATE follow_up_handoffs SET summary=NULL,phone=NULL,redacted_at=coalesce(redacted_at,now())
      WHERE empresa_id=NEW.empresa_id AND NEW.id=ANY(source_message_ids);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_redact_follow_up AFTER UPDATE OF redacted_at ON mensagens FOR EACH ROW EXECUTE FUNCTION follow_up_redact_source();
