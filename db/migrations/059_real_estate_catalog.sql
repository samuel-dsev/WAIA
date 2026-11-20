ALTER TABLE integracoes DROP CONSTRAINT integracoes_tipo_check;
ALTER TABLE integracoes ADD CONSTRAINT integracoes_tipo_check
  CHECK (tipo IN ('google_sheets', 'meta', 'openai', 'webhook', 'outro', 'website_catalog', 'real_estate_catalog'));

CREATE UNIQUE INDEX integracoes_real_estate_catalog_empresa_uq
  ON integracoes (empresa_id) WHERE tipo = 'real_estate_catalog' AND deleted_at IS NULL;
