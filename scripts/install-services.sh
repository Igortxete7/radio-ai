#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
[[ "$(ps -p 1 -o comm= | tr -d ' ')" == systemd ]] || { echo 'systemd must be PID 1; see docs/SETUP_WSL.md.' >&2; exit 1; }
[[ "$project_dir" != /mnt/* ]] || { echo 'Copy the repository into the Linux filesystem before installing services.' >&2; exit 1; }
[[ "$project_dir" != *$'\n'* && "$project_dir" != *'"'* && "$project_dir" != *'%'* ]] || { echo 'Unsupported application path.' >&2; exit 1; }
env_file="${RADIO_ENV_FILE:-$project_dir/.env}"
[[ -f "$env_file" ]] || { echo 'Create and configure .env first.' >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
for name in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD ADMIN_TOKEN; do
  [[ -n "${!name:-}" ]] || { printf 'Set %s in the private .env first.\n' "$name" >&2; exit 1; }
done
[[ "${ICECAST_HOST:-127.0.0.1}" == 127.0.0.1 || "${ICECAST_HOST:-}" == localhost ]] || { echo 'This installer configures a local Icecast; use ICECAST_HOST=127.0.0.1.' >&2; exit 1; }
[[ -f apps/web/.next/BUILD_ID ]] || { echo 'Run npm run build before installing production services.' >&2; exit 1; }
for tool in node npm liquidsoap ffmpeg python3; do command -v "$tool" >/dev/null || { printf '%s is missing.\n' "$tool" >&2; exit 1; }; done
if (( EUID == 0 )); then as_root=(); else as_root=(sudo); fi
if ! id radio >/dev/null 2>&1; then
  "${as_root[@]}" useradd --create-home --home-dir /home/radio --shell /usr/sbin/nologin radio
fi
[[ "$(id -u radio)" != 0 ]] || { echo 'The radio service user must not be root.' >&2; exit 1; }
storage="$(realpath -m "${STORAGE_ROOT:-$project_dir/storage}")"
[[ "$storage" != / && "$storage" != /home && "$storage" != /var ]] || { echo 'Unsafe storage directory.' >&2; exit 1; }
mkdir -p "$storage"/{music,jingles,generated,fallback,tmp}
[[ -s "$storage/fallback/emergency.mp3" ]] || { echo 'The emergency loop is missing. Run bash scripts/generate-demo-audio.sh.' >&2; exit 1; }
ffmpeg -nostdin -hide_banner -loglevel error -i "$storage/fallback/emergency.mp3" -f null -
bash scripts/radio-check.sh
"${as_root[@]}" chown -R radio:radio "$storage"
"${as_root[@]}" chown -R radio:radio "$project_dir/apps/web/.next"
# Grant traversal/read access to this checkout to the dedicated service user.
# Never recursively make a home directory public; require its owner to grant traversal.
if (( EUID == 0 )); then
  runuser -u radio -- test -r "$project_dir/package.json" || { echo 'radio cannot read the application. Install under /home/radio or /opt.' >&2; exit 1; }
else
  sudo -u radio test -r "$project_dir/package.json" || { echo 'radio cannot read the application. Install under /home/radio or /opt.' >&2; exit 1; }
fi
"${as_root[@]}" install -d -o root -g radio -m 0750 /etc/radio-ai

temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT
python3 - "$env_file" "$temporary_dir/radio.env" "$project_dir" "$storage" <<'PY'
import os, pathlib, re, sys
source, destination, project, storage=sys.argv[1:]
text=pathlib.Path(source).read_text()
database=os.environ.get('DATABASE_URL','file:../storage/radio.db')
if not database.startswith('file:'): raise SystemExit('SQLite DATABASE_URL must start with file:')
database_path=pathlib.Path(database[5:])
if not database_path.is_absolute(): database_path=pathlib.Path(project,'prisma',database_path).resolve()
for key,value in {'NODE_ENV':'production','STORAGE_ROOT':storage,'DATABASE_URL':'file:'+str(database_path)}.items():
    if any(character in value for character in "'\r\n"): raise SystemExit('Installation paths must not contain quotes or newlines')
    quoted="'"+value+"'"
    pattern=re.compile(r'^'+key+r'=.*$',re.MULTILINE)
    text=pattern.sub(key+'='+quoted,text) if pattern.search(text) else text+'\n'+key+'='+quoted+'\n'
pathlib.Path(destination).write_text(text)
PY
"${as_root[@]}" install -o root -g radio -m 0640 "$temporary_dir/radio.env" /etc/radio-ai/radio.env
bash "$project_dir/radio/icecast/configure.sh" --no-restart
npm_bin="$(command -v npm)"
node_bin_dir="$(dirname -- "$(command -v node)")"
node_bin="$(command -v node)"
if (( EUID == 0 )); then
  runuser -u radio -- "$node_bin" --version >/dev/null
  runuser -u radio -- "$npm_bin" --version >/dev/null
else
  sudo -u radio "$node_bin" --version >/dev/null
  sudo -u radio "$npm_bin" --version >/dev/null
fi
python3 - "$project_dir" "$npm_bin" "$node_bin_dir" "$temporary_dir" <<'PY'
import pathlib, sys
project, npm, node_dir, output = sys.argv[1:]
for unit in pathlib.Path(project,'radio','systemd').glob('*.service'):
    text=unit.read_text().replace('@APP_DIR@',project).replace('@NPM_BIN@',npm)
    text=text.replace('[Service]\n','[Service]\nEnvironment=PATH='+node_dir+':/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n')
    pathlib.Path(output,unit.name).write_text(text)
PY
# Stop the distro's legacy SysV unit before replacing it. Its MainPID is 0,
# so it cannot detect/restart a crashed source distributor.
"${as_root[@]}" systemctl stop icecast2
"${as_root[@]}" install -o root -g root -m 0644 "$temporary_dir"/*.service /etc/systemd/system/
"${as_root[@]}" install -d -o root -g root -m 0755 /etc/systemd/system/icecast2.service.d
printf '[Service]\nRestart=on-failure\nRestartSec=3\n' > "$temporary_dir/icecast-restart.conf"
"${as_root[@]}" install -o root -g root -m 0644 "$temporary_dir/icecast-restart.conf" /etc/systemd/system/icecast2.service.d/radio-ai.conf
"${as_root[@]}" systemctl daemon-reload
"${as_root[@]}" systemctl enable icecast2 radio-liquidsoap radio-worker radio-web
"${as_root[@]}" systemctl restart icecast2 radio-liquidsoap radio-worker radio-web
"${as_root[@]}" systemctl --no-pager --full status icecast2 radio-liquidsoap radio-worker radio-web
printf '\nServices installed under the non-root radio account; private environment: /etc/radio-ai/radio.env\n'
