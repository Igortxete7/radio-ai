#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$project_dir"
env_file="${RADIO_ENV_FILE:-$project_dir/.env}"
[[ -f "$env_file" ]] || { echo 'Configure the private .env first.' >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a
for name in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD; do
  [[ -n "${!name:-}" ]] || { printf 'Set %s in the private environment.\n' "$name" >&2; exit 1; }
done
if (( EUID == 0 )); then as_root=(); else as_root=(sudo); fi
temporary_file="$(mktemp)"
trap 'rm -f -- "$temporary_file"' EXIT
python3 - "$project_dir/radio/icecast/icecast.xml.example" "$temporary_file" <<'PY'
import os,sys,xml.etree.ElementTree as ET
tree=ET.parse(sys.argv[1])
root=tree.getroot()
for node,variable in [('source-password','ICECAST_SOURCE_PASSWORD'),('admin-password','ICECAST_ADMIN_PASSWORD'),('relay-password','ICECAST_RELAY_PASSWORD')]:
    root.find('authentication/'+node).text=os.environ[variable]
root.find('listen-socket/port').text=os.environ.get('ICECAST_PORT','8000')
tree.write(sys.argv[2],encoding='unicode',xml_declaration=True)
PY
if [[ -f /etc/icecast2/icecast.xml ]] && ! "${as_root[@]}" cmp -s "$temporary_file" /etc/icecast2/icecast.xml; then
  "${as_root[@]}" cp -p /etc/icecast2/icecast.xml "/etc/icecast2/icecast.xml.before-radio-ai.$(date -u +%Y%m%dT%H%M%SZ)"
fi
"${as_root[@]}" install -o root -g icecast -m 0640 "$temporary_file" /etc/icecast2/icecast.xml
"${as_root[@]}" install -d -o icecast2 -g icecast -m 0750 /var/log/icecast2
if [[ -f /etc/default/icecast2 ]]; then "${as_root[@]}" sed -i 's/^ENABLE=.*/ENABLE=true/' /etc/default/icecast2; fi
if [[ "${1:-}" != --no-restart ]]; then "${as_root[@]}" systemctl enable --now icecast2; "${as_root[@]}" systemctl restart icecast2; fi
echo 'Private Icecast configuration installed; listener binds to localhost.'
