CREATE TABLE ai_quota_accounts (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  periodo date NOT NULL,
  tokens_usados bigint NOT NULL DEFAULT 0 CHECK (tokens_usados >= 0),
  custo_usado numeric(16, 8) NOT NULL DEFAULT 0 CHECK (custo_usado >= 0),
  tokens_reservados bigint NOT NULL DEFAULT 0 CHECK (tokens_reservados >= 0),
  custo_reservado numeric(16, 8) NOT NULL DEFAULT 0 CHECK (custo_reservado >= 0),
  alerta_enviado boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (empresa_id, periodo)
);

CREATE TABLE ai_quota_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  periodo date NOT NULL,
  tokens_estimados bigint NOT NULL CHECK (tokens_estimados >= 0),
  custo_estimado numeric(16, 8) NOT NULL CHECK (custo_estimado >= 0),
  limite_tokens bigint,
  limite_custo numeric(16, 8),
  alerta_percentual smallint NOT NULL CHECK (alerta_percentual BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'reservada' CHECK (status IN ('reservada', 'finalizada', 'expirada')),
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  FOREIGN KEY (empresa_id, periodo) REFERENCES ai_quota_accounts(empresa_id, periodo) ON DELETE RESTRICT
);

ALTER TABLE uso_ia
  ADD COLUMN reservation_id uuid,
  ADD COLUMN pricing_version text NOT NULL DEFAULT 'unknown',
  ADD COLUMN config_version bigint NOT NULL DEFAULT 1 CHECK (config_version > 0),
  ADD CONSTRAINT uso_ia_reservation_fk FOREIGN KEY (empresa_id, reservation_id)
    REFERENCES ai_quota_reservations(empresa_id, id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uso_ia_reservation_uq ON uso_ia (empresa_id, reservation_id)
  WHERE reservation_id IS NOT NULL;
CREATE INDEX ai_quota_reservations_expiry_idx
  ON ai_quota_reservations (status, expires_at, id) WHERE status = 'reservada';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ai_quota_accounts', 'ai_quota_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_policy ON %I USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin()) WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin())',
      table_name
    );
  END LOOP;
END;
$$;
