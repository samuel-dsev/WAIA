CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE empresas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug citext NOT NULL UNIQUE,
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 160),
  nome_exibicao text NOT NULL CHECK (length(btrim(nome_exibicao)) BETWEEN 2 AND 160),
  identidade text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  locale text NOT NULL DEFAULT 'pt-BR',
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'ativa', 'suspensa', 'arquivada')),
  versao_configuracao bigint NOT NULL DEFAULT 1 CHECK (versao_configuracao > 0),
  retencao_mensagens_dias integer NOT NULL DEFAULT 365
    CHECK (retencao_mensagens_dias BETWEEN 1 AND 3650),
  retencao_logs_dias integer NOT NULL DEFAULT 90
    CHECK (retencao_logs_dias BETWEEN 1 AND 3650),
  publicada_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE INDEX empresas_status_idx ON empresas (status, created_at DESC, id);

CREATE TABLE usuarios (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 2 AND 160),
  password_hash text NOT NULL,
  papel_plataforma text NOT NULL DEFAULT 'nenhum'
    CHECK (papel_plataforma IN ('nenhum', 'administrador')),
  status text NOT NULL DEFAULT 'ativo'
    CHECK (status IN ('ativo', 'bloqueado', 'desativado')),
  mfa_habilitado boolean NOT NULL DEFAULT false,
  mfa_secret_ciphertext bytea,
  mfa_secret_nonce bytea,
  mfa_secret_tag bytea,
  mfa_key_version integer,
  ultimo_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CHECK (
    (mfa_secret_ciphertext IS NULL AND mfa_secret_nonce IS NULL AND mfa_secret_tag IS NULL AND mfa_key_version IS NULL)
    OR
    (mfa_secret_ciphertext IS NOT NULL AND mfa_secret_nonce IS NOT NULL AND mfa_secret_tag IS NOT NULL AND mfa_key_version > 0)
  )
);

CREATE TABLE usuarios_empresas (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  papel text NOT NULL CHECK (papel IN ('administrador', 'operador')),
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'suspenso')),
  permissoes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, usuario_id)
);

CREATE INDEX usuarios_empresas_usuario_idx ON usuarios_empresas (usuario_id, empresa_id);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  ip inet,
  user_agent text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX auth_sessions_usuario_idx ON auth_sessions (usuario_id, expires_at DESC);

CREATE TABLE numeros_whatsapp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  phone_number_id text NOT NULL UNIQUE CHECK (length(btrim(phone_number_id)) > 0),
  waba_id text,
  numero_e164 text CHECK (numero_e164 IS NULL OR numero_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  numero_mascarado text,
  nome_verificado text,
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'ativo', 'inativo', 'falha', 'revogado')),
  principal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id)
);

CREATE UNIQUE INDEX numeros_whatsapp_empresa_e164_ativo_uq
  ON numeros_whatsapp (empresa_id, numero_e164)
  WHERE deleted_at IS NULL AND numero_e164 IS NOT NULL;
CREATE UNIQUE INDEX numeros_whatsapp_principal_ativo_uq
  ON numeros_whatsapp (empresa_id)
  WHERE principal AND status = 'ativo' AND deleted_at IS NULL;
CREATE INDEX numeros_whatsapp_empresa_status_idx
  ON numeros_whatsapp (empresa_id, status, created_at DESC, id);

CREATE TABLE credenciais_meta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  numero_whatsapp_id uuid NOT NULL,
  app_id text,
  access_token_ciphertext bytea NOT NULL,
  access_token_nonce bytea NOT NULL,
  access_token_tag bytea NOT NULL,
  app_secret_ciphertext bytea,
  app_secret_nonce bytea,
  app_secret_tag bytea,
  key_version integer NOT NULL CHECK (key_version > 0),
  fingerprint text NOT NULL,
  valor_mascarado text NOT NULL,
  status text NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa', 'expirada', 'revogada', 'rotacionada')),
  expires_at timestamptz,
  rotated_from_id uuid,
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, numero_whatsapp_id)
    REFERENCES numeros_whatsapp(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (rotated_from_id) REFERENCES credenciais_meta(id) ON DELETE RESTRICT,
  CHECK (
    (app_secret_ciphertext IS NULL AND app_secret_nonce IS NULL AND app_secret_tag IS NULL)
    OR
    (app_secret_ciphertext IS NOT NULL AND app_secret_nonce IS NOT NULL AND app_secret_tag IS NOT NULL)
  )
);

CREATE UNIQUE INDEX credenciais_meta_ativa_numero_uq
  ON credenciais_meta (empresa_id, numero_whatsapp_id)
  WHERE status = 'ativa' AND revoked_at IS NULL;

CREATE TABLE credenciais_openai (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  api_key_ciphertext bytea NOT NULL,
  api_key_nonce bytea NOT NULL,
  api_key_tag bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  fingerprint text NOT NULL,
  valor_mascarado text NOT NULL,
  status text NOT NULL DEFAULT 'ativa'
    CHECK (status IN ('ativa', 'revogada', 'rotacionada')),
  rotated_from_id uuid REFERENCES credenciais_openai(id) ON DELETE RESTRICT,
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);

CREATE UNIQUE INDEX credenciais_openai_ativa_empresa_uq
  ON credenciais_openai (empresa_id)
  WHERE status = 'ativa' AND revoked_at IS NULL;

CREATE TABLE configuracoes_ia (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  habilitada boolean NOT NULL DEFAULT false,
  provedor text NOT NULL DEFAULT 'openai' CHECK (provedor IN ('openai', 'simulado')),
  modelo text NOT NULL DEFAULT 'gpt-4.1-mini',
  prompt text NOT NULL DEFAULT '',
  personalidade text NOT NULL DEFAULT '',
  tipo_chave text NOT NULL DEFAULT 'compartilhada'
    CHECK (tipo_chave IN ('compartilhada', 'propria')),
  credencial_propria_id uuid,
  limite_tokens_mensal bigint CHECK (limite_tokens_mensal IS NULL OR limite_tokens_mensal > 0),
  limite_custo_mensal numeric(14, 6) CHECK (limite_custo_mensal IS NULL OR limite_custo_mensal >= 0),
  alerta_percentual smallint NOT NULL DEFAULT 80 CHECK (alerta_percentual BETWEEN 1 AND 100),
  max_historico_mensagens smallint NOT NULL DEFAULT 8 CHECK (max_historico_mensagens BETWEEN 0 AND 100),
  max_output_tokens integer NOT NULL DEFAULT 300 CHECK (max_output_tokens BETWEEN 1 AND 32768),
  mensagem_contingencia text NOT NULL DEFAULT '',
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (empresa_id, credencial_propria_id)
    REFERENCES credenciais_openai(empresa_id, id) ON DELETE RESTRICT,
  CHECK (
    (tipo_chave = 'compartilhada' AND credencial_propria_id IS NULL)
    OR
    (tipo_chave = 'propria' AND credencial_propria_id IS NOT NULL)
  )
);

CREATE TABLE modulos_empresa (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  module_key text NOT NULL CHECK (module_key IN (
    'catalog', 'orders', 'events', 'appointments',
    'payments', 'human_handoff', 'ai_freeform', 'external_integrations'
  )),
  habilitado boolean NOT NULL DEFAULT false,
  configuracao jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuracao) = 'object'),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, module_key)
);

CREATE TABLE menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  menu_key text NOT NULL,
  titulo text NOT NULL,
  mensagem text NOT NULL,
  ativo boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, menu_key, version)
);

CREATE TABLE menu_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  menu_id uuid NOT NULL,
  posicao smallint NOT NULL CHECK (posicao > 0),
  titulo text NOT NULL CHECK (length(btrim(titulo)) BETWEEN 1 AND 80),
  action_type text NOT NULL CHECK (action_type IN ('menu', 'fluxo', 'url', 'atendimento_humano')),
  action_key text NOT NULL,
  configuracao jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuracao) = 'object'),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, menu_id, posicao),
  FOREIGN KEY (empresa_id, menu_id) REFERENCES menus(empresa_id, id) ON DELETE RESTRICT
);

CREATE TABLE integracoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('google_sheets', 'meta', 'openai', 'webhook', 'outro')),
  nome text NOT NULL,
  habilitada boolean NOT NULL DEFAULT false,
  obrigatoria_para_confirmacao boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'nao_configurada'
    CHECK (status IN ('nao_configurada', 'saudavel', 'indisponivel', 'desabilitada')),
  configuracao jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(configuracao) = 'object'),
  cache_version bigint NOT NULL DEFAULT 0 CHECK (cache_version >= 0),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_error_sanitized text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, tipo, nome)
);

CREATE TABLE credenciais_integracao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  integracao_id uuid NOT NULL,
  secret_ciphertext bytea NOT NULL,
  secret_nonce bytea NOT NULL,
  secret_tag bytea NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  fingerprint text NOT NULL,
  valor_mascarado text NOT NULL,
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'revogada', 'rotacionada')),
  created_by uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, integracao_id)
    REFERENCES integracoes(empresa_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX credenciais_integracao_ativa_uq
  ON credenciais_integracao (empresa_id, integracao_id)
  WHERE status = 'ativa' AND revoked_at IS NULL;

CREATE TABLE formas_pagamento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('pix', 'link', 'dinheiro', 'cartao', 'outro')),
  nome text NOT NULL,
  identificador_ciphertext bytea,
  identificador_nonce bytea,
  identificador_tag bytea,
  key_version integer,
  identificador_mascarado text,
  favorecido text,
  instrucoes text NOT NULL DEFAULT '',
  ativa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  CHECK (
    (identificador_ciphertext IS NULL AND identificador_nonce IS NULL AND identificador_tag IS NULL AND key_version IS NULL)
    OR
    (identificador_ciphertext IS NOT NULL AND identificador_nonce IS NOT NULL AND identificador_tag IS NOT NULL AND key_version > 0)
  )
);

CREATE INDEX formas_pagamento_empresa_ativa_idx
  ON formas_pagamento (empresa_id, ativa, created_at DESC, id);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'empresas', 'usuarios', 'usuarios_empresas', 'numeros_whatsapp',
    'credenciais_meta', 'credenciais_openai', 'configuracoes_ia',
    'modulos_empresa', 'menus', 'menu_itens', 'integracoes',
    'credenciais_integracao', 'formas_pagamento'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      table_name,
      table_name
    );
  END LOOP;
END;
$$;
