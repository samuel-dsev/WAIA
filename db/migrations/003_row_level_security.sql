CREATE OR REPLACE FUNCTION app_current_empresa_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.empresa_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_usuario_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT nullif(current_setting('app.usuario_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_is_platform_admin()
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT coalesce(current_setting('app.is_platform_admin', true), 'false') = 'true';
$$;

ALTER TABLE empresas ENABLE ROW LEVEL SECURITY;
ALTER TABLE empresas FORCE ROW LEVEL SECURITY;
CREATE POLICY empresas_isolation_policy ON empresas
  USING (id = app_current_empresa_id() OR app_is_platform_admin())
  WITH CHECK (id = app_current_empresa_id() OR app_is_platform_admin());

ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios FORCE ROW LEVEL SECURITY;
CREATE POLICY usuarios_access_policy ON usuarios
  USING (
    id = app_current_usuario_id()
    OR app_is_platform_admin()
    OR EXISTS (
      SELECT 1
      FROM usuarios_empresas membership
      WHERE membership.usuario_id = usuarios.id
        AND membership.empresa_id = app_current_empresa_id()
        AND membership.status = 'ativo'
    )
  )
  WITH CHECK (id = app_current_usuario_id() OR app_is_platform_admin());

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY auth_sessions_owner_policy ON auth_sessions
  USING (usuario_id = app_current_usuario_id() OR app_is_platform_admin())
  WITH CHECK (usuario_id = app_current_usuario_id() OR app_is_platform_admin());

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'usuarios_empresas', 'numeros_whatsapp', 'credenciais_meta',
    'credenciais_openai', 'configuracoes_ia', 'modulos_empresa', 'menus',
    'menu_itens', 'integracoes', 'credenciais_integracao', 'formas_pagamento',
    'contatos', 'notas_contato', 'etiquetas', 'contatos_etiquetas',
    'produtos_servicos', 'eventos', 'eventos_produtos', 'conversas',
    'mensagens', 'pedidos', 'itens_pedido', 'agendamentos',
    'estados_conversa', 'uso_ia', 'outbox_jobs', 'jobs_falhos',
    'logs_operacionais', 'logs_auditoria'
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

COMMENT ON FUNCTION app_current_empresa_id() IS
  'Tenant definido somente com SET LOCAL pela camada transacional da aplicação.';
COMMENT ON FUNCTION app_is_platform_admin() IS
  'Indicador definido pela aplicação somente após autorização administrativa ou em processo interno confiável.';
