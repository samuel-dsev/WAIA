CREATE TABLE whatsapp_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  numero_whatsapp_id uuid NOT NULL,
  mensagem_id uuid,
  external_message_id text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed', 'unknown')),
  provider_timestamp timestamptz,
  error_code text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, id),
  UNIQUE (empresa_id, idempotency_key),
  FOREIGN KEY (empresa_id, numero_whatsapp_id)
    REFERENCES numeros_whatsapp(empresa_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (empresa_id, mensagem_id)
    REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT
);

CREATE INDEX whatsapp_status_events_external_idx
  ON whatsapp_status_events (empresa_id, external_message_id, created_at, id);

ALTER TABLE whatsapp_status_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_status_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON whatsapp_status_events
  USING (empresa_id = app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK (empresa_id = app_current_empresa_id() OR app_is_platform_admin());
