# The shared Postgres, with the per-app role/database bootstrap baked in.
#
# Baked into an image rather than bind-mounted from ./deploy: a bind mount
# resolves on the *daemon's* filesystem, so it silently mounts an empty
# directory whenever the docker context is a remote host over SSH — which is
# exactly how this stack is deployed. A build context is uploaded to the
# daemon, so it works the same locally and remotely.
FROM postgres:17-alpine
COPY 01-app-databases.sh /docker-entrypoint-initdb.d/01-app-databases.sh
