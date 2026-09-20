#!/usr/bin/env sh

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd -- "$script_dir" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 22.22 or newer:"
  echo "https://nodejs.org/"
  exit 1
fi

exec node apps/cli/wizard.mjs
