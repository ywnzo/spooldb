#!/bin/sh
# Download and verify the latest official SpoolDB Linux installer.
set -eu
umask 077
case "$(uname -sm)" in 'Linux x86_64') ;; *) echo 'SpoolDB requires Linux x86-64 (glibc).' >&2; exit 1;; esac
tmp=$(mktemp -d "${TMPDIR:-/tmp}/spool-download.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM
base=https://github.com/ywnzo/spooldb/releases/latest/download
curl --fail --location --retry 3 --output "$tmp/SHA256SUMS" "$base/SHA256SUMS"
expected=$(awk '$2 == "spool-linux-x64.run" { print $1 }' "$tmp/SHA256SUMS")
case "$expected" in ''|*[!a-f0-9]*) echo 'Invalid installer checksum.' >&2; exit 1;; esac
[ "${#expected}" -eq 64 ] || { echo 'Invalid installer checksum length.' >&2; exit 1; }
curl --fail --location --retry 3 --output "$tmp/spool-linux-x64.run" "$base/spool-linux-x64.run"
printf '%s  %s\n' "$expected" "$tmp/spool-linux-x64.run" | sha256sum --check --status || { echo 'Installer checksum mismatch; nothing was installed.' >&2; exit 1; }
sh "$tmp/spool-linux-x64.run" "$@"
