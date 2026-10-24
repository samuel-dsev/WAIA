-- M1: contexto customer explícito, sem inferir autoridade por owner/role.
-- Contextos internos/admin continuam definidos somente pela camada de servidor.
SELECT set_config('app.is_platform_admin','true',true);

-- Sessões anteriores sem os requisitos atuais não sobrevivem à nova fronteira.
UPDATE auth_sessions s SET revoked_at=coalesce(s.revoked_at,now())
  WHERE s.audience='admin' AND s.revoked_at IS NULL AND
    (s.mfa_verified_at IS NULL OR NOT EXISTS(SELECT 1 FROM usuarios u WHERE u.id=s.usuario_id
      AND u.status='ativo' AND u.deleted_at IS NULL AND u.papel_plataforma='administrador' AND u.mfa_habilitado));

CREATE FUNCTION enforce_admin_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.audience='admin' AND NEW.revoked_at IS NULL AND
    (NEW.mfa_verified_at IS NULL OR NOT EXISTS(SELECT 1 FROM usuarios u WHERE u.id=NEW.usuario_id
      AND u.status='ativo' AND u.deleted_at IS NULL AND u.papel_plataforma='administrador'
      AND u.mfa_habilitado AND u.security_version=NEW.security_version)) THEN
    RAISE EXCEPTION 'ADMIN_SESSION_IDENTITY_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER admin_session_identity_guard BEFORE INSERT OR UPDATE OF usuario_id,audience,mfa_verified_at,security_version,revoked_at
  ON auth_sessions FOR EACH ROW EXECUTE FUNCTION enforce_admin_session_identity();

CREATE FUNCTION protect_last_platform_administrator() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.papel_plataforma='administrador' AND OLD.status='ativo' AND OLD.deleted_at IS NULL
    AND (NEW.papel_plataforma<>'administrador' OR NEW.status<>'ativo' OR NEW.deleted_at IS NOT NULL) THEN
    PERFORM pg_advisory_xact_lock(810420267);
    IF NOT EXISTS(SELECT 1 FROM usuarios u WHERE u.id<>OLD.id AND u.papel_plataforma='administrador'
      AND u.status='ativo' AND u.deleted_at IS NULL) THEN
      RAISE EXCEPTION 'LAST_PLATFORM_ADMIN_PROTECTED' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER last_platform_admin_guard BEFORE UPDATE OF papel_plataforma,status,deleted_at ON usuarios
  FOR EACH ROW EXECUTE FUNCTION protect_last_platform_administrator();

CREATE FUNCTION app_current_audience() RETURNS text LANGUAGE sql STABLE PARALLEL SAFE AS $$
  SELECT coalesce(current_setting('app.audience', true), '');
$$;

CREATE FUNCTION protect_customer_identity_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_audience()='customer' AND
    (to_jsonb(NEW)-'nome'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'nome'-'updated_at') THEN
    RAISE EXCEPTION 'CUSTOMER_IDENTITY_FIELDS_DENIED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_identity_fields_guard BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION protect_customer_identity_fields();

CREATE FUNCTION protect_customer_session_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_audience()='customer' AND
    ((to_jsonb(NEW)-'revoked_at') IS DISTINCT FROM (to_jsonb(OLD)-'revoked_at')
      OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)) THEN
    RAISE EXCEPTION 'CUSTOMER_SESSION_FIELDS_DENIED' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER customer_session_fields_guard BEFORE UPDATE ON auth_sessions
  FOR EACH ROW EXECUTE FUNCTION protect_customer_session_fields();

CREATE POLICY customer_no_identity_insert ON usuarios AS RESTRICTIVE FOR INSERT
  WITH CHECK(app_current_audience()<>'customer');
CREATE POLICY customer_no_identity_delete ON usuarios AS RESTRICTIVE FOR DELETE
  USING(app_current_audience()<>'customer');
CREATE POLICY customer_no_session_insert ON auth_sessions AS RESTRICTIVE FOR INSERT
  WITH CHECK(app_current_audience()<>'customer');
CREATE POLICY customer_no_session_delete ON auth_sessions AS RESTRICTIVE FOR DELETE
  USING(app_current_audience()<>'customer');

CREATE POLICY customer_identity_boundary ON usuarios AS RESTRICTIVE
  USING (app_current_audience()<>'customer' OR
    (id=app_current_usuario_id() AND status='ativo' AND deleted_at IS NULL))
  WITH CHECK (app_current_audience()<>'customer' OR
    (id=app_current_usuario_id() AND status='ativo' AND deleted_at IS NULL));

CREATE POLICY customer_session_boundary ON auth_sessions AS RESTRICTIVE
  USING (app_current_audience()<>'customer' OR
    (audience='customer' AND usuario_id=app_current_usuario_id()
      AND EXISTS(SELECT 1 FROM usuarios u WHERE u.id=auth_sessions.usuario_id AND u.status='ativo' AND u.deleted_at IS NULL)))
  WITH CHECK (app_current_audience()<>'customer' OR
    (audience='customer' AND usuario_id=app_current_usuario_id()));

CREATE POLICY customer_membership_read ON usuarios_empresas AS RESTRICTIVE FOR SELECT
  USING (app_current_audience()<>'customer' OR
    (usuario_id=app_current_usuario_id() AND status='ativo'));
CREATE POLICY customer_company_read ON empresas AS RESTRICTIVE FOR SELECT
  USING (app_current_audience()<>'customer' OR
    (deleted_at IS NULL AND EXISTS(SELECT 1 FROM usuarios_empresas m
      WHERE m.empresa_id=empresas.id AND m.usuario_id=app_current_usuario_id() AND m.status='ativo')
      AND EXISTS(SELECT 1 FROM usuarios u WHERE u.id=app_current_usuario_id() AND u.status='ativo' AND u.deleted_at IS NULL)));

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY['empresas','usuarios_empresas'] LOOP
    EXECUTE format('CREATE POLICY customer_no_insert ON %I AS RESTRICTIVE FOR INSERT WITH CHECK(app_current_audience()<>''customer'')',target);
    EXECUTE format('CREATE POLICY customer_no_update ON %I AS RESTRICTIVE FOR UPDATE USING(app_current_audience()<>''customer'') WITH CHECK(app_current_audience()<>''customer'')',target);
    EXECUTE format('CREATE POLICY customer_no_delete ON %I AS RESTRICTIVE FOR DELETE USING(app_current_audience()<>''customer'')',target);
  END LOOP;
  -- M1 exposes only identities and company summaries. Future customer resources
  -- require an explicit policy review in their own authorized phase.
  FOR target IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relrowsecurity
      AND c.relname NOT IN ('usuarios','auth_sessions','empresas','usuarios_empresas','account_audit') LOOP
    EXECUTE format('CREATE POLICY customer_resource_denied ON %I AS RESTRICTIVE USING(app_current_audience()<>''customer'') WITH CHECK(app_current_audience()<>''customer'')',target);
  END LOOP;
END $$;

CREATE POLICY customer_audit_boundary ON account_audit AS RESTRICTIVE
  USING (app_current_audience()<>'customer' OR
    (usuario_id=app_current_usuario_id() AND empresa_id IS NULL
      AND action IN ('account.profile.changed','account.logout')))
  WITH CHECK (app_current_audience()<>'customer' OR
    (usuario_id=app_current_usuario_id() AND empresa_id IS NULL
      AND action IN ('account.profile.changed','account.logout')));
