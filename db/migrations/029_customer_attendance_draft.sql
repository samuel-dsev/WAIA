-- M4: expose only an existing draft, under an authenticated customer transaction.
-- Never loosen policies on active revisions, credentials, integrations or jobs.
SELECT set_config('app.is_platform_admin','true',true);

CREATE FUNCTION customer_attendance_access(target uuid, capability text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT target=app_current_empresa_id() AND capability IN ('attendance.read','attendance.edit')
    AND EXISTS (
      SELECT 1 FROM usuarios u
      JOIN usuarios_empresas m ON m.usuario_id=u.id AND m.empresa_id=target
      JOIN empresas e ON e.id=m.empresa_id
      JOIN auth_sessions s ON s.usuario_id=u.id
      WHERE u.id=app_current_usuario_id() AND u.status='ativo' AND u.deleted_at IS NULL
        AND NOT u.activation_required AND m.status='ativo' AND e.deleted_at IS NULL
        AND e.status<>'arquivada' AND 'attendance.read'=ANY(m.permissoes)
        AND capability=ANY(m.permissoes)
        AND s.id=nullif(current_setting('app.attendance_session_id',true),'')::uuid
        AND s.audience='customer' AND s.revoked_at IS NULL AND s.expires_at>now()
        AND s.security_version=u.security_version
        AND (NOT u.mfa_habilitado OR s.mfa_verified_at IS NOT NULL)
        AND (u.papel_plataforma<>'administrador' OR s.mfa_verified_at IS NOT NULL)
    );
$$;

-- Remove only business paths enabled by the baseline. Everything left must be
-- byte-for-byte equal as jsonb before and after a customer mutation.
CREATE FUNCTION customer_attendance_technical_projection(value jsonb, baseline jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result jsonb:=value; field text; item jsonb; ordinal bigint; modules jsonb;
BEGIN
  FOREACH field IN ARRAY ARRAY['welcomeMessage','fallbackMessage','timezone','schedules','publicRules','establishmentRules'] LOOP
    result:=result #- ARRAY['identity',field];
  END LOOP;
  modules:=CASE WHEN jsonb_typeof(baseline->'modules')='array' THEN baseline->'modules' ELSE '[]'::jsonb END;
  IF modules ? 'ai_freeform' AND baseline#>'{ai,enabled}'='true'::jsonb THEN
    FOREACH field IN ARRAY ARRAY['prompt','personality','fallbackMessage','followUpQuestion'] LOOP
      result:=result #- ARRAY['ai',field];
    END LOOP;
    IF baseline#>'{ai,leadQualificationEnabled}'='true'::jsonb THEN
      result:=result #- ARRAY['ai','leadQualificationCriteria'];
      result:=result #- ARRAY['ai','leadQualificationClosing'];
    END IF;
  END IF;
  IF modules ? 'human_handoff' THEN
    result:=result #- ARRAY['humanHandoff','message'];
    result:=result #- ARRAY['humanHandoff','salesInterestMessage'];
  END IF;
  IF jsonb_typeof(baseline->'publicReplies')='array' THEN
    FOR item,ordinal IN SELECT a.value,a.ordinality FROM jsonb_array_elements(baseline->'publicReplies') WITH ORDINALITY a(value,ordinality) LOOP
      IF ((item->>'action') IN ('catalog.address','catalog.menu') AND modules ? 'catalog')
        OR ((item->>'action')='events.birthday_rule' AND modules ? 'events') THEN
        result:=result #- ARRAY['publicReplies',(ordinal-1)::text,'text'];
      END IF;
    END LOOP;
  END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION protect_customer_attendance_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app_current_audience()='customer' THEN
    IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION 'CUSTOMER_ATTENDANCE_DRAFT_DENIED' USING ERRCODE='42501'; END IF;
    IF NOT customer_attendance_access(OLD.empresa_id,'attendance.edit')
      OR NEW.empresa_id IS DISTINCT FROM OLD.empresa_id
      OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
      OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.updated_by IS DISTINCT FROM app_current_usuario_id()
      OR NEW.draft_version IS DISTINCT FROM OLD.draft_version+1
      OR customer_attendance_technical_projection(NEW.configuracao,OLD.configuracao)
        IS DISTINCT FROM customer_attendance_technical_projection(OLD.configuracao,OLD.configuracao) THEN
      RAISE EXCEPTION 'CUSTOMER_ATTENDANCE_DRAFT_DENIED' USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER customer_attendance_draft_guard BEFORE INSERT OR UPDATE OR DELETE ON configuracoes_rascunho
  FOR EACH ROW EXECUTE FUNCTION protect_customer_attendance_draft();

DROP POLICY customer_resource_denied ON configuracoes_rascunho;
CREATE POLICY customer_attendance_read ON configuracoes_rascunho AS RESTRICTIVE FOR SELECT
  USING(app_current_audience()<>'customer' OR customer_attendance_access(empresa_id,'attendance.read'));
CREATE POLICY customer_attendance_update ON configuracoes_rascunho AS RESTRICTIVE FOR UPDATE
  USING(app_current_audience()<>'customer' OR customer_attendance_access(empresa_id,'attendance.edit'))
  WITH CHECK(app_current_audience()<>'customer' OR customer_attendance_access(empresa_id,'attendance.edit'));
CREATE POLICY customer_attendance_no_insert ON configuracoes_rascunho AS RESTRICTIVE FOR INSERT
  WITH CHECK(app_current_audience()<>'customer');
CREATE POLICY customer_attendance_no_delete ON configuracoes_rascunho AS RESTRICTIVE FOR DELETE
  USING(app_current_audience()<>'customer');

DROP POLICY customer_resource_denied ON logs_auditoria;
CREATE POLICY customer_attendance_audit_insert ON logs_auditoria AS RESTRICTIVE FOR INSERT
  WITH CHECK(app_current_audience()<>'customer' OR (
    customer_attendance_access(empresa_id,'attendance.edit') AND ator_usuario_id=app_current_usuario_id()
    AND acao='configuration.draft.update' AND recurso_tipo='configuration_draft' AND resultado='sucesso'
    AND campos_alterados_redigidos='{"fields":["draft_version","schema_version","configuration"]}'::jsonb
    AND recurso_id=(SELECT draft_version::text FROM configuracoes_rascunho WHERE empresa_id=logs_auditoria.empresa_id)
  ));
CREATE POLICY customer_attendance_audit_no_read ON logs_auditoria AS RESTRICTIVE FOR SELECT
  USING(app_current_audience()<>'customer');
CREATE POLICY customer_attendance_audit_no_update ON logs_auditoria AS RESTRICTIVE FOR UPDATE
  USING(app_current_audience()<>'customer') WITH CHECK(app_current_audience()<>'customer');
CREATE POLICY customer_attendance_audit_no_delete ON logs_auditoria AS RESTRICTIVE FOR DELETE
  USING(app_current_audience()<>'customer');
