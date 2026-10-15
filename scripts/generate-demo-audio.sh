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
storage="${STORAGE_ROOT:-$project_dir/storage}"
command -v ffmpeg >/dev/null || { echo 'FFmpeg is required.' >&2; exit 1; }
mkdir -p "$storage"/{music,jingles,generated,fallback,tmp}
# Mathematical tones generated locally; no copyrighted recording is downloaded.
for index in 1 2 3 4 5 6; do
  destination="$storage/music/Radio AI Demo - Synthetic $index.mp3"
  [[ -s "$destination" ]] && continue
  frequency=$((180 + index * 55))
  ffmpeg -nostdin -hide_banner -loglevel error -f lavfi \
    -i "aevalsrc=0.07*sin(2*PI*$frequency*t)+0.035*sin(2*PI*$frequency*1.5*t)+0.025*sin(2*PI*$frequency*2*t):s=44100:d=32" \
    -af 'afade=t=in:d=1,afade=t=out:st=30:d=2' -ac 2 -c:a libmp3lame -b:a 128k \
    -metadata title="Synthetic $index" -metadata artist="Radio AI Demo $index" \
    -metadata album='Locally generated test tones' "$destination"
done
if [[ ! -s "$storage/fallback/emergency.mp3" ]]; then
  ffmpeg -nostdin -hide_banner -loglevel error -f lavfi \
    -i 'aevalsrc=0.06*sin(2*PI*220*t)+0.035*sin(2*PI*330*t)+0.025*sin(2*PI*440*t):s=44100:d=30' \
    -ac 2 -c:a libmp3lame -b:a 128k -metadata title='Emergency continuity' \
    -metadata artist='Radio AI Demo' "$storage/fallback/emergency.mp3"
fi
if [[ ! -s "$storage/jingles/demo-ident.mp3" ]]; then
  ffmpeg -nostdin -hide_banner -loglevel error -f lavfi \
    -i 'sine=frequency=880:sample_rate=44100:duration=3' \
    -af 'volume=0.15,afade=t=in:d=0.2,afade=t=out:st=2:d=1' \
    -ac 2 -c:a libmp3lame -b:a 128k -metadata title='Radio AI test ident' \
    -metadata artist='Radio AI Demo' "$storage/jingles/demo-ident.mp3"
fi
if [[ ! -f "$storage/music-playlist.m3u" ]]; then
  python3 - "$storage" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve()
extensions={'.mp3','.m4a','.flac','.ogg','.wav'}
tracks=sorted(str(path) for path in (root/'music').rglob('*') if path.is_file() and path.suffix.lower() in extensions and '\n' not in str(path) and '\r' not in str(path))
(root/'music-playlist.m3u').write_text('#EXTM3U\n'+'\n'.join(tracks)+'\n')
PY
fi
ffmpeg -nostdin -hide_banner -loglevel error -i "$storage/fallback/emergency.mp3" -f null -
printf 'Demo audio and verified emergency loop ready in %s\n' "$storage"
