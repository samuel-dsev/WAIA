ALTER TABLE mensagens
  ADD COLUMN source_message_id uuid,
  ADD COLUMN outbound_payload jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(outbound_payload) = 'object');

ALTER TABLE mensagens
  ADD CONSTRAINT mensagens_source_empresa_fkey
  FOREIGN KEY (empresa_id, source_message_id)
  REFERENCES mensagens (empresa_id, id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX mensagens_resposta_origem_uq
  ON mensagens (empresa_id, source_message_id)
  WHERE source_message_id IS NOT NULL AND direcao = 'saida';
