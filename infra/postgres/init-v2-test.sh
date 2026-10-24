#!/bin/sh
# Somente cluster sintético dedicado. Nunca executar no PostgreSQL anterior.
set -eu
: "${V2_OWNER_PASSWORD:?}"
: "${V2_APP_PASSWORD:?}"
export PGUSER="${PGUSER:-${POSTGRES_USER:?}}"

psql -X --set=ON_ERROR_STOP=1 --dbname=postgres <<'SQL'
DO $$ BEGIN
  IF current_user <> 'waia_v2_bootstrap' THEN
    RAISE EXCEPTION 'Bootstrap exige o cluster sintetico waia_v2_bootstrap';
  END IF;
END $$;
\getenv owner_password V2_OWNER_PASSWORD
\getenv app_password V2_APP_PASSWORD
SELECT format('CREATE ROLE waia_v2_owner LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', :'owner_password') \gexec
SELECT format('CREATE ROLE waia_v2_app LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS', :'app_password') \gexec
CREATE DATABASE waia_v2_empty OWNER waia_v2_owner;
CREATE DATABASE waia_v2_upgrade OWNER waia_v2_owner;
CREATE DATABASE waia_v2_app OWNER waia_v2_owner;
REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;
SQL

for v2_database in waia_v2_empty waia_v2_upgrade waia_v2_app; do
  psql -X --set=ON_ERROR_STOP=1 --dbname="$v2_database" <<'SQL'
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO waia_v2_owner, waia_v2_app', current_database()) \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO waia_v2_app;
ALTER DEFAULT PRIVILEGES FOR ROLE waia_v2_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO waia_v2_app;
ALTER DEFAULT PRIVILEGES FOR ROLE waia_v2_owner IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO waia_v2_app;
SQL
done
