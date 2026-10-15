#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
# The private .env is trusted operator configuration, in shell-compatible syntax.
env_file="${RADIO_ENV_FILE:-$project_dir/.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi
exec liquidsoap "$@" "$project_dir/radio/liquidsoap/radio.liq"
