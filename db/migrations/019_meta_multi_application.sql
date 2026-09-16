-- O runner executa cada migracao em transacao propria; o contexto privilegiado
-- permanece local e permite criar estruturas protegidas por FORCE RLS.
SELECT set_config('app.is_platform_admin', 'true', true);

CREATE TABLE aplicativos_meta (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
  app_id text NOT NULL CHECK (length(btrim(app_id)) BETWEEN 1 AND 120),
  modo text NOT NULL DEFAULT 'proprio'
    CHECK (modo IN ('compartilhado', 'proprio')),
  webhook_public_id uuid NOT NULL DEFAULT gen_random_uuid(),
  estado text NOT NULL DEFAULT 'pendente'
    CHECK (estado IN ('pendente', 'ativo', 'inativo', 'falha', 'revogado')),
  app_secret_credencial_id uuid,
  app_secret_anterior_credencial_id uuid,
  app_secret_rotacionado_at timestamptz,
  app_secret_anterior_valido_ate timestamptz,
  verify_token_credencial_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  ultimo_teste_at timestamptz,
  ultimo_webhook_valido_at timestamptz,
  ultimo_erro_sanitizado text
    CHECK (ultimo_erro_sanitizado IS NULL OR length(ultimo_erro_sanitizado) BETWEEN 1 AND 1000),
  ultimo_erro_expires_at timestamptz,
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (empresa_id, id),
  UNIQUE (webhook_public_id),
  FOREIGN KEY (empresa_id, app_secret_credencial_id)
    REFERENCES credenciais_empresa(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, app_secret_anterior_credencial_id)
    REFERENCES credenciais_empresa(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, verify_token_credencial_id)
    REFERENCES credenciais_empresa(empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT aplicativos_meta_rotacao_ck CHECK (
    (app_secret_anterior_credencial_id IS NULL
      AND app_secret_rotacionado_at IS NULL
      AND app_secret_anterior_valido_ate IS NULL)
    OR
    (app_secret_anterior_credencial_id IS NOT NULL
      AND app_secret_rotacionado_at IS NOT NULL
      AND app_secret_anterior_valido_ate IS NOT NULL
      AND app_secret_anterior_valido_ate > app_secret_rotacionado_at)
  ),
  CONSTRAINT aplicativos_meta_modo_credenciais_ck CHECK (
    (modo = 'compartilhado'
      AND app_secret_credencial_id IS NULL
      AND app_secret_anterior_credencial_id IS NULL
      AND app_secret_rotacionado_at IS NULL
      AND app_secret_anterior_valido_ate IS NULL
      AND verify_token_credencial_id IS NULL)
    OR
    (modo = 'proprio')
  ),
  CONSTRAINT aplicativos_meta_ativacao_ck CHECK (
    estado <> 'ativo'
    OR modo = 'compartilhado'
    OR (app_secret_credencial_id IS NOT NULL AND verify_token_credencial_id IS NOT NULL)
  ),
  CONSTRAINT aplicativos_meta_erro_retencao_ck CHECK (
    (ultimo_erro_sanitizado IS NULL AND ultimo_erro_expires_at IS NULL)
    OR
    (ultimo_erro_sanitizado IS NOT NULL AND ultimo_erro_expires_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX aplicativos_meta_empresa_app_ativo_uq
  ON aplicativos_meta (empresa_id, app_id)
  WHERE deleted_at IS NULL AND estado <> 'revogado';
CREATE INDEX aplicativos_meta_empresa_estado_idx
  ON aplicativos_meta (empresa_id, estado, updated_at DESC, id)
  WHERE deleted_at IS NULL;
CREATE INDEX aplicativos_meta_empresa_erro_retencao_idx
  ON aplicativos_meta (empresa_id, ultimo_erro_expires_at, id)
  WHERE ultimo_erro_sanitizado IS NOT NULL;

ALTER TABLE numeros_whatsapp
  ADD COLUMN aplicativo_meta_id uuid,
  ADD COLUMN access_token_credencial_id uuid,
  ADD COLUMN meta_binding_revision bigint NOT NULL DEFAULT 1
    CHECK (meta_binding_revision > 0),
  ADD CONSTRAINT numeros_whatsapp_aplicativo_meta_fkey
    FOREIGN KEY (empresa_id, aplicativo_meta_id)
    REFERENCES aplicativos_meta(empresa_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT numeros_whatsapp_access_token_credencial_fkey
    FOREIGN KEY (empresa_id, access_token_credencial_id)
    REFERENCES credenciais_empresa(empresa_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT numeros_whatsapp_meta_binding_ck CHECK (
    (aplicativo_meta_id IS NULL AND access_token_credencial_id IS NULL)
    OR
    (aplicativo_meta_id IS NOT NULL AND access_token_credencial_id IS NOT NULL)
  );

CREATE INDEX numeros_whatsapp_empresa_aplicativo_idx
  ON numeros_whatsapp (empresa_id, aplicativo_meta_id, status, id)
  WHERE aplicativo_meta_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX numeros_whatsapp_empresa_access_token_idx
  ON numeros_whatsapp (empresa_id, access_token_credencial_id, id)
  WHERE access_token_credencial_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE aplicativos_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE aplicativos_meta FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON aplicativos_meta
  USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin());

CREATE TRIGGER aplicativos_meta_set_updated_at
  BEFORE UPDATE ON aplicativos_meta
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE aplicativos_meta IS
  'Aplicativos Meta tenant-scoped; armazena somente referencias ao cofre, nunca segredos.';
COMMENT ON COLUMN aplicativos_meta.webhook_public_id IS
  'Identificador UUID aleatorio e opaco usado para resolver o callback antes do contexto tenant.';
COMMENT ON COLUMN aplicativos_meta.modo IS
  'Compartilhado usa credenciais da infraestrutura; proprio exige referencias tenant-scoped para ativacao.';
COMMENT ON COLUMN aplicativos_meta.ultimo_erro_sanitizado IS
  'Somente diagnostico redigido e temporario; nunca corpo de resposta, token, assinatura ou credencial.';
COMMENT ON COLUMN numeros_whatsapp.aplicativo_meta_id IS
  'Vinculo explicito tenant-scoped entre o numero e o aplicativo que recebe seus webhooks.';
COMMENT ON COLUMN numeros_whatsapp.access_token_credencial_id IS
  'Referencia tenant-scoped ao access token usado no envio; o segredo permanece no cofre.';
