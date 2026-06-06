#!/bin/sh
# Start as root only long enough to make the persistent data volume writable by the
# unprivileged 'node' user (Coolify may mount it root-owned), then drop privileges and
# run the app as 'node'. A code-exec bug then runs unprivileged, not as root.
set -e
mkdir -p /app/data
chown -R node:node /app/data 2>/dev/null || true
exec gosu node "$@"
