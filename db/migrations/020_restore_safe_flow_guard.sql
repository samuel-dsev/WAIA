-- A função recursiva precisa resolver a si própria mesmo quando pg_restore
-- impõe um search_path vazio durante a carga de dados.
CREATE OR REPLACE FUNCTION public.flow_json_has_forbidden_key(document jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = pg_catalog
AS $$
DECLARE
  item record;
  child jsonb;
BEGIN
  IF jsonb_typeof(document) = 'object' THEN
    FOR item IN SELECT key, value FROM jsonb_each(document)
    LOOP
      IF regexp_replace(lower(item.key), '[^a-z0-9]', '', 'g')
           ~ '(password|secret|token|apikey|privatekey|credential)'
         OR public.flow_json_has_forbidden_key(item.value) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(document) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(document)
    LOOP
      IF public.flow_json_has_forbidden_key(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;
