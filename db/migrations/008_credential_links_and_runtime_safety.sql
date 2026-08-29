ALTER TABLE configuracoes_ia
  DROP CONSTRAINT IF EXISTS configuracoes_ia_empresa_id_credencial_propria_id_fkey;

ALTER TABLE configuracoes_ia
  ADD CONSTRAINT configuracoes_ia_credencial_empresa_fkey
  FOREIGN KEY (empresa_id, credencial_propria_id)
  REFERENCES credenciais_empresa (empresa_id, id)
  ON DELETE RESTRICT;

ALTER TABLE formas_pagamento
  ADD COLUMN credencial_id uuid;

ALTER TABLE formas_pagamento
  ADD CONSTRAINT formas_pagamento_credencial_empresa_fkey
  FOREIGN KEY (empresa_id, credencial_id)
  REFERENCES credenciais_empresa (empresa_id, id)
  ON DELETE RESTRICT;

CREATE INDEX formas_pagamento_credencial_idx
  ON formas_pagamento (empresa_id, credencial_id)
  WHERE credencial_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE credenciais_meta
  DROP CONSTRAINT IF EXISTS credenciais_meta_rotated_from_id_fkey;

ALTER TABLE credenciais_meta
  ADD CONSTRAINT credenciais_meta_rotacao_empresa_fkey
  FOREIGN KEY (empresa_id, rotated_from_id)
  REFERENCES credenciais_meta (empresa_id, id)
  ON DELETE RESTRICT;

ALTER TABLE credenciais_openai
  DROP CONSTRAINT IF EXISTS credenciais_openai_rotated_from_id_fkey;

ALTER TABLE credenciais_openai
  ADD CONSTRAINT credenciais_openai_rotacao_empresa_fkey
  FOREIGN KEY (empresa_id, rotated_from_id)
  REFERENCES credenciais_openai (empresa_id, id)
  ON DELETE RESTRICT;
