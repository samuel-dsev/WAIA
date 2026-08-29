CREATE TABLE configuracoes_empresa (
  empresa_id uuid PRIMARY KEY REFERENCES empresas(id) ON DELETE RESTRICT,
  saudacao text NOT NULL DEFAULT '',
  mensagem_fallback text NOT NULL DEFAULT '',
  endereco text NOT NULL DEFAULT '',
  link_cardapio text NOT NULL DEFAULT '',
  regra_aniversariante text NOT NULL DEFAULT '',
  horarios jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(horarios) = 'object'),
  respostas_publicas jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(respostas_publicas) = 'array'),
  roteamento jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(roteamento) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE disponibilidades_servico (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  produto_servico_id uuid NOT NULL,
  inicio_at timestamptz NOT NULL,
  fim_at timestamptz NOT NULL,
  capacidade integer NOT NULL DEFAULT 1 CHECK (capacidade > 0),
  reservados integer NOT NULL DEFAULT 0 CHECK (reservados >= 0 AND reservados <= capacidade),
  status text NOT NULL DEFAULT 'disponivel' CHECK (status IN ('disponivel', 'indisponivel', 'encerrado')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, produto_servico_id, inicio_at),
  FOREIGN KEY (empresa_id, produto_servico_id)
    REFERENCES produtos_servicos(empresa_id, id) ON DELETE RESTRICT,
  CHECK (fim_at > inicio_at)
);

CREATE INDEX disponibilidades_servico_empresa_inicio_idx
  ON disponibilidades_servico (empresa_id, status, inicio_at, id) WHERE deleted_at IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['configuracoes_empresa', 'disponibilidades_servico'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin()) WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin())',
      table_name
    );
  END LOOP;
END;
$$;

CREATE TRIGGER disponibilidades_servico_set_updated_at
  BEFORE UPDATE ON disponibilidades_servico FOR EACH ROW EXECUTE FUNCTION set_updated_at();
