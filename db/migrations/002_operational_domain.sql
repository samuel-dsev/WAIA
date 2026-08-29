CREATE TABLE contatos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  telefone_normalizado text NOT NULL CHECK (telefone_normalizado ~ '^[1-9][0-9]{7,14}$'),
  telefone_mascarado text,
  nome text,
  primeira_interacao_at timestamptz,
  ultima_interacao_at timestamptz,
  consentimento_status text NOT NULL DEFAULT 'nao_informado'
    CHECK (consentimento_status IN ('nao_informado', 'concedido', 'revogado')),
  consentimento_at timestamptz,
  bot_pausado boolean NOT NULL DEFAULT false,
  bloqueado boolean NOT NULL DEFAULT false,
  exclusao_solicitada_at timestamptz,
  anonimizado_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id)
);

CREATE UNIQUE INDEX contatos_empresa_telefone_ativo_uq
  ON contatos (empresa_id, telefone_normalizado)
  WHERE deleted_at IS NULL;
CREATE INDEX contatos_empresa_ultima_interacao_idx
  ON contatos (empresa_id, ultima_interacao_at DESC NULLS LAST, id);
CREATE INDEX contatos_empresa_nome_idx
  ON contatos (empresa_id, lower(nome)) WHERE nome IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE notas_contato (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  contato_id uuid NOT NULL,
  autor_usuario_id uuid NOT NULL,
  nota text NOT NULL CHECK (length(btrim(nota)) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, autor_usuario_id) REFERENCES usuarios_empresas(empresa_id, usuario_id) ON DELETE RESTRICT
);

CREATE TABLE etiquetas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  nome citext NOT NULL,
  cor text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, nome)
);

CREATE TABLE contatos_etiquetas (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  contato_id uuid NOT NULL,
  etiqueta_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, contato_id, etiqueta_id),
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, etiqueta_id) REFERENCES etiquetas(empresa_id, id) ON DELETE RESTRICT
);

CREATE TABLE produtos_servicos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  tipo text NOT NULL CHECK (tipo IN ('produto', 'servico', 'convite')),
  sku text,
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 200),
  descricao text NOT NULL DEFAULT '',
  preco numeric(14, 2) NOT NULL DEFAULT 0 CHECK (preco >= 0),
  moeda char(3) NOT NULL DEFAULT 'BRL',
  controle_estoque text NOT NULL DEFAULT 'nao_controlado'
    CHECK (controle_estoque IN ('nao_controlado', 'limitado', 'sob_consulta')),
  quantidade_disponivel integer CHECK (quantidade_disponivel IS NULL OR quantidade_disponivel >= 0),
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id)
);

CREATE UNIQUE INDEX produtos_servicos_empresa_sku_ativo_uq
  ON produtos_servicos (empresa_id, sku)
  WHERE sku IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX produtos_servicos_empresa_tipo_ativo_idx
  ON produtos_servicos (empresa_id, tipo, ativo, nome, id);

CREATE TABLE eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  origem_externa text,
  external_id text,
  nome text NOT NULL CHECK (length(btrim(nome)) BETWEEN 1 AND 240),
  atracoes text NOT NULL DEFAULT '',
  inicio_at timestamptz NOT NULL,
  fim_at timestamptz,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  local text NOT NULL DEFAULT '',
  regra_vip text NOT NULL DEFAULT '',
  observacoes text NOT NULL DEFAULT '',
  capacidade integer CHECK (capacidade IS NULL OR capacidade >= 0),
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'publicado', 'cancelado', 'encerrado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  CHECK (fim_at IS NULL OR fim_at > inicio_at)
);

CREATE UNIQUE INDEX eventos_origem_externa_uq
  ON eventos (empresa_id, origem_externa, external_id)
  WHERE origem_externa IS NOT NULL AND external_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX eventos_empresa_status_inicio_idx
  ON eventos (empresa_id, status, inicio_at, id);

CREATE TABLE eventos_produtos (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  evento_id uuid NOT NULL,
  produto_servico_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, evento_id, produto_servico_id),
  FOREIGN KEY (empresa_id, evento_id) REFERENCES eventos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, produto_servico_id) REFERENCES produtos_servicos(empresa_id, id) ON DELETE RESTRICT
);

CREATE TABLE conversas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  contato_id uuid NOT NULL,
  numero_whatsapp_id uuid NOT NULL,
  canal text NOT NULL DEFAULT 'whatsapp' CHECK (canal IN ('whatsapp')),
  status text NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta', 'fechada', 'arquivada')),
  modo_atendimento text NOT NULL DEFAULT 'bot'
    CHECK (modo_atendimento IN ('bot', 'humano', 'pausado')),
  operador_usuario_id uuid,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  lock_version bigint NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  aberta_at timestamptz NOT NULL DEFAULT now(),
  fechada_at timestamptz,
  ultima_mensagem_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, numero_whatsapp_id) REFERENCES numeros_whatsapp(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, operador_usuario_id) REFERENCES usuarios_empresas(empresa_id, usuario_id) ON DELETE RESTRICT,
  CHECK ((status = 'fechada' AND fechada_at IS NOT NULL) OR status <> 'fechada')
);

CREATE INDEX conversas_empresa_contato_ultima_idx
  ON conversas (empresa_id, contato_id, ultima_mensagem_at DESC NULLS LAST, id);
CREATE INDEX conversas_empresa_status_ultima_idx
  ON conversas (empresa_id, status, ultima_mensagem_at DESC NULLS LAST, id);
CREATE UNIQUE INDEX conversas_aberta_contato_numero_uq
  ON conversas (empresa_id, contato_id, numero_whatsapp_id)
  WHERE status = 'aberta';

CREATE TABLE mensagens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conversa_id uuid NOT NULL,
  contato_id uuid NOT NULL,
  numero_whatsapp_id uuid NOT NULL,
  direcao text NOT NULL CHECK (direcao IN ('entrada', 'saida', 'interna')),
  tipo text NOT NULL CHECK (tipo IN ('texto', 'imagem', 'audio', 'video', 'documento', 'interativo', 'status', 'sistema')),
  corpo text,
  media_external_id text,
  media_storage_key text,
  external_message_id text,
  status text NOT NULL CHECK (status IN (
    'recebida', 'enfileirada', 'processando', 'respondida', 'enviada',
    'entregue', 'lida', 'falhou', 'ignorada_duplicidade'
  )),
  origem_resposta text CHECK (origem_resposta IN ('fluxo_deterministico', 'ia', 'operador', 'sistema')),
  sequence bigint NOT NULL CHECK (sequence > 0),
  provider_timestamp timestamptz,
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  error_code text,
  error_sanitized text,
  operador_usuario_id uuid,
  correlation_id uuid NOT NULL,
  enqueued_at timestamptz,
  processing_at timestamptz,
  responded_at timestamptz,
  sent_at timestamptz,
  delivered_at timestamptz,
  read_at timestamptz,
  redacted_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, conversa_id, sequence),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, numero_whatsapp_id) REFERENCES numeros_whatsapp(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, operador_usuario_id) REFERENCES usuarios_empresas(empresa_id, usuario_id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX mensagens_external_id_uq
  ON mensagens (empresa_id, external_message_id)
  WHERE external_message_id IS NOT NULL;
CREATE INDEX mensagens_conversa_timeline_idx
  ON mensagens (empresa_id, conversa_id, created_at, id);
CREATE INDEX mensagens_empresa_status_idx
  ON mensagens (empresa_id, status, created_at DESC, id);
CREATE INDEX mensagens_external_status_idx
  ON mensagens (external_message_id) WHERE external_message_id IS NOT NULL;

CREATE TABLE pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  contato_id uuid NOT NULL,
  conversa_id uuid NOT NULL,
  numero_whatsapp_id uuid NOT NULL,
  nome_comprador text,
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN (
    'rascunho', 'aguardando_comprovante', 'aguardando_conferencia',
    'confirmado', 'cancelado', 'falhou'
  )),
  pagamento_status text NOT NULL DEFAULT 'pendente'
    CHECK (pagamento_status IN ('pendente', 'em_conferencia', 'confirmado', 'recusado', 'estornado')),
  total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  moeda char(3) NOT NULL DEFAULT 'BRL',
  comprovante_mensagem_id uuid,
  integracao_status text NOT NULL DEFAULT 'nao_requerida'
    CHECK (integracao_status IN ('nao_requerida', 'pendente', 'sincronizada', 'falhou')),
  idempotency_key text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, numero_whatsapp_id) REFERENCES numeros_whatsapp(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, comprovante_mensagem_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX pedidos_idempotency_uq
  ON pedidos (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX pedidos_empresa_status_idx
  ON pedidos (empresa_id, status, created_at DESC, id);
CREATE INDEX pedidos_empresa_contato_idx
  ON pedidos (empresa_id, contato_id, created_at DESC, id);

CREATE TABLE itens_pedido (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  pedido_id uuid NOT NULL,
  produto_servico_id uuid,
  evento_id uuid,
  descricao_snapshot text NOT NULL,
  quantidade integer NOT NULL CHECK (quantidade > 0),
  preco_unitario numeric(14, 2) NOT NULL CHECK (preco_unitario >= 0),
  total numeric(14, 2) NOT NULL CHECK (total >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, pedido_id) REFERENCES pedidos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, produto_servico_id) REFERENCES produtos_servicos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, evento_id) REFERENCES eventos(empresa_id, id) ON DELETE RESTRICT,
  CHECK (total = round(preco_unitario * quantidade, 2))
);

CREATE INDEX itens_pedido_empresa_pedido_idx ON itens_pedido (empresa_id, pedido_id, id);

CREATE TABLE agendamentos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  contato_id uuid NOT NULL,
  conversa_id uuid,
  produto_servico_id uuid,
  evento_id uuid,
  inicio_at timestamptz NOT NULL,
  fim_at timestamptz NOT NULL,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  status text NOT NULL DEFAULT 'solicitado'
    CHECK (status IN ('solicitado', 'confirmado', 'cancelado', 'concluido', 'nao_compareceu')),
  observacoes text NOT NULL DEFAULT '',
  operador_usuario_id uuid,
  idempotency_key text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, contato_id) REFERENCES contatos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, produto_servico_id) REFERENCES produtos_servicos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, evento_id) REFERENCES eventos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, operador_usuario_id) REFERENCES usuarios_empresas(empresa_id, usuario_id) ON DELETE RESTRICT,
  CHECK (fim_at > inicio_at)
);

CREATE UNIQUE INDEX agendamentos_idempotency_uq
  ON agendamentos (empresa_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX agendamentos_empresa_status_inicio_idx
  ON agendamentos (empresa_id, status, inicio_at, id);

CREATE TABLE estados_conversa (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conversa_id uuid NOT NULL,
  flow_key text NOT NULL DEFAULT 'menu_principal',
  stage text NOT NULL DEFAULT 'inicio',
  evento_id uuid,
  pedido_id uuid,
  comprovante_mensagem_id uuid,
  state_data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(state_data) = 'object'),
  lock_version bigint NOT NULL DEFAULT 1 CHECK (lock_version > 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, conversa_id),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, evento_id) REFERENCES eventos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, pedido_id) REFERENCES pedidos(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, comprovante_mensagem_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT
);

CREATE TABLE uso_ia (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conversa_id uuid NOT NULL,
  mensagem_id uuid,
  provedor text NOT NULL,
  modelo text NOT NULL,
  tipo_chave text NOT NULL CHECK (tipo_chave IN ('compartilhada', 'propria', 'simulada')),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  custo_estimado numeric(14, 8) NOT NULL DEFAULT 0 CHECK (custo_estimado >= 0),
  sucesso boolean NOT NULL,
  error_code text,
  error_sanitized text,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, mensagem_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT,
  CHECK (total_tokens = input_tokens + output_tokens)
);

CREATE INDEX uso_ia_empresa_periodo_idx ON uso_ia (empresa_id, occurred_at DESC, id);
CREATE INDEX uso_ia_conversa_idx ON uso_ia (empresa_id, conversa_id, occurred_at, id);

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  conversa_id uuid,
  mensagem_id uuid,
  job_type text NOT NULL,
  dedup_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pendente'
    CHECK (status IN ('pendente', 'em_publicacao', 'publicado', 'concluido', 'falhou')),
  tentativas integer NOT NULL DEFAULT 0 CHECK (tentativas >= 0),
  disponivel_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  published_at timestamptz,
  completed_at timestamptz,
  error_sanitized text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, dedup_key),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, mensagem_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX outbox_jobs_claim_idx
  ON outbox_jobs (status, disponivel_at, created_at, id)
  WHERE status IN ('pendente', 'em_publicacao');
CREATE INDEX outbox_jobs_empresa_idx
  ON outbox_jobs (empresa_id, status, created_at, id);

CREATE TABLE jobs_falhos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  queue_job_id text NOT NULL UNIQUE,
  job_type text NOT NULL,
  conversa_id uuid,
  mensagem_id uuid,
  tentativas integer NOT NULL CHECK (tentativas > 0),
  max_tentativas integer NOT NULL CHECK (max_tentativas >= tentativas),
  proxima_tentativa_at timestamptz,
  first_failure_at timestamptz NOT NULL,
  last_failure_at timestamptz NOT NULL,
  error_code text,
  error_sanitized text NOT NULL,
  payload_sanitized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_sanitized) = 'object'),
  correlation_id uuid NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, mensagem_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT,
  CHECK (last_failure_at >= first_failure_at)
);

CREATE INDEX jobs_falhos_empresa_abertos_idx
  ON jobs_falhos (empresa_id, last_failure_at DESC, id) WHERE resolved_at IS NULL;

CREATE TABLE logs_operacionais (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid REFERENCES empresas(id) ON DELETE RESTRICT,
  severidade text NOT NULL CHECK (severidade IN ('debug', 'info', 'warning', 'error', 'critical')),
  categoria text NOT NULL,
  servico text NOT NULL,
  event_code text NOT NULL,
  correlation_id uuid,
  conversa_id uuid,
  mensagem_id uuid,
  job_id uuid,
  usuario_id uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  resumo_sanitizado text NOT NULL,
  metadata_sanitized jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata_sanitized) = 'object'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, conversa_id) REFERENCES conversas(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, mensagem_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, job_id) REFERENCES outbox_jobs(empresa_id, id) ON DELETE RESTRICT,
  CHECK (expires_at > occurred_at),
  CHECK (empresa_id IS NOT NULL OR (conversa_id IS NULL AND mensagem_id IS NULL AND job_id IS NULL))
);

CREATE INDEX logs_operacionais_empresa_periodo_idx
  ON logs_operacionais (empresa_id, occurred_at DESC, id);
CREATE INDEX logs_operacionais_correlacao_idx
  ON logs_operacionais (empresa_id, correlation_id, occurred_at DESC)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX logs_operacionais_expiracao_idx ON logs_operacionais (expires_at, id);

CREATE TABLE logs_auditoria (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid REFERENCES empresas(id) ON DELETE RESTRICT,
  ator_usuario_id uuid REFERENCES usuarios(id) ON DELETE RESTRICT,
  acao text NOT NULL,
  recurso_tipo text NOT NULL,
  recurso_id text,
  resultado text NOT NULL CHECK (resultado IN ('sucesso', 'negado', 'falha')),
  campos_alterados_redigidos jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(campos_alterados_redigidos) = 'object'),
  ip inet,
  user_agent_sanitized text,
  correlation_id uuid,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id)
);

CREATE INDEX logs_auditoria_empresa_periodo_idx
  ON logs_auditoria (empresa_id, occurred_at DESC, id);
CREATE INDEX logs_auditoria_ator_idx
  ON logs_auditoria (ator_usuario_id, occurred_at DESC, id) WHERE ator_usuario_id IS NOT NULL;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'contatos', 'notas_contato', 'etiquetas', 'produtos_servicos', 'eventos',
    'conversas', 'mensagens', 'pedidos', 'itens_pedido', 'agendamentos',
    'estados_conversa', 'outbox_jobs', 'jobs_falhos'
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
