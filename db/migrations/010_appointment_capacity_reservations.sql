ALTER TABLE disponibilidades_servico
  ADD CONSTRAINT disponibilidades_servico_empresa_id_produto_uq
  UNIQUE (empresa_id, id, produto_servico_id);

ALTER TABLE agendamentos
  ADD COLUMN disponibilidade_id uuid,
  ADD CONSTRAINT agendamentos_disponibilidade_produto_fkey
    FOREIGN KEY (empresa_id, disponibilidade_id, produto_servico_id)
    REFERENCES disponibilidades_servico (empresa_id, id, produto_servico_id)
    ON DELETE RESTRICT,
  ADD CONSTRAINT agendamentos_disponibilidade_produto_check
    CHECK (disponibilidade_id IS NULL OR produto_servico_id IS NOT NULL);

CREATE INDEX agendamentos_disponibilidade_idx
  ON agendamentos (empresa_id, disponibilidade_id, status)
  WHERE disponibilidade_id IS NOT NULL AND deleted_at IS NULL;

CREATE OR REPLACE FUNCTION sync_agendamento_disponibilidade_reserva()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_holds boolean := false;
  new_holds boolean := false;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_holds := OLD.disponibilidade_id IS NOT NULL
      AND OLD.deleted_at IS NULL
      AND OLD.status IN ('solicitado', 'confirmado');
  END IF;
  IF TG_OP <> 'DELETE' THEN
    new_holds := NEW.disponibilidade_id IS NOT NULL
      AND NEW.deleted_at IS NULL
      AND NEW.status IN ('solicitado', 'confirmado');
  END IF;

  IF old_holds AND (
    NOT new_holds
    OR OLD.disponibilidade_id IS DISTINCT FROM NEW.disponibilidade_id
    OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id
  ) THEN
    UPDATE disponibilidades_servico
       SET reservados = GREATEST(0, reservados - 1), updated_at = now()
     WHERE empresa_id = OLD.empresa_id AND id = OLD.disponibilidade_id;
  END IF;

  IF new_holds AND (
    NOT old_holds
    OR OLD.disponibilidade_id IS DISTINCT FROM NEW.disponibilidade_id
    OR OLD.empresa_id IS DISTINCT FROM NEW.empresa_id
  ) THEN
    UPDATE disponibilidades_servico
       SET reservados = reservados + 1, updated_at = now()
     WHERE empresa_id = NEW.empresa_id
       AND id = NEW.disponibilidade_id
       AND status = 'disponivel'
       AND deleted_at IS NULL
       AND reservados < capacidade;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Disponibilidade indisponivel ou sem capacidade.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agendamentos_sync_disponibilidade_reserva
BEFORE INSERT OR UPDATE OF disponibilidade_id, status, deleted_at OR DELETE
ON agendamentos
FOR EACH ROW
EXECUTE FUNCTION sync_agendamento_disponibilidade_reserva();

