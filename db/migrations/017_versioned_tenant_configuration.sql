-- A tabela empresas ja usa FORCE RLS. O runner aplica cada migracao dentro de
-- uma transacao propria, portanto este contexto privilegiado permanece local.
SELECT set_config('app.is_platform_admin', 'true', true);

CREATE TABLE onboarding_progressos (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  schema_version smallint NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  etapa_atual smallint NOT NULL DEFAULT 1 CHECK (etapa_atual BETWEEN 1 AND 10),
  progresso jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_progressos_json_ck CHECK (
    jsonb_typeof(progresso) = 'object'
    AND octet_length(progresso::text) <= 262144
  )
);

CREATE TABLE configuracoes_rascunho (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE CASCADE,
  draft_version bigint NOT NULL DEFAULT 1 CHECK (draft_version > 0),
  schema_version smallint NOT NULL DEFAULT 2 CHECK (schema_version = 2),
  configuracao jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT configuracoes_rascunho_json_ck CHECK (
    jsonb_typeof(configuracao) = 'object'
    AND octet_length(configuracao::text) <= 1048576
  )
);

CREATE TABLE configuracoes_revisoes (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  config_version bigint NOT NULL CHECK (config_version > 0),
  schema_version smallint NOT NULL CHECK (schema_version = 2),
  compiler_version integer NOT NULL CHECK (compiler_version > 0),
  source_draft_version bigint NOT NULL CHECK (source_draft_version > 0),
  checksum_algorithm text NOT NULL DEFAULT 'sha256' CHECK (checksum_algorithm = 'sha256'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  configuracao_compilada jsonb NOT NULL,
  publicada_por uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  publicada_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, config_version),
  UNIQUE (empresa_id, checksum),
  CONSTRAINT configuracoes_revisoes_envelope_ck CHECK (
    jsonb_typeof(configuracao_compilada) = 'object'
    AND octet_length(configuracao_compilada::text) <= 1048576
    AND configuracao_compilada ->> 'kind' = 'TenantRuntimeConfigV2'
    AND jsonb_typeof(configuracao_compilada -> 'schemaVersion') = 'number'
    AND configuracao_compilada ->> 'schemaVersion' = schema_version::text
    AND jsonb_typeof(configuracao_compilada -> 'compilerVersion') = 'number'
    AND configuracao_compilada ->> 'compilerVersion' = compiler_version::text
    AND configuracao_compilada ->> 'empresaId' = empresa_id::text
    AND jsonb_typeof(configuracao_compilada -> 'configVersion') = 'number'
    AND configuracao_compilada ->> 'configVersion' = config_version::text
    AND jsonb_typeof(configuracao_compilada -> 'draftVersion') = 'number'
    AND configuracao_compilada ->> 'draftVersion' = source_draft_version::text
    AND configuracao_compilada ->> 'checksumAlgorithm' = checksum_algorithm
    AND configuracao_compilada ->> 'checksum' = checksum
    AND jsonb_typeof(configuracao_compilada -> 'configuration') = 'object'
  )
);

CREATE INDEX onboarding_progressos_empresa_etapa_idx
  ON onboarding_progressos (empresa_id, etapa_atual, updated_at DESC);

CREATE INDEX configuracoes_rascunho_empresa_versao_idx
  ON configuracoes_rascunho (empresa_id, draft_version, updated_at DESC);

CREATE INDEX configuracoes_revisoes_empresa_publicacao_idx
  ON configuracoes_revisoes (empresa_id, publicada_at DESC, config_version DESC);

ALTER TABLE empresas
  ADD COLUMN configuracao_runtime_modo text,
  ADD COLUMN configuracao_ativa_versao bigint;

UPDATE empresas
SET configuracao_runtime_modo = 'legado'
WHERE configuracao_runtime_modo IS NULL;

ALTER TABLE empresas
  ALTER COLUMN configuracao_runtime_modo SET DEFAULT 'versionado',
  ALTER COLUMN configuracao_runtime_modo SET NOT NULL,
  ADD CONSTRAINT empresas_configuracao_runtime_modo_ck CHECK (
    configuracao_runtime_modo IN ('legado', 'versionado')
  ),
  ADD CONSTRAINT empresas_configuracao_ativa_modo_ck CHECK (
    (configuracao_runtime_modo = 'legado' AND configuracao_ativa_versao IS NULL)
    OR
    configuracao_runtime_modo = 'versionado'
  ),
  ADD CONSTRAINT empresas_configuracao_ativa_fkey
    FOREIGN KEY (id, configuracao_ativa_versao)
    REFERENCES configuracoes_revisoes (empresa_id, config_version)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX empresas_configuracao_runtime_idx
  ON empresas (configuracao_runtime_modo, status, id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'onboarding_progressos',
    'configuracoes_rascunho',
    'configuracoes_revisoes'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin()) WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin())',
      table_name
    );
  END LOOP;
END;
$$;

CREATE TRIGGER onboarding_progressos_set_updated_at
  BEFORE UPDATE ON onboarding_progressos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER configuracoes_rascunho_set_updated_at
  BEFORE UPDATE ON configuracoes_rascunho
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION protect_configuracoes_revisoes_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM empresas WHERE id = OLD.empresa_id
  ) THEN
    -- A exclusão em cascata do tenant precisa poder limpar sua revisão imutável.
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Revisoes publicadas de configuracao sao imutaveis.'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER configuracoes_revisoes_append_only
  BEFORE UPDATE OR DELETE ON configuracoes_revisoes
  FOR EACH ROW EXECUTE FUNCTION protect_configuracoes_revisoes_append_only();

COMMENT ON COLUMN empresas.configuracao_runtime_modo IS
  'Tenants anteriores a migracao permanecem em legado; novos tenants usam versionado e o loader falha fechado enquanto nao houver revisao ativa.';
COMMENT ON TABLE onboarding_progressos IS
  'Estado mutavel e tenant-scoped do wizard, sem credenciais ou segredos.';
COMMENT ON TABLE configuracoes_rascunho IS
  'Configuracao incompleta e mutavel protegida por draft_version otimista.';
COMMENT ON TABLE configuracoes_revisoes IS
  'Envelope compilado, publicado e append-only; o runtime executa somente a revisao ativa.';
COMMENT ON COLUMN onboarding_progressos.updated_by IS
  'Ator global: referencia usuarios porque administradores de plataforma podem nao possuir membership no tenant.';
COMMENT ON COLUMN configuracoes_rascunho.created_by IS
  'Ator global: referencia usuarios porque administradores de plataforma podem nao possuir membership no tenant.';
COMMENT ON COLUMN configuracoes_rascunho.updated_by IS
  'Ator global: referencia usuarios porque administradores de plataforma podem nao possuir membership no tenant.';
COMMENT ON COLUMN configuracoes_revisoes.publicada_por IS
  'Ator global: referencia usuarios porque administradores de plataforma podem nao possuir membership no tenant.';
