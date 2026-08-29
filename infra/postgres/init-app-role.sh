#!/bin/sh
set -eu

: "${POSTGRES_HOST:?POSTGRES_HOST obrigatorio}"
: "${POSTGRES_DB:?POSTGRES_DB obrigatorio}"
: "${POSTGRES_USER:?POSTGRES_USER obrigatorio}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD obrigatorio}"
: "${DATABASE_APP_USER:?DATABASE_APP_USER obrigatorio}"
: "${DATABASE_APP_PASSWORD:?DATABASE_APP_PASSWORD obrigatorio}"

export PGPASSWORD=$POSTGRES_PASSWORD

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

SELECT format('REASSIGN OWNED BY %I TO %I', :'owner_user', :'app_user')
\gexec

SELECT format('ALTER DATABASE %I OWNER TO %I', current_database(), :'app_user')
\gexec

SELECT format('GRANT USAGE, CREATE ON SCHEMA public TO %I', :'app_user')
\gexec
SQL
