#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
command -v liquidsoap >/dev/null || { echo 'Liquidsoap is missing. Run bash scripts/bootstrap-wsl.sh in Ubuntu.' >&2; exit 1; }
bash "$project_dir/radio/liquidsoap/run.sh" --check
