-- M2: provisionamento exclusivo do administrador, sem importar identidades.
ALTER TABLE usuarios ADD COLUMN activation_required boolean NOT NULL DEFAULT false,
  ADD COLUMN access_version bigint NOT NULL DEFAULT 1 CHECK(access_version>0);
ALTER TABLE account_tokens DROP CONSTRAINT account_tokens_purpose_check;
ALTER TABLE account_tokens ADD CONSTRAINT account_tokens_purpose_check
  CHECK(purpose IN ('verify','reset','activate'));

CREATE TABLE access_admin_requests (
  actor_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 16 AND 100),
  operation text NOT NULL,
  payload_hash char(64) NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
  PRIMARY KEY(actor_id,request_key,operation)
);
ALTER TABLE access_admin_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_admin_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY service_access ON access_admin_requests USING(app_is_platform_admin()) WITH CHECK(app_is_platform_admin());
CREATE POLICY customer_resource_denied ON access_admin_requests AS RESTRICTIVE
  USING(app_current_audience()<>'customer') WITH CHECK(app_current_audience()<>'customer');

ALTER POLICY customer_identity_boundary ON usuarios
  USING(app_current_audience()<>'customer' OR
    (id=app_current_usuario_id() AND status='ativo' AND deleted_at IS NULL AND NOT activation_required))
  WITH CHECK(app_current_audience()<>'customer' OR
    (id=app_current_usuario_id() AND status='ativo' AND deleted_at IS NULL AND NOT activation_required));

CREATE FUNCTION enforce_activated_session_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NULL AND EXISTS(SELECT 1 FROM usuarios u WHERE u.id=NEW.usuario_id AND u.activation_required) THEN
    RAISE EXCEPTION 'IDENTITY_ACTIVATION_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activated_session_identity_guard BEFORE INSERT OR UPDATE OF usuario_id,audience,security_version,revoked_at
  ON auth_sessions FOR EACH ROW EXECUTE FUNCTION enforce_activated_session_identity();
