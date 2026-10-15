#!/usr/bin/env bash
set -euo pipefail
umask 077
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
env_file="${RADIO_ENV_FILE:-$project_dir/.env}"
if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi
duration="${1:-${SOAK_SECONDS:-28800}}"
if [[ ! "$duration" =~ ^[1-9][0-9]{0,5}$ ]] || (( duration > 604800 )); then
  echo 'Soak duration must be 1..604800 seconds, without leading zeroes.' >&2
  exit 1
fi
storage="$(realpath -m "${STORAGE_ROOT:-$project_dir/storage}")"
mkdir -p "$storage/tmp"
run_dir="$(mktemp -d "$storage/tmp/soak-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
url="http://${ICECAST_HOST:-127.0.0.1}:${ICECAST_PORT:-8000}${ICECAST_MOUNT:-/radio.mp3}"
python3 - "$run_dir" "$duration" "$url" "$storage/tmp/soak-latest.json" <<'PY'
import datetime,json,pathlib,sys
directory,seconds,url,latest=sys.argv[1:]
payload={'status':'RUNNING','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'requestedSeconds':int(seconds),'streamUrl':url,'directory':directory}
pathlib.Path(directory,'start.json').write_text(json.dumps(payload,indent=2)+'\n')
temporary=pathlib.Path(latest+'.tmp')
temporary.write_text(json.dumps({'directory':directory})+'\n')
temporary.replace(latest)
print(json.dumps({'event':'stream.soak.started',**payload}),flush=True)
PY
decoder_exit=143
finalized=false
finish() {
  [[ "$finalized" == false ]] || return
  finalized=true
  python3 - "$run_dir" "$duration" "$decoder_exit" <<'PY'
import datetime,json,pathlib,sys
directory,requested,exit_code=sys.argv[1:]
root=pathlib.Path(directory)
payload=json.loads((root/'start.json').read_text())
progress=(root/'progress.txt').read_text() if (root/'progress.txt').exists() else ''
times=[int(line.split('=',1)[1]) for line in progress.splitlines() if line.startswith('out_time_us=') and line.split('=',1)[1].isdigit()]
decoded=max(times,default=0)/1_000_000
success=int(exit_code)==0 and decoded>=int(requested)-0.25 and 'progress=end' in progress
payload.update({'status':'SUCCEEDED' if success else 'FAILED','finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'decoderExitCode':int(exit_code),'decodedSeconds':decoded,'reason':None if success else ('DECODER_FAILURE' if int(exit_code) else 'EARLY_EOF')})
temporary=root/'finish.json.tmp'
temporary.write_text(json.dumps(payload,indent=2)+'\n')
temporary.replace(root/'finish.json')
print(json.dumps({'event':'stream.soak.passed' if success else 'stream.soak.failed',**payload}),flush=True)
raise SystemExit(0 if success else 1)
PY
}
trap 'finish || true' EXIT
trap 'decoder_exit=130; exit 130' INT
trap 'decoder_exit=143; exit 143' TERM
# HTTP read timeout detects stalled audio; outer timeout also bounds startup/shutdown.
if timeout --kill-after=15 "$((duration + 60))" ffmpeg -nostdin -hide_banner \
  -loglevel warning -xerror -rw_timeout 15000000 -i "$url" -t "$duration" \
  -progress "$run_dir/progress.txt" -f null - >/dev/null 2>"$run_dir/decoder.log"; then
  decoder_exit=0
else
  decoder_exit=$?
fi
finish
