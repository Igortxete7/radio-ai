# Liquidsoap owns the audio clock. The worker only fills the queues.
# Validated version is recorded in docs/SETUP_WSL.md.
settings.log.stdout.set(true)
settings.log.file.set(false)
settings.server.telnet.set(true)
settings.server.telnet.bind_addr.set("127.0.0.1")
settings.server.telnet.port.set(int_of_string(default=1234, environment.get("LIQUIDSOAP_PORT")))

def env(name, default) =
  value = environment.get(name)
  if value == "" then default else value end
end

storage = env("STORAGE_ROOT", "./storage")
station = env("STATION_NAME", "Radio AI")

# Native interactive commands: music.push/queue/remove, priority.push/queue/remove.
# Metadata on requests: queue_item_id, type, title, artist.
music_queue = request.queue(id="music", prefetch=2)
priority_queue = request.queue(id="priority", prefetch=1)

# This source remains available when the worker or database is offline.
# Scanner atomically updates this watched playlist with enabled playable tracks.
local_music = playlist(
  id="library_fallback", mode="randomize", reload_mode="watch",
  storage ^ "/music-playlist.m3u"
)
local_music = metadata.map(fun (m) -> [("type", "track"), ...m], local_music)

emergency = single(id="emergency", storage ^ "/fallback/emergency.mp3")
emergency = metadata.map(
  fun (_) -> [("title", "Emergency continuity"), ("artist", station), ("type", "fallback")],
  emergency
)

# Crossfade is inside the music branch; speech and jingles never overlap it.
music = fallback(id="music_continuity", track_sensitive=true, [music_queue, local_music, emergency])
music = crossfade(duration=float_of_string(default=5., env("CROSSFADE_SECONDS", "5")), music)
# Track-sensitive priority insertion waits for the next track boundary.
radio = fallback(id="programme", track_sensitive=true, [priority_queue, music])
radio = normalize(radio)
radio = mksafe(radio)

# Record events after all selection/transition operators, at actual output track starts.
# Events are a bounded nondestructive ring so a restarted worker can reconcile playback.
boot_id = string(time())
sequence_number = ref(0)
current_json = ref("null")
event_json = ref([])

def value_or(m, key, default) =
  value = m[key]
  if value == "" then default else value end
end

def two_digits(value) =
  if value < 10 then "0" ^ string(value) else string(value) end
end

def record_track(m) =
  sequence_number := sequence_number() + 1
  # Build an explicit UTC instant. time.string's local %z can omit DST.
  utc = time.utc()
  event = {
    eventId = boot_id ^ ":" ^ string(sequence_number()),
    queueItemId = m["queue_item_id"],
    requestId = m["rid"],
    path = value_or(m, "filename", m["initial_uri"]),
    title = value_or(m, "title", "Unknown track"),
    artist = m["artist"],
    startedAt = string(utc.year) ^ "-" ^ two_digits(utc.month) ^ "-" ^ two_digits(utc.day) ^
      "T" ^ two_digits(utc.hour) ^ ":" ^ two_digits(utc.min) ^ ":" ^ two_digits(utc.sec) ^ "Z",
    type = value_or(m, "type", "track")
  }
  rendered = json.stringify(compact=true, event)
  current_json := rendered
  event_json := list.prefix(256, [rendered, ...event_json()])
end

radio.on_track(synchronous=true, record_track)
server.register(namespace="radio", description="Current actual output track, JSON or null", "current", fun (_) -> current_json())
server.register(namespace="radio", description="Latest 256 actual track events, oldest first, JSON array", "events", fun (_) -> "[" ^ string.concat(separator=",", list.rev(event_json())) ^ "]")
server.register(namespace="radio", description="Local audio engine health", "health", fun (_) -> json.stringify(compact=true, {ok=true, uptimeSec=time.up()}))
server.register(namespace="radio", description="Skip the current output track", "skip", fun (_) -> begin radio.skip() "Done." end)

output.icecast(
  %mp3(bitrate=128, stereo=true),
  id="icecast_output",
  host=env("ICECAST_HOST", "127.0.0.1"),
  port=int_of_string(default=8000, env("ICECAST_PORT", "8000")),
  password=environment.get("ICECAST_SOURCE_PASSWORD"),
  mount=env("ICECAST_MOUNT", "/radio.mp3"),
  name=station,
  description="Music radio with an AI generated presenter",
  public=false,
  radio
)
