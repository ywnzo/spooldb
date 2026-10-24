#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -sm)" != 'Linux x86_64' ]; then
  echo 'This SpoolDB plugin bundle supports Linux x86-64.' >&2
  exit 1
fi
sh "$plugin_root/scripts/bootstrap.sh" "$plugin_root"
if [ -x "$plugin_root/app/runtime/bun" ]; then
  runtime="$plugin_root/app/runtime/bun"
elif [ -x "$plugin_root/app/runtime/node" ]; then
  runtime="$plugin_root/app/runtime/node"
else
  echo 'SpoolDB plugin runtime is missing. Install the built plugin package.' >&2
  exit 1
fi
exec "$runtime" "$plugin_root/app/src/plugin/entry.js" "$@"
