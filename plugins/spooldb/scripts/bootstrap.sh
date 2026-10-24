#!/bin/sh
# Git-marketplace installs download the exact release payload pinned by this plugin.
set -eu
umask 077
plugin_root=$1
if [ -x "$plugin_root/app/runtime/bun" ] || [ -x "$plugin_root/app/runtime/node" ]; then exit 0; fi
for command in curl tar cmp mktemp; do
  command -v "$command" >/dev/null 2>&1 || { echo "SpoolDB setup needs $command." >&2; exit 1; }
done
[ -f "$plugin_root/payload.sha256" ] && [ -f "$plugin_root/payload.url" ] || { echo 'SpoolDB runtime is missing. Reinstall from the SpoolDB marketplace.' >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1"; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1"; }
else echo 'SpoolDB setup needs shasum or sha256sum.' >&2; exit 1; fi
read -r expected ignored < "$plugin_root/payload.sha256"
case "$expected" in ''|*[!a-f0-9]*) echo 'Invalid SpoolDB payload checksum.' >&2; exit 1;; esac
[ "${#expected}" -eq 64 ] || { echo 'Invalid SpoolDB payload checksum length.' >&2; exit 1; }
url=$(cat "$plugin_root/payload.url")
case "$url" in https://github.com/ywnzo/spooldb/releases/download/v*/spooldb-codex.tar.gz) ;; *) echo 'Invalid SpoolDB release URL.' >&2; exit 1;; esac
stage=$(mktemp -d "$plugin_root/.payload.XXXXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 130' INT TERM
printf '%s\n' 'SpoolDB: preparing its bundled runtime (first launch only)…' >&2
curl --fail --location --retry 2 --connect-timeout 15 --max-time 100 --max-filesize 150000000 --silent --show-error --output "$stage/payload.tar.gz" "$url"
actual=$(checksum "$stage/payload.tar.gz")
[ "${actual%% *}" = "$expected" ] || { echo 'SpoolDB download checksum mismatch; nothing was installed.' >&2; exit 1; }
# The archive is authenticated against the checksum shipped in the marketplace commit.
mkdir "$stage/extracted"
tar -xzf "$stage/payload.tar.gz" -C "$stage/extracted"
payload="$stage/extracted/plugins/spooldb"
cmp "$plugin_root/hooks/hooks.json" "$payload/hooks/hooks.json" >/dev/null || { echo 'SpoolDB payload does not match the reviewed hook definitions.' >&2; exit 1; }
cmp "$plugin_root/hooks/runtime-profile.json" "$payload/hooks/runtime-profile.json" >/dev/null || { echo 'SpoolDB payload hook fingerprint differs from this plugin.' >&2; exit 1; }
[ -x "$payload/app/runtime/bun" ] || { echo 'SpoolDB payload has no bundled runtime.' >&2; exit 1; }
# mkdir is a portable exclusive lock; retry if another launcher is preparing the payload.
if mkdir "$plugin_root/.payload-lock" 2>/dev/null; then
 trap 'rmdir "$plugin_root/.payload-lock" 2>/dev/null || :; rm -rf "$stage"' EXIT
 if [ ! -e "$plugin_root/app" ]; then mv "$payload/app" "$plugin_root/app"; fi
else
 attempts=0
 while [ ! -x "$plugin_root/app/runtime/bun" ] && [ "$attempts" -lt 30 ]; do sleep 1; attempts=$((attempts+1)); done
fi
[ -x "$plugin_root/app/runtime/bun" ] || { echo 'SpoolDB could not finish runtime setup; retry the connection.' >&2; exit 1; }
