-- Expansao aditiva: contas/sessoes legadas continuam administrativas.
ALTER TABLE usuarios ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN security_version integer NOT NULL DEFAULT 1 CHECK (security_version > 0);
ALTER TABLE auth_sessions ADD COLUMN audience text NOT NULL DEFAULT 'admin'
  CHECK (audience IN ('admin','customer')),
  ADD COLUMN security_version integer NOT NULL DEFAULT 1;

CREATE TABLE account_tokens (
  id uuid PRIMARY KEY,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify','reset')),
  digest bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_tokens_user_idx ON account_tokens(usuario_id,purpose,created_at);
CREATE TABLE account_email_outbox (
  id uuid PRIMARY KEY,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_id uuid REFERENCES account_tokens(id) ON DELETE CASCADE,
  envelope jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','expired')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lease_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_email_pending_idx ON account_email_outbox(status,available_at);
CREATE TABLE account_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  empresa_id uuid REFERENCES empresas(id) ON DELETE RESTRICT,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE company_owners (
  empresa_id uuid PRIMARY KEY,
  usuario_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (empresa_id,usuario_id) REFERENCES usuarios_empresas(empresa_id,usuario_id) ON DELETE RESTRICT
);
CREATE TABLE company_provision_requests (
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  request_key text NOT NULL,
  payload_hash text NOT NULL,
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (usuario_id,request_key)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['account_tokens','account_email_outbox','account_audit','company_owners','company_provision_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY service_access ON %I USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin())',t);
  END LOOP;
END $$;
-- Leitura de identidade sem conceder escrita ou autoridade global.
CREATE POLICY membership_self_read ON usuarios_empresas FOR SELECT
  USING (usuario_id = app_current_usuario_id());
CREATE POLICY company_member_read ON empresas FOR SELECT USING (
  EXISTS (SELECT 1 FROM usuarios_empresas m WHERE m.empresa_id=empresas.id
    AND m.usuario_id=app_current_usuario_id() AND m.status='ativo')
);
CREATE POLICY owner_self_read ON company_owners FOR SELECT USING (usuario_id=app_current_usuario_id());
