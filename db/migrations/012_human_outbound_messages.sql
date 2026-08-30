ALTER TABLE mensagens
  ADD COLUMN client_idempotency_key text;

ALTER TABLE mensagens
  ADD CONSTRAINT mensagens_operator_idempotency_check CHECK (
    client_idempotency_key IS NULL
    OR (
      direcao = 'saida'
      AND origem_resposta = 'operador'
      AND operador_usuario_id IS NOT NULL
      AND client_idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )
  );

CREATE UNIQUE INDEX mensagens_operator_idempotency_uq
  ON mensagens (empresa_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
