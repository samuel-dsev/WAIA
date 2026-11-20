-- Compatibility for the stable line, which has no candidate customer audience.
-- Do not replace the richer audience function if this schema already has it.
DO $$ BEGIN
  IF to_regprocedure('public.app_current_audience()') IS NULL THEN
    EXECUTE 'CREATE FUNCTION public.app_current_audience() RETURNS text LANGUAGE sql STABLE AS $body$ SELECT coalesce(current_setting(''app.audience'',true),'''') $body$';
  END IF;
END $$;
