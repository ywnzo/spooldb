#!/bin/sh
set -eu
profile=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root="${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}"
if [ -z "$root" ]; then echo 'SpoolDB hook: plugin location was not provided by Codex.' >&2; exit 1; fi
root=$(CDPATH= cd -- "$root" && pwd -P)
cd -- "$root"
while read -r checksum file; do
  # Resolve each parent physically and reject a symlink at the leaf.
  parent=$(CDPATH= cd -- "$(dirname -- "$file")" && pwd -P)
  if [ -L "$file" ] || [ "$parent/$(basename -- "$file")" != "$root/$file" ]; then
    echo 'SpoolDB hook dependencies must not be redirected through symlinks.' >&2
    exit 1
  fi
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$file"); else actual=$(shasum -a 256 "$file"); fi
  if [ "${actual%% *}" != "$checksum" ]; then
    echo 'SpoolDB hook code changed or is incomplete. Reinstall/update the plugin and review its changed hook definition.' >&2
    exit 1
  fi
done < "$profile/files.sha256"
runtime="$root/app/runtime/spool-hook-linux-x64"
if [ "$(uname -sm)" = 'Darwin arm64' ] && [ -x "$root/app/runtime/spool-hook-darwin-arm64" ]; then runtime="$root/app/runtime/spool-hook-darwin-arm64"; fi
exec "$runtime" "$@"
