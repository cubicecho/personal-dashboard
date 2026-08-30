#!/bin/sh
# One role and one database per app inside the single shared Postgres.
#
# Separate databases, not a shared one with separate schemas: every app runs
# its own drizzle migrations on boot against its own `__drizzle_migrations`
# table, and they would collide in a shared namespace. This way each app sees
# exactly the database it sees standalone, and its DATABASE_URL differs only
# in host.
#
# Postgres runs /docker-entrypoint-initdb.d/* ONLY when the data directory is
# empty — i.e. on the very first start. Adding an app here later means either
# recreating the volume (losing every app's data) or creating its role and
# database by hand:
#   docker compose -f docker-compose.stack.yml exec postgres \
#     psql -U postgres -c "CREATE ROLE x LOGIN PASSWORD 'x'" \
#          -c "CREATE DATABASE x OWNER x"
set -eu

for app in autocal notes philotes eunomia; do
  echo "creating role and database: $app"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
	CREATE ROLE "$app" LOGIN PASSWORD '$app';
	CREATE DATABASE "$app" OWNER "$app";
SQL
done
