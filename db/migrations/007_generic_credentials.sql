CREATE TABLE credenciais_empresa (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  provedor text NOT NULL CHECK (length(btrim(provedor)) BETWEEN 1 AND 80),
  finalidade text NOT NULL CHECK (length(btrim(finalidade)) BETWEEN 1 AND 120),
  secret_ciphertext bytea,
  secret_kdf_salt bytea,
  secret_nonce bytea,
  secret_tag bytea,
  key_version text NOT NULL,
  valor_mascarado text NOT NULL,
  secret_version integer NOT NULL DEFAULT 1 CHECK (secret_version > 0),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'revogada')),
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  CHECK (
    (status = 'revogada' AND secret_ciphertext IS NULL AND secret_kdf_salt IS NULL AND secret_nonce IS NULL AND secret_tag IS NULL)
    OR
    (status = 'ativa' AND secret_ciphertext IS NOT NULL AND secret_kdf_salt IS NOT NULL AND secret_nonce IS NOT NULL AND secret_tag IS NOT NULL)
  )
);

CREATE INDEX credenciais_empresa_metadata_idx
  ON credenciais_empresa (empresa_id, provedor, finalidade, status, created_at DESC, id);

ALTER TABLE credenciais_empresa ENABLE ROW LEVEL SECURITY;
ALTER TABLE credenciais_empresa FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON credenciais_empresa
  USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin());

CREATE TRIGGER credenciais_empresa_set_updated_at
  BEFORE UPDATE ON credenciais_empresa FOR EACH ROW EXECUTE FUNCTION set_updated_at();
