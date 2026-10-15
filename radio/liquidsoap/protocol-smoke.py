#!/usr/bin/env python3
"""Verify the live Liquidsoap command contract with a locally generated jingle."""
import argparse
import datetime
import json
import pathlib
import re
import socket
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('--host', default='127.0.0.1')
parser.add_argument('--port', type=int, default=1234)
parser.add_argument('--storage-root', default=str(pathlib.Path(__file__).resolve().parents[2] / 'storage'))
options = parser.parse_args()


def command(line):
    if '\n' in line or '\r' in line:
        raise ValueError('Control characters are not permitted')
    with socket.create_connection((options.host, options.port), timeout=5) as connection:
        connection.settimeout(5)
        connection.sendall((line + '\n').encode())
        response = bytearray()
        while True:
            chunk = connection.recv(65536)
            if not chunk:
                raise RuntimeError('Command response ended before END')
            response.extend(chunk)
            if len(response) > 1024 * 1024:
                raise RuntimeError('Command response exceeded limit')
            match = re.search(rb'(?:^|\r?\n)END\r?\n', response)
            if match:
                result = response[:match.start()].decode().strip()
                if re.search(r'^(ERROR|Error|No such command|Unknown command)', result):
                    raise RuntimeError(result)
                return result


def snapshot():
    result = json.loads(command('radio.current'))
    assert result and result['eventId'] and result['path'], 'No actual current track'
    datetime.datetime.fromisoformat(result['startedAt'])
    return result


def enqueue(queue, filename, identity):
    metadata = {'queue_item_id': identity, 'type': 'jingle' if queue == 'priority' else 'track', 'title': 'Protocol test "jingle"', 'artist': 'Radio AI Demo'}
    annotation = ','.join(f'{key}={json.dumps(value)}' for key, value in metadata.items())
    identifier = command(f'{queue}.push annotate:{annotation}:{filename}')
    assert identifier.isdigit(), 'Push did not return a numeric request ID'
    return identifier


storage = pathlib.Path(options.storage_root).resolve()
jingle = storage / 'jingles' / 'demo-ident.mp3'
assert jingle.is_file(), 'Generate the legal demo jingle first'
deadline = time.monotonic() + 60
while time.monotonic() < deadline:
    try:
        assert json.loads(command('radio.health'))['ok'] is True
        before = snapshot()
        break
    except (OSError, ValueError, AssertionError):
        time.sleep(.5)
else:
    raise RuntimeError('Liquidsoap did not become ready within sixty seconds')
events = json.loads(command('radio.events'))
assert any(event['eventId'] == before['eventId'] for event in events)
repeated = json.loads(command('radio.events'))
assert events[-1]['eventId'] in {event['eventId'] for event in repeated}, 'Reading events must be nondestructive'

# Remove an actual music request before its track boundary. Never flush operator queues.
cancelled = 'smoke-cancel-' + uuid.uuid4().hex
music_file = next((storage / 'music').rglob('*.mp3'))
music_id = enqueue('music', music_file, cancelled)
assert all(identifier.isdigit() for identifier in command('music.queue').split())
assert cancelled in command('request.metadata ' + music_id)
command('music.remove ' + music_id)
assert music_id not in command('music.queue').split()

identity = 'smoke-play-' + uuid.uuid4().hex
request_id = enqueue('priority', jingle, identity)
assert identity in command('request.metadata ' + request_id)
removed_id = enqueue('priority', jingle, 'smoke-remove-' + uuid.uuid4().hex)
assert removed_id in command('priority.queue').split()
command('priority.remove ' + removed_id)
assert removed_id not in command('priority.queue').split()
print(json.dumps({'event': 'liquidsoap.protocol.enqueued', 'requestId': request_id}), flush=True)
deadline = time.monotonic() + 90
played = None
while time.monotonic() < deadline:
    played = next((event for event in json.loads(command('radio.events')) if event.get('queueItemId') == identity), None)
    if played:
        break
    time.sleep(0.5)
assert played, 'No actual output playback event arrived for the enqueued jingle'
assert played['type'] == 'jingle' and played['requestId'] == request_id
assert pathlib.Path(played['path']).resolve() == jingle
assert played['title'] == 'Protocol test "jingle"'
started = datetime.datetime.fromisoformat(played['startedAt'])
now = datetime.datetime.now(datetime.timezone.utc)
assert started.utcoffset() == datetime.timedelta(), 'Actual playback events must use explicit UTC'
assert abs((now - started).total_seconds()) < 10, 'Actual playback instant differs from UTC wall clock'
deadline = time.monotonic() + 20
while time.monotonic() < deadline:
    current = snapshot()
    if current['eventId'] != played['eventId'] and current['type'] in ('track', 'fallback'):
        break
    time.sleep(0.5)
else:
    raise AssertionError('Music did not resume after the priority jingle')

old_id = current['eventId']
assert command('radio.skip') == 'Done.'
deadline = time.monotonic() + 15
while time.monotonic() < deadline:
    if snapshot()['eventId'] != old_id:
        break
    time.sleep(0.5)
else:
    raise AssertionError('Skip produced no new output track event')
print(json.dumps({'event': 'liquidsoap.protocol.passed', 'playedEventId': played['eventId'], 'checks': ['health', 'current', 'events', 'music.push', 'music.queue', 'request.metadata', 'music.remove', 'priority.push', 'actual_playback', 'music_resumed', 'skip']}))
