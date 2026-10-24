-- M5: transactional receipts for the trusted publication service. Customer RLS
-- remains closed on revisions, technical resources and company mutations.
CREATE TABLE attendance_publications (
  empresa_id uuid NOT NULL REFERENCES empresas(id) ON DELETE RESTRICT,
  actor_id uuid NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
  request_key text NOT NULL CHECK(length(request_key) BETWEEN 16 AND 100),
  request_hash char(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(empresa_id,actor_id,request_key)
);
ALTER TABLE attendance_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON attendance_publications
  USING(empresa_id=app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK(empresa_id=app_current_empresa_id() OR app_is_platform_admin());
CREATE POLICY customer_resource_denied ON attendance_publications AS RESTRICTIVE
  USING(app_current_audience()<>'customer')
  WITH CHECK(app_current_audience()<>'customer');
