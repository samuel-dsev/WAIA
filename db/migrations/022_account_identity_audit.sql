-- Auditoria de perfil/logout na propria transacao de identidade, sem bypass global.
CREATE POLICY account_audit_identity_insert ON account_audit FOR INSERT
  WITH CHECK (usuario_id=app_current_usuario_id() AND empresa_id IS NULL
    AND action IN ('account.profile.changed','account.logout'));
