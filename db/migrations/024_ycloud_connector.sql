-- Additive connector; existing Meta rows and tenant-scoped credential FKs remain intact.
ALTER TABLE aplicativos_meta DROP CONSTRAINT aplicativos_meta_modo_check;
ALTER TABLE aplicativos_meta ADD CONSTRAINT aplicativos_meta_modo_check
  CHECK (modo IN ('compartilhado', 'proprio', 'ycloud'));
ALTER TABLE aplicativos_meta DROP CONSTRAINT aplicativos_meta_modo_credenciais_ck;
ALTER TABLE aplicativos_meta ADD CONSTRAINT aplicativos_meta_modo_credenciais_ck CHECK (
  (modo = 'compartilhado' AND app_secret_credencial_id IS NULL
    AND app_secret_anterior_credencial_id IS NULL AND app_secret_rotacionado_at IS NULL
    AND app_secret_anterior_valido_ate IS NULL AND verify_token_credencial_id IS NULL)
  OR modo = 'proprio'
  OR (modo = 'ycloud' AND verify_token_credencial_id IS NULL
    AND app_secret_anterior_credencial_id IS NULL AND app_secret_rotacionado_at IS NULL
    AND app_secret_anterior_valido_ate IS NULL)
);
ALTER TABLE aplicativos_meta DROP CONSTRAINT aplicativos_meta_ativacao_ck;
ALTER TABLE aplicativos_meta ADD CONSTRAINT aplicativos_meta_ativacao_ck CHECK (
  estado <> 'ativo' OR modo = 'compartilhado'
  OR (modo = 'proprio' AND app_secret_credencial_id IS NOT NULL AND verify_token_credencial_id IS NOT NULL)
  OR (modo = 'ycloud' AND app_secret_credencial_id IS NOT NULL)
);
