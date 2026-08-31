ALTER TABLE integracoes
  ADD COLUMN cache_snapshot jsonb,
  ADD CONSTRAINT integracoes_cache_snapshot_object_ck
    CHECK (cache_snapshot IS NULL OR jsonb_typeof(cache_snapshot) = 'object');

CREATE TABLE integracao_operacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  integracao_id uuid NOT NULL,
  operacao text NOT NULL CHECK (length(btrim(operacao)) BETWEEN 1 AND 80),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) BETWEEN 1 AND 240),
  resultado jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(resultado) = 'object'),
  completed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, integracao_id, operacao, idempotency_key),
  FOREIGN KEY (empresa_id, integracao_id)
    REFERENCES integracoes(empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX integracao_operacoes_empresa_periodo_idx
  ON integracao_operacoes (empresa_id, completed_at DESC, id);

ALTER TABLE integracao_operacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE integracao_operacoes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON integracao_operacoes
  USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin());

COMMENT ON COLUMN integracoes.cache_snapshot IS
  'Ultimo snapshot Google Sheets validado; nunca contem credenciais ou dados de pagamento.';
COMMENT ON TABLE integracao_operacoes IS
  'Checkpoint idempotente de efeitos externos por tenant e integracao.';
