-- Delivery parts are a durable journal, not another copy of private media.
ALTER TABLE group_notifier_deliveries ADD CONSTRAINT group_notifier_deliveries_empresa_id_unique UNIQUE(empresa_id,id);
CREATE TABLE group_notifier_delivery_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  kind text NOT NULL CHECK (kind IN ('summary','image')),
  source_message_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','accepted','unconfirmed','cancelled')),
  message_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (empresa_id, delivery_id, position),
  UNIQUE (empresa_id, delivery_id, source_message_id),
  FOREIGN KEY (empresa_id, delivery_id) REFERENCES group_notifier_deliveries(empresa_id, id) ON DELETE CASCADE,
  FOREIGN KEY (empresa_id, source_message_id) REFERENCES mensagens(empresa_id, id) ON DELETE RESTRICT,
  CHECK ((kind='summary' AND source_message_id IS NULL) OR (kind='image' AND source_message_id IS NOT NULL))
);
ALTER TABLE group_notifier_delivery_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_notifier_delivery_parts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON group_notifier_delivery_parts
  USING (empresa_id=app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK (empresa_id=app_current_empresa_id() OR app_is_platform_admin());
