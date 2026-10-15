#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
env_file="${RADIO_ENV_FILE:-$project_dir/.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi
base="http://${ICECAST_HOST:-127.0.0.1}:${ICECAST_PORT:-8000}"
mount="${ICECAST_MOUNT:-/radio.mp3}"
duration="${SMOKE_SECONDS:-10}"
if [[ ! "$duration" =~ ^[1-9][0-9]{0,3}$ ]] || (( duration > 3600 )); then
  echo 'SMOKE_SECONDS must be 1..3600, without leading zeroes.' >&2
  exit 1
fi
for tool in curl ffmpeg python3; do command -v "$tool" >/dev/null || { printf '%s is required.\n' "$tool" >&2; exit 1; }; done
status="$(curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "$base/status-json.xsl")"
printf '%s' "$status" | python3 -c '
import json,sys
payload=json.load(sys.stdin)
sources=payload.get("icestats",{}).get("source",[])
if isinstance(sources,dict): sources=[sources]
mount=sys.argv[1]
if not any(source.get("listenurl","").endswith(mount) for source in sources):
    raise SystemExit("Icecast mount is offline: "+mount)
' "$mount"
# Icecast 2.4 rejects HEAD requests. Verify the mount with a bounded GET instead.
python3 - "$base$mount" <<'PY'
import sys,urllib.request
with urllib.request.urlopen(sys.argv[1],timeout=10) as response:
    if response.status != 200 or not response.read(1024):
        raise SystemExit('The stream mount did not return audio')
PY
progress_file="$(mktemp)"
trap 'rm -f -- "$progress_file"' EXIT
timeout "$((duration + 30))" ffmpeg -nostdin -hide_banner -loglevel error -xerror \
  -rw_timeout 10000000 -i "$base$mount" -t "$duration" -progress "$progress_file" -f null -
python3 - "$progress_file" "$duration" <<'PY'
import pathlib,sys
values=[int(line.split('=',1)[1]) for line in pathlib.Path(sys.argv[1]).read_text().splitlines() if line.startswith('out_time_us=') and line.split('=',1)[1].isdigit()]
actual=max(values,default=0)/1_000_000
requested=int(sys.argv[2])
if actual < requested-0.25: raise SystemExit(f'Stream ended early: decoded {actual:.2f}s; expected {requested}s')
PY
printf '{"event":"stream.smoke.passed","mount":"%s","decodedSeconds":%s}\n' "$mount" "$duration"
