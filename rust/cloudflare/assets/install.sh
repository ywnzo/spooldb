#!/bin/sh
set -eu
umask 077
case "$(uname -sm)" in 'Linux x86_64') ;; *) echo 'SpoolDB currently supports Linux x86-64.' >&2; exit 1;; esac
for tool in curl sha256sum tar; do command -v "$tool" >/dev/null 2>&1 || { echo "Please install $tool and retry." >&2; exit 1; }; done
tmp=$(mktemp -d "${TMPDIR:-/tmp}/spool-download.XXXXXXXX")
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM
printf '%s\n' 'Downloading SpoolDB…'
curl --fail --location --retry 3 --output "$tmp/installer.run" @DOWNLOAD_URL@
printf '%s  %s\n' '@SHA256@' "$tmp/installer.run" | sha256sum --check --status || { echo 'Installer checksum mismatch; nothing was installed.' >&2; exit 1; }
sh "$tmp/installer.run" "$@"
