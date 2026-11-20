-- Versions also fence pauses initiated outside the follow-up screen.
CREATE OR REPLACE FUNCTION follow_up_cancel_on_pause() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.modo_atendimento<>'bot' OR NEW.status<>'aberta' OR NEW.lock_version<>OLD.lock_version THEN
    UPDATE follow_up_cycles SET enabled=false,state='cancelled',reason='BOT_STATE_CHANGED',version=version+1,updated_at=now()
      WHERE empresa_id=NEW.empresa_id AND conversa_id=NEW.id AND enabled;
    UPDATE follow_up_actions a SET state='cancelled',reason='BOT_STATE_CHANGED',updated_at=now()
      FROM follow_up_cycles c WHERE c.empresa_id=NEW.empresa_id AND c.conversa_id=NEW.id AND a.empresa_id=c.empresa_id
      AND a.cycle_id=c.id AND a.state IN ('pending','prepared');
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION follow_up_cancel_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='cancelled' AND NEW.message_id IS NOT NULL THEN
    UPDATE mensagens SET status='ignorada_duplicidade' WHERE empresa_id=NEW.empresa_id AND id=NEW.message_id
      AND external_message_id IS NULL AND status='enfileirada';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER follow_up_cancel_prepared_message AFTER UPDATE OF state ON follow_up_actions FOR EACH ROW EXECUTE FUNCTION follow_up_cancel_message();
CREATE UNIQUE INDEX follow_up_one_contact ON follow_up_cycles(empresa_id,contato_id) WHERE enabled;
