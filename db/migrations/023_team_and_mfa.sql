-- F2: expansao aditiva, sem atribuir proprietarios ou ativar fatores legados.
ALTER TABLE usuarios ADD COLUMN mfa_envelope jsonb, ADD COLUMN mfa_last_counter bigint;
ALTER TABLE auth_sessions ADD COLUMN mfa_verified_at timestamptz, ADD COLUMN reauthenticated_at timestamptz;
CREATE TABLE identity_challenges (
  id uuid PRIMARY KEY, usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  digest bytea NOT NULL UNIQUE, audience text NOT NULL CHECK (audience IN ('admin','customer')),
  purpose text NOT NULL CHECK (purpose IN ('login','enroll')),
  session_id uuid REFERENCES auth_sessions(id) ON DELETE CASCADE,
  security_version integer NOT NULL, envelope jsonb,
  attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mfa_recovery_codes (
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  digest bytea NOT NULL, consumed_at timestamptz, PRIMARY KEY(usuario_id,digest)
);
CREATE TABLE team_invitations (
  id uuid PRIMARY KEY, empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  email citext NOT NULL, role text NOT NULL CHECK(role IN ('administrador','operador')),
  invited_by uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  digest bytea NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX team_pending_email ON team_invitations(empresa_id,email) WHERE status='pending';
CREATE TABLE ownership_transfers (
  id uuid PRIMARY KEY, empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  from_user uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  to_user uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  digest bytea NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','revoked','expired')),
  created_at timestamptz NOT NULL DEFAULT now(), CHECK(from_user<>to_user)
);
CREATE UNIQUE INDEX ownership_transfer_pending ON ownership_transfers(empresa_id) WHERE status='pending';
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['identity_challenges','mfa_recovery_codes','team_invitations','ownership_transfers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY service_access ON %I USING(app_is_platform_admin()) WITH CHECK(app_is_platform_admin())',t);
  END LOOP;
END $$;
CREATE POLICY team_tenant_access ON team_invitations USING(empresa_id=app_current_empresa_id()) WITH CHECK(empresa_id=app_current_empresa_id());
CREATE POLICY transfer_tenant_access ON ownership_transfers USING(empresa_id=app_current_empresa_id()) WITH CHECK(empresa_id=app_current_empresa_id());
CREATE POLICY owner_tenant_access ON company_owners USING(empresa_id=app_current_empresa_id()) WITH CHECK(empresa_id=app_current_empresa_id());
CREATE POLICY account_audit_tenant_insert ON account_audit FOR INSERT WITH CHECK(
  empresa_id=app_current_empresa_id() AND usuario_id=app_current_usuario_id()
);
CREATE POLICY team_mail_insert ON account_email_outbox FOR INSERT WITH CHECK(
  usuario_id=app_current_usuario_id() AND app_current_empresa_id() IS NOT NULL AND token_id IS NULL
);
CREATE POLICY team_identity_read ON usuarios FOR SELECT USING(
  EXISTS(SELECT 1 FROM usuarios_empresas actor WHERE actor.empresa_id=app_current_empresa_id()
    AND actor.usuario_id=app_current_usuario_id() AND actor.status='ativo' AND actor.papel='administrador')
  AND EXISTS(SELECT 1 FROM usuarios_empresas member WHERE member.empresa_id=app_current_empresa_id() AND member.usuario_id=usuarios.id)
);
-- Protege tambem o CRUD administrativo legado contra suspensao/rebaixamento do proprietario.
CREATE FUNCTION protect_company_owner_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF EXISTS(SELECT 1 FROM company_owners WHERE empresa_id=OLD.empresa_id AND usuario_id=OLD.usuario_id)
     AND (TG_OP='DELETE' OR NEW.papel<>'administrador' OR NEW.status<>'ativo'
       OR NEW.usuario_id<>OLD.usuario_id OR NEW.empresa_id<>OLD.empresa_id) THEN
    RAISE EXCEPTION 'OWNER_MEMBERSHIP_PROTECTED' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER owner_membership_guard BEFORE UPDATE OR DELETE ON usuarios_empresas
  FOR EACH ROW EXECUTE FUNCTION protect_company_owner_membership();
