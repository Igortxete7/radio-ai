#!/usr/bin/env bash
# Exercise the real emergency source on a separate port/mount, preserving on-air audio.
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
if (( EUID != 0 )); then
  echo 'Run this isolated systemd validation with sudo.' >&2
  exit 1
fi
unit=radio-emergency-validation
if systemctl is-active --quiet "$unit"; then
  echo 'An emergency validation is already active.' >&2
  exit 1
fi
python3 - <<'PY'
import socket
with socket.socket() as connection:
    connection.bind(('127.0.0.1', 1235))
PY
test_root="$(mktemp -d "$project_dir/storage/tmp/emergency-validation-XXXXXX")"
mkdir -p "$test_root/fallback" "$test_root/tmp"
cp -- "$project_dir/storage/fallback/emergency.mp3" "$test_root/fallback/emergency.mp3"
: > "$test_root/music-playlist.m3u"
chown -R radio:radio "$test_root"
cleanup() {
  systemctl stop "$unit" >/dev/null 2>&1 || true
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
}
trap cleanup EXIT
systemd-run --quiet --collect --unit="$unit" --uid=radio --gid=radio \
  --property="WorkingDirectory=$project_dir" \
  --property=EnvironmentFile=/etc/radio-ai/radio.env \
  /usr/bin/env RADIO_ENV_FILE=/dev/null "STORAGE_ROOT=$test_root" \
  LIQUIDSOAP_PORT=1235 ICECAST_MOUNT=/emergency-test.mp3 CROSSFADE_SECONDS=0 \
  /usr/bin/bash "$project_dir/radio/liquidsoap/run.sh"
python3 - "$test_root" <<'PY'
import datetime,json,pathlib,re,socket,sys,time,urllib.request
root=pathlib.Path(sys.argv[1])
deadline=time.monotonic()+60
last_error='No playback event yet'
while time.monotonic()<deadline:
    try:
        with socket.create_connection(('127.0.0.1',1235),timeout=3) as connection:
            connection.settimeout(3)
            connection.sendall(b'radio.current\n')
            response=b''
            while not re.search(rb'(?:^|\r?\n)END\r?\n',response):
                data=connection.recv(65536)
                if not data or len(response)>1048576:
                    raise RuntimeError('Invalid Liquidsoap response')
                response+=data
            current=json.loads(re.split(rb'(?:^|\r?\n)END\r?\n',response)[0])
        if current and current['type']=='fallback':
            assert pathlib.Path(current['path']).resolve()==root/'fallback'/'emergency.mp3'
            assert current['startedAt'].endswith('Z')
            started=datetime.datetime.fromisoformat(current['startedAt'])
            assert abs((datetime.datetime.now(datetime.timezone.utc)-started).total_seconds())<10
            report={'event':'liquidsoap.emergency.actual_playback','checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'current':current,'emptyPlaylist':True}
            (root/'playback.json').write_text(json.dumps(report,indent=2)+'\n')
            print(json.dumps(report),flush=True)
            break
    except (OSError,ValueError,RuntimeError) as error:
        last_error=str(error)
    time.sleep(.5)
else:
    raise RuntimeError('Emergency source did not start: '+last_error)
# The first source callback can precede Icecast's mount registration.
deadline=time.monotonic()+30
while time.monotonic()<deadline:
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/status-json.xsl',timeout=3) as response:
            sources=json.load(response)['icestats'].get('source',[])
        sources=sources if isinstance(sources,list) else [sources]
        if any(source.get('listenurl','').endswith('/emergency-test.mp3') for source in sources):
            break
    except (OSError,ValueError,KeyError):
        pass
    time.sleep(.5)
else:
    raise RuntimeError('Icecast did not register the emergency validation mount')
PY
runuser -u radio -- /usr/bin/env RADIO_ENV_FILE=/dev/null "STORAGE_ROOT=$test_root" \
  ICECAST_HOST=127.0.0.1 ICECAST_PORT=8000 ICECAST_MOUNT=/emergency-test.mp3 \
  /usr/bin/bash "$project_dir/scripts/smoke-stream.sh"
printf 'Emergency playback and ten-second decode passed; report: %s/playback.json\n' "$test_root"
