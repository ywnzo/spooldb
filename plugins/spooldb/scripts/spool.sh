#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
case "$(uname -sm)" in
 'Linux x86_64') target=linux-x64 ;;
 'Darwin arm64') target=darwin-arm64 ;;
 *) echo 'SpoolDB supports Linux x86-64 and Apple Silicon macOS.' >&2; exit 1;;
esac
sh "$plugin_root/scripts/bootstrap.sh" "$plugin_root"
native="$plugin_root/app/runtime/spool-native-$target"
if [ "${1:-}" = mcp ] && [ -x "$native" ] && [ -f "$plugin_root/hooks/native-dispatch/run.sh" ]; then
  exec "$native" plugin-mcp "$plugin_root"
fi
if [ "$(uname -sm)" = 'Darwin arm64' ] && [ -x "$plugin_root/app/runtime/bun-darwin-arm64" ]; then
  runtime="$plugin_root/app/runtime/bun-darwin-arm64"
elif [ -x "$plugin_root/app/runtime/bun" ]; then
  runtime="$plugin_root/app/runtime/bun"
elif [ -x "$plugin_root/app/runtime/node" ]; then
  runtime="$plugin_root/app/runtime/node"
else
  echo 'SpoolDB plugin runtime is missing. Install the built plugin package.' >&2
  exit 1
fi
exec "$runtime" "$plugin_root/app/src/plugin/entry.js" "$@"
