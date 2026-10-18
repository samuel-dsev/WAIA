-- Central sender is platform-only. Tenant data stays under forced RLS.
CREATE TABLE group_notifier_connection (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  desired boolean NOT NULL DEFAULT false,
  phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  epoch bigint NOT NULL DEFAULT 1 CHECK (epoch > 0),
  phase text NOT NULL DEFAULT 'disconnected',
  qr_envelope jsonb,
  qr_expires_at timestamptz,
  error_code text,
  lease_owner uuid,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO group_notifier_connection(id) VALUES (true);

CREATE TABLE group_notifier_auth (
  epoch bigint NOT NULL,
  key_type text NOT NULL CHECK (length(key_type) BETWEEN 1 AND 64),
  key_id text NOT NULL CHECK (length(key_id) BETWEEN 1 AND 256),
  envelope jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (epoch, key_type, key_id)
);
CREATE TABLE group_notifier_groups (
  group_id text PRIMARY KEY CHECK (group_id ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  epoch bigint NOT NULL,
  verified_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE group_notifier_routes (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  group_id text NOT NULL UNIQUE CHECK (group_id ~ '^[0-9]+(-[0-9]+)?@g[.]us$'),
  group_name text NOT NULL CHECK (length(group_name) BETWEEN 1 AND 128),
  sender_phone text NOT NULL CHECK (sender_phone ~ '^\+[1-9][0-9]{7,14}$'),
  enabled boolean NOT NULL DEFAULT false,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE qualified_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conversa_id uuid NOT NULL,
  contato_id uuid NOT NULL,
  reply_id uuid NOT NULL,
  config_version bigint NOT NULL,
  name text,
  summary text,
  qualification text,
  phone text,
  redacted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, conversa_id),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, reply_id) REFERENCES mensagens(empresa_id,id) ON DELETE RESTRICT
);
CREATE TABLE group_notifier_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  lead_id uuid NOT NULL,
  group_id text NOT NULL,
  route_revision bigint NOT NULL,
  sender_phone text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','accepted','unconfirmed','cancelled')),
  message_id text,
  lease_owner uuid,
  error_code text,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, lead_id),
  FOREIGN KEY (empresa_id,lead_id) REFERENCES qualified_leads(empresa_id,id) ON DELETE RESTRICT
);
CREATE INDEX group_notifier_pending_idx ON group_notifier_deliveries(created_at,id) WHERE status='pending';
CREATE INDEX qualified_leads_tenant_created_idx ON qualified_leads(empresa_id,created_at DESC,id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['group_notifier_connection','group_notifier_auth','group_notifier_groups'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY platform_only ON %I USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin())',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['group_notifier_routes','qualified_leads','group_notifier_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation_policy ON %I USING (empresa_id=app_current_empresa_id() OR app_is_platform_admin()) WITH CHECK (empresa_id=app_current_empresa_id() OR app_is_platform_admin())',t);
  END LOOP;
END $$;

-- Copies of personal data follow contact deletion/anonymization and retention.
CREATE FUNCTION redact_qualified_leads() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL OR NEW.anonimizado_at IS NOT NULL THEN
    UPDATE qualified_leads SET name=NULL, summary=NULL, qualification=NULL,phone=NULL,redacted_at=COALESCE(redacted_at,now())
      WHERE empresa_id=NEW.empresa_id AND contato_id=NEW.id;
    UPDATE group_notifier_deliveries SET status=CASE WHEN status='sending' THEN 'unconfirmed' ELSE 'cancelled' END,
      error_code='CONTACT_REDACTED',updated_at=now()
      WHERE empresa_id=NEW.empresa_id AND lead_id IN (SELECT id FROM qualified_leads WHERE empresa_id=NEW.empresa_id AND contato_id=NEW.id)
        AND status IN ('pending','sending');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER contacts_redact_qualified_leads AFTER UPDATE OF deleted_at,anonimizado_at ON contatos
  FOR EACH ROW EXECUTE FUNCTION redact_qualified_leads();

CREATE FUNCTION redact_qualified_leads_from_reply() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.redacted_at IS NOT NULL THEN
    UPDATE qualified_leads SET name=NULL,summary=NULL,qualification=NULL,phone=NULL,redacted_at=COALESCE(redacted_at,now())
      WHERE empresa_id=NEW.empresa_id AND reply_id=NEW.id;
    UPDATE group_notifier_deliveries SET status=CASE WHEN status='sending' THEN 'unconfirmed' ELSE 'cancelled' END,
      error_code='SOURCE_REDACTED',updated_at=now()
      WHERE empresa_id=NEW.empresa_id AND lead_id IN (SELECT id FROM qualified_leads WHERE empresa_id=NEW.empresa_id AND reply_id=NEW.id)
        AND status IN ('pending','sending');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER messages_redact_qualified_leads AFTER UPDATE OF redacted_at ON mensagens
  FOR EACH ROW EXECUTE FUNCTION redact_qualified_leads_from_reply();
