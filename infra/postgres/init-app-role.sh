#!/bin/sh
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST obrigatorio}"
: "${POSTGRES_DB:?POSTGRES_DB obrigatorio}"
: "${POSTGRES_USER:?POSTGRES_USER obrigatorio}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD obrigatorio}"
: "${DATABASE_APP_USER:?DATABASE_APP_USER obrigatorio}"
: "${DATABASE_APP_PASSWORD:?DATABASE_APP_PASSWORD obrigatorio}"

export PGPASSWORD=$POSTGRES_PASSWORD

if [ "$POSTGRES_USER" = "$DATABASE_APP_USER" ]; then
  echo "POSTGRES_USER e DATABASE_APP_USER devem ser diferentes." >&2
  exit 1
fi

psql \
  --host="$POSTGRES_HOST" \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_DB" \
  --set=owner_user="$POSTGRES_USER" \
  --set=app_user="$DATABASE_APP_USER" \
  --set=app_password="$DATABASE_APP_PASSWORD" <<'SQL'
SELECT format(
  'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_user', :'app_password'
)
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS',
  :'app_user', :'app_password'
)
\gexec

-- Repara volumes criados pela configuracao antiga, na qual o papel da aplicacao
-- recebia indevidamente a propriedade dos objetos e do banco.
SELECT format('REASSIGN OWNED BY %I TO %I', :'app_user', :'owner_user')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'owner_user')
\gexec

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database())
\gexec

SELECT format('REVOKE CREATE ON SCHEMA public FROM %I', :'app_user')
\gexec
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), :'app_user')
\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'app_user')
\gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec

-- Objetos existentes e futuros permanecem do migrador. A aplicacao recebe
-- apenas os privilegios operacionais necessarios.
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'app_user'
)
\gexec
SELECT format(
  'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'app_user'
)
\gexec

SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  :'owner_user', :'app_user'
)
\gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO %I',
  :'owner_user', :'app_user'
)
\gexec
SQL
