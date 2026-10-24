#!/bin/sh
# Offline, project-scoped cleanup. Local backups remain private and are not served.
set -eu
umask 077
[ "$(id -u)" -eq 0 ] || { echo 'Run this cleanup with sudo.' >&2; exit 1; }
[ "$#" -eq 1 ] || { echo 'Supply the exact shared project name.' >&2; exit 1; }
if command -v podman >/dev/null 2>&1 && podman container inspect spool-relay >/dev/null 2>&1; then engine=podman
elif command -v docker >/dev/null 2>&1 && docker container inspect spool-relay >/dev/null 2>&1; then engine=docker
else echo 'The managed spool-relay container was not found.' >&2; exit 1; fi
image=$($engine inspect --format '{{.Image}}' spool-relay)
tmp=$(mktemp -d /tmp/spool-conversation-cleanup.XXXXXXXX)
trap 'rm -rf "$tmp"' EXIT
curl --fail --location --max-time 60 https://raw.githubusercontent.com/ywnzo/spooldb/main/src/team/purge-conversations.js -o "$tmp/purge-conversations.js"
# The one-off cleanup runs as the same non-root user as the relay image.
chmod 755 "$tmp"
chmod 644 "$tmp/purge-conversations.js"
$engine stop --time 30 spool-relay
trap '$engine start spool-relay >/dev/null; rm -rf "$tmp"' EXIT
$engine run --rm --network none \
 --mount type=volume,source=spool-relay-data,target=/data \
 --mount "type=bind,source=$tmp/purge-conversations.js,target=/app/src/team/purge-conversations.js,readonly" \
 "$image" bun src/team/purge-conversations.js /data "$1" --confirm
