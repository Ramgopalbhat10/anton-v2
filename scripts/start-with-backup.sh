#!/bin/sh
# Production start with database backup. Brings back both SQLite files from
# Tigris when this server has none, then runs Anton under Litestream, which
# streams every write back. A failed restore stops here: starting on an empty
# database would lose every task.
set -eu
cd "$(dirname "$0")/.."
data="${ANTON_DATA_DIR:-data}"
case "$data" in /*) ;; *) data="$PWD/$data" ;; esac
export ANTON_DATA_DIR="$data"
export TIGRIS_ENDPOINT="${TIGRIS_ENDPOINT:-https://t3.storage.dev}"
config="${LITESTREAM_CONFIG:-litestream.yml}"
: "${TIGRIS_BUCKET:?Set TIGRIS_BUCKET and the Tigris keys to back up the database}"
mkdir -p "$ANTON_DATA_DIR"
for db in anton flue; do
	litestream restore -config "$config" -if-db-not-exists -if-replica-exists "$ANTON_DATA_DIR/$db.db"
done
exec litestream replicate -config "$config" -exec "node src/server.ts"
