#!/usr/bin/env bash
set -euo pipefail
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"
[[ -f /etc/os-release ]] || { echo 'Run this script inside Ubuntu WSL2 or Ubuntu Server.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ "${ID:-}" == ubuntu ]] || { echo 'This bootstrap supports Ubuntu.' >&2; exit 1; }
if (( EUID == 0 )); then as_root=(); else as_root=(sudo); fi
export DEBIAN_FRONTEND=noninteractive
"${as_root[@]}" apt-get update
"${as_root[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg git build-essential ffmpeg sqlite3 icecast2 python3 shellcheck

# Noble has a stable 2.4.6 package; the 2.5 release candidate has no Noble build.
# Set LIQUIDSOAP_CHANNEL explicitly only when intentionally upgrading to a supported release.
channel="${LIQUIDSOAP_CHANNEL:-v2.4.6}"
temporary_dir="$(mktemp -d)"
trap 'rm -rf -- "$temporary_dir"' EXIT
curl --fail --silent --show-error --location --retry 2 \
  https://repo.liquidsoap.info/setup.sh -o "$temporary_dir/liquidsoap-setup.sh"
"${as_root[@]}" sh "$temporary_dir/liquidsoap-setup.sh" --channel "$channel"
package_version="$(apt-cache madison liquidsoap | awk -F '|' 'NR == 1 {gsub(/^[ \t]+|[ \t]+$/, "", $2); print $2}')"
[[ -n "$package_version" ]] || { echo 'No Liquidsoap package candidate is available.' >&2; exit 1; }
if [[ "$channel" == v2.4.6 && "${package_version#*:}" != 2.4.6* ]]; then
  printf 'Expected Liquidsoap 2.4.6; apt offered %s. Refusing an implicit version change.\n' "$package_version" >&2
  exit 1
fi
"${as_root[@]}" apt-get install -y "liquidsoap=$package_version"

# Install an official Node.js 24 LTS binary with its published SHA256 digest.
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
  case "$(uname -m)" in x86_64) architecture=x64 ;; aarch64) architecture=arm64 ;; *) echo 'Unsupported Node architecture.' >&2; exit 1 ;; esac
  curl --fail --silent --show-error --location --retry 2 \
    https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$temporary_dir/SHASUMS256.txt"
  archive="$(awk -v arch="$architecture" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2; exit}' "$temporary_dir/SHASUMS256.txt")"
  [[ -n "$archive" ]] || { echo 'Could not resolve an official Node 24 archive.' >&2; exit 1; }
  curl --fail --silent --show-error --location --retry 2 \
    "https://nodejs.org/dist/latest-v24.x/$archive" -o "$temporary_dir/$archive"
  (cd "$temporary_dir"; awk -v file="$archive" '$2 == file' SHASUMS256.txt | sha256sum --check -)
  runtime_dir="/opt/radio-ai-runtime/${archive%.tar.xz}"
  "${as_root[@]}" install -d "$runtime_dir"
  "${as_root[@]}" tar -xJf "$temporary_dir/$archive" --strip-components=1 -C "$runtime_dir"
  for executable in node npm npx; do
    # Preserve any operator-installed binary before changing the default runtime.
    target="/usr/local/bin/$executable"
    if [[ -e "$target" && ! -L "$target" && ! -e "$target.before-radio-ai" ]]; then
      "${as_root[@]}" cp -p "$target" "$target.before-radio-ai"
    fi
    "${as_root[@]}" ln -sfn "$runtime_dir/bin/$executable" "$target"
  done
  hash -r
fi

if [[ ! -f .env && -f .env.example ]]; then
  (umask 077; cp .env.example .env)
fi
if [[ -f .env ]]; then
  python3 - <<'PY'
import pathlib, re, secrets, os
path=pathlib.Path('.env')
text=path.read_text()
for key in ('ICECAST_SOURCE_PASSWORD','ICECAST_ADMIN_PASSWORD','ICECAST_RELAY_PASSWORD','ADMIN_TOKEN'):
    pattern=re.compile(r'^'+key+r'=\s*$',re.MULTILINE)
    if pattern.search(text): text=pattern.sub(key+'='+secrets.token_hex(32),text)
path.write_text(text)
os.chmod(path,0o600)
PY
fi
bash scripts/generate-demo-audio.sh
mkdir -p storage/tmp
{
  date -u '+Verified at %Y-%m-%dT%H:%M:%SZ'
  printf 'OS: %s\nLiquidsoap channel: %s\n' "$PRETTY_NAME" "$channel"
  node --version
  npm --version
  liquidsoap --version
  icecast2 -v 2>&1
  ffmpeg -version | sed -n '1p'
  printf 'PID 1: '; ps -p 1 -o comm=
} > storage/tmp/environment-versions.txt
cat storage/tmp/environment-versions.txt
"${as_root[@]}" apt-get clean
if [[ "$(ps -p 1 -o comm= | tr -d ' ')" != systemd ]]; then
  echo 'systemd is not PID 1. Follow docs/SETUP_WSL.md before installing services.' >&2
fi
printf '\nBootstrap complete. Configure .env, then npm ci and npm run db:migrate.\n'
