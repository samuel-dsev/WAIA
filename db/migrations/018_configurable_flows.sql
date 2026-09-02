-- O runner aplica cada migracao em uma transacao propria. O contexto de
-- plataforma permite criar as estruturas sem enfraquecer FORCE RLS.
SELECT set_config('app.is_platform_admin', 'true', true);

CREATE OR REPLACE FUNCTION flow_json_has_forbidden_key(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  item record;
  child jsonb;
BEGIN
  IF jsonb_typeof(document) = 'object' THEN
    FOR item IN SELECT key, value FROM jsonb_each(document)
    LOOP
      IF regexp_replace(lower(item.key), '[^a-z0-9]', '', 'g')
           ~ '(password|secret|token|apikey|privatekey|credential)'
         OR flow_json_has_forbidden_key(item.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(document)
    LOOP
      IF flow_json_has_forbidden_key(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

CREATE TABLE fluxos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  flow_key text NOT NULL CHECK (flow_key ~ '^[a-z][a-z0-9._-]{0,79}$'),
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'ativo', 'inativo', 'arquivado')),
  ativa_versao_id uuid,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (empresa_id, id),
  UNIQUE (empresa_id, flow_key),
  CHECK (
    (status = 'ativo' AND ativa_versao_id IS NOT NULL AND deleted_at IS NULL)
    OR status <> 'ativo'
  )
);

CREATE TABLE fluxo_versoes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  fluxo_id uuid NOT NULL,
  versao integer NOT NULL CHECK (versao > 0),
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  checksum_algorithm text NOT NULL DEFAULT 'sha256' CHECK (checksum_algorithm = 'sha256'),
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  definicao jsonb NOT NULL,
  publicada_por uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  publicada_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, id),
  UNIQUE (empresa_id, fluxo_id, versao),
  UNIQUE (empresa_id, id, fluxo_id, versao),
  FOREIGN KEY (empresa_id, fluxo_id)
    REFERENCES fluxos(empresa_id, id) ON DELETE CASCADE,
  CONSTRAINT fluxo_versoes_definicao_ck CHECK (
    jsonb_typeof(definicao) = 'object'
    AND octet_length(definicao::text) <= 1048576
    AND definicao ->> 'version' = versao::text
    AND NOT flow_json_has_forbidden_key(definicao)
  )
);

CREATE TABLE configuracoes_fluxos_publicados (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  config_version bigint NOT NULL CHECK (config_version > 0),
  fluxo_id uuid NOT NULL,
  fluxo_versao_id uuid NOT NULL,
  vinculada_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, config_version, fluxo_id),
  UNIQUE (empresa_id, config_version, fluxo_versao_id),
  UNIQUE (empresa_id, config_version, fluxo_id, fluxo_versao_id),
  FOREIGN KEY (empresa_id, config_version)
    REFERENCES configuracoes_revisoes(empresa_id, config_version) ON DELETE CASCADE,
  FOREIGN KEY (empresa_id, fluxo_versao_id)
    REFERENCES fluxo_versoes(empresa_id, id) ON DELETE CASCADE,
  FOREIGN KEY (empresa_id, fluxo_id)
    REFERENCES fluxos(empresa_id, id) ON DELETE CASCADE
);

ALTER TABLE fluxos
  ADD CONSTRAINT fluxos_ativa_versao_fkey
    FOREIGN KEY (empresa_id, ativa_versao_id)
    REFERENCES fluxo_versoes(empresa_id, id)
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE fluxo_submissoes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  fluxo_id uuid NOT NULL,
  fluxo_versao_id uuid NOT NULL,
  versao_fluxo integer NOT NULL CHECK (versao_fluxo > 0),
  config_version bigint NOT NULL CHECK (config_version > 0),
  conversa_id uuid,
  contato_id uuid,
  status text NOT NULL DEFAULT 'em_andamento'
    CHECK (status IN ('em_andamento', 'aguardando', 'concluida', 'cancelada', 'handoff', 'falha')),
  passo_atual_key text,
  dados_coletados jsonb NOT NULL DEFAULT '{}'::jsonb,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  iniciada_at timestamptz NOT NULL DEFAULT now(),
  finalizada_at timestamptz,
  expires_at timestamptz NOT NULL,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, id),
  FOREIGN KEY (empresa_id, fluxo_versao_id, fluxo_id, versao_fluxo)
    REFERENCES fluxo_versoes(empresa_id, id, fluxo_id, versao) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, config_version, fluxo_id, fluxo_versao_id)
    REFERENCES configuracoes_fluxos_publicados(empresa_id, config_version, fluxo_id, fluxo_versao_id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, conversa_id)
    REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, contato_id)
    REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fluxo_submissoes_dados_ck CHECK (
    jsonb_typeof(dados_coletados) = 'object'
    AND octet_length(dados_coletados::text) <= 524288
  ),
  CONSTRAINT fluxo_submissoes_terminal_ck CHECK (
    (status IN ('em_andamento', 'aguardando') AND finalizada_at IS NULL)
    OR (status IN ('concluida', 'cancelada', 'handoff', 'falha') AND finalizada_at IS NOT NULL)
  ),
  CONSTRAINT fluxo_submissoes_retencao_ck CHECK (
    expires_at > iniciada_at
    AND (
      (anonymized_at IS NULL AND conversa_id IS NOT NULL AND contato_id IS NOT NULL)
      OR
      (anonymized_at IS NOT NULL AND conversa_id IS NULL AND contato_id IS NULL
        AND dados_coletados = '{}'::jsonb AND passo_atual_key IS NULL)
    )
  )
);

CREATE TABLE fluxo_documentos (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE CASCADE,
  submissao_id uuid NOT NULL,
  mensagem_id uuid,
  campo_key text NOT NULL CHECK (campo_key ~ '^[a-z][a-z0-9._-]{0,79}$'),
  storage_key text,
  mime_type text,
  size_bytes bigint,
  sha256 text,
  status text NOT NULL DEFAULT 'armazenado'
    CHECK (status IN ('armazenado', 'anonimizado')),
  expires_at timestamptz NOT NULL,
  anonymized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, id),
  UNIQUE (empresa_id, submissao_id, id),
  FOREIGN KEY (empresa_id, submissao_id)
    REFERENCES fluxo_submissoes(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, mensagem_id)
    REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT,
  CONSTRAINT fluxo_documentos_metadata_ck CHECK (
    (status = 'armazenado'
      AND storage_key IS NOT NULL AND length(storage_key) BETWEEN 1 AND 1024
      AND mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      AND size_bytes BETWEEN 1 AND 10485760
      AND sha256 ~ '^[a-f0-9]{64}$'
      AND anonymized_at IS NULL)
    OR
    (status = 'anonimizado'
      AND storage_key IS NULL AND mime_type IS NULL AND size_bytes IS NULL
      AND sha256 IS NULL AND mensagem_id IS NULL AND anonymized_at IS NOT NULL)
  )
);

CREATE INDEX fluxos_empresa_status_idx
  ON fluxos (empresa_id, status, flow_key, id) WHERE deleted_at IS NULL;
CREATE INDEX fluxo_versoes_empresa_fluxo_idx
  ON fluxo_versoes (empresa_id, fluxo_id, versao DESC, id);
CREATE INDEX configuracoes_fluxos_empresa_config_idx
  ON configuracoes_fluxos_publicados (empresa_id, config_version, fluxo_id, fluxo_versao_id);
CREATE INDEX fluxo_submissoes_empresa_conversa_idx
  ON fluxo_submissoes (empresa_id, conversa_id, status, updated_at DESC, id)
  WHERE conversa_id IS NOT NULL;
CREATE UNIQUE INDEX fluxo_submissoes_conversa_aberta_uq
  ON fluxo_submissoes (empresa_id, conversa_id)
  WHERE status IN ('em_andamento', 'aguardando') AND anonymized_at IS NULL;
CREATE INDEX fluxo_submissoes_empresa_retencao_idx
  ON fluxo_submissoes (empresa_id, expires_at, id)
  WHERE anonymized_at IS NULL AND status IN ('concluida', 'cancelada', 'handoff', 'falha');
CREATE INDEX fluxo_documentos_empresa_retencao_idx
  ON fluxo_documentos (empresa_id, expires_at, id) WHERE anonymized_at IS NULL;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'fluxos', 'fluxo_versoes', 'configuracoes_fluxos_publicados',
    'fluxo_submissoes', 'fluxo_documentos'
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

CREATE TRIGGER fluxos_set_updated_at
  BEFORE UPDATE ON fluxos
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER fluxo_submissoes_set_updated_at
  BEFORE UPDATE ON fluxo_submissoes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION protect_flow_submission_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.fluxo_id, NEW.fluxo_versao_id, NEW.versao_fluxo, NEW.config_version)
       IS DISTINCT FROM
     (OLD.fluxo_id, OLD.fluxo_versao_id, OLD.versao_fluxo, OLD.config_version) THEN
    RAISE EXCEPTION 'A pinagem da submissao de fluxo e imutavel.' USING ERRCODE = '55000';
  END IF;

  IF OLD.status IN ('concluida', 'cancelada', 'handoff', 'falha') THEN
    IF NEW.status IS DISTINCT FROM OLD.status OR OLD.anonymized_at IS NOT NULL THEN
      RAISE EXCEPTION 'Submissoes terminais de fluxo nao podem ser reabertas.' USING ERRCODE = '55000';
    END IF;
    IF NEW.anonymized_at IS NULL
       OR NEW.conversa_id IS NOT NULL OR NEW.contato_id IS NOT NULL
       OR NEW.passo_atual_key IS NOT NULL OR NEW.dados_coletados <> '{}'::jsonb THEN
      RAISE EXCEPTION 'Submissoes terminais aceitam somente anonimizacao.' USING ERRCODE = '55000';
    END IF;
    IF (NEW.iniciada_at, NEW.finalizada_at, NEW.expires_at)
         IS DISTINCT FROM
       (OLD.iniciada_at, OLD.finalizada_at, OLD.expires_at)
       OR NEW.revision <> OLD.revision + 1 THEN
      RAISE EXCEPTION 'A trilha minima da submissao deve ser preservada.' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fluxo_submissoes_protect_state
  BEFORE UPDATE ON fluxo_submissoes
  FOR EACH ROW EXECUTE FUNCTION protect_flow_submission_state();

CREATE OR REPLACE FUNCTION protect_flow_document_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.empresa_id, NEW.id, NEW.submissao_id, NEW.campo_key, NEW.expires_at, NEW.created_at)
       IS DISTINCT FROM
     (OLD.empresa_id, OLD.id, OLD.submissao_id, OLD.campo_key, OLD.expires_at, OLD.created_at) THEN
    RAISE EXCEPTION 'A trilha minima do documento deve ser preservada.' USING ERRCODE = '55000';
  END IF;
  IF OLD.status <> 'armazenado' OR NEW.status <> 'anonimizado'
     OR NEW.storage_key IS NOT NULL OR NEW.mime_type IS NOT NULL
     OR NEW.size_bytes IS NOT NULL OR NEW.sha256 IS NOT NULL
     OR NEW.mensagem_id IS NOT NULL OR NEW.anonymized_at IS NULL THEN
    RAISE EXCEPTION 'Documentos de fluxo aceitam somente anonimizacao.' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER fluxo_documentos_protect_state
  BEFORE UPDATE ON fluxo_documentos
  FOR EACH ROW EXECUTE FUNCTION protect_flow_document_state();

CREATE OR REPLACE FUNCTION protect_flow_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (
    SELECT 1 FROM empresas WHERE id = OLD.empresa_id
  ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Versoes, vinculos e execucoes de fluxo nao podem ser removidos.'
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER fluxo_versoes_append_only
  BEFORE UPDATE OR DELETE ON fluxo_versoes
  FOR EACH ROW EXECUTE FUNCTION protect_flow_append_only();
CREATE TRIGGER configuracoes_fluxos_publicados_append_only
  BEFORE UPDATE OR DELETE ON configuracoes_fluxos_publicados
  FOR EACH ROW EXECUTE FUNCTION protect_flow_append_only();
CREATE TRIGGER fluxo_submissoes_no_delete
  BEFORE DELETE ON fluxo_submissoes
  FOR EACH ROW EXECUTE FUNCTION protect_flow_append_only();
CREATE TRIGGER fluxo_documentos_no_delete
  BEFORE DELETE ON fluxo_documentos
  FOR EACH ROW EXECUTE FUNCTION protect_flow_append_only();

COMMENT ON TABLE fluxos IS
  'Identidade estavel do fluxo tenant-scoped; nenhuma definicao executavel e sobrescrita.';
COMMENT ON TABLE fluxo_versoes IS
  'Definicoes declarativas imutaveis e sem segredos, identificadas por UUID opaco.';
COMMENT ON TABLE configuracoes_fluxos_publicados IS
  'Materializa quais versoes imutaveis pertencem a cada revisao publicada do tenant.';
COMMENT ON TABLE fluxo_submissoes IS
  'Execucao pinada a flow version e config version ate atingir estado terminal.';
COMMENT ON TABLE fluxo_documentos IS
  'Metadados de documentos da submissao; retencao remove a chave antes de preservar a trilha minima.';
COMMENT ON COLUMN fluxo_versoes.publicada_por IS
  'Ator global; administradores de plataforma podem nao possuir membership no tenant.';
