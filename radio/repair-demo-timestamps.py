#!/usr/bin/env python3
"""Audited one-time repair of the proven +1h validation boot, never general history."""
import argparse
import datetime
import json
import os
import pathlib
import re
import socket
import sqlite3
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--old-boot', required=True)
parser.add_argument('--apply', action='store_true')
options = parser.parse_args()
project = pathlib.Path(__file__).resolve().parents[1]
database = project / 'storage' / 'radio.db'
os.umask(0o077)
for service in ('radio-worker', 'radio-web'):
    if subprocess.run(['systemctl', 'is-active', '--quiet', service]).returncode == 0:
        raise RuntimeError('Stop worker and web before inspecting or repairing history')
with socket.create_connection(('127.0.0.1', 1234), timeout=5) as connection:
    connection.settimeout(5)
    connection.sendall(b'radio.current\n')
    response = b''
    while not re.search(rb'(?:^|\r?\n)END\r?\n', response):
        data = connection.recv(65536)
        if not data or len(response) > 1048576:
            raise RuntimeError('Invalid command response')
        response += data
    current = json.loads(re.split(rb'(?:^|\r?\n)END\r?\n', response)[0])
instant = datetime.datetime.fromisoformat(current['startedAt'])
assert current['startedAt'].endswith('Z')
assert 0 <= (datetime.datetime.now(datetime.timezone.utc) - instant).total_seconds() < 90
new_boot = current['eventId'].split(':')[0]
assert new_boot != options.old_boot
connection = sqlite3.connect(database)
connection.row_factory = sqlite3.Row
connection.execute('PRAGMA busy_timeout=5000')
all_rows = [dict(row) for row in connection.execute('SELECT * FROM PlayEvent ORDER BY startedAt, id')]
old = [row for row in all_rows if (row['externalId'] or '').startswith(options.old_boot + ':')]
assert old and old[0]['externalId'] == options.old_boot + ':1'
assert all(isinstance(row['startedAt'], int) for row in old)
first_offset = old[0]['startedAt'] / 1000 - float(options.old_boot)
assert 3595 < first_offset < 3605, 'First event does not prove the expected +1h offset'
boots = {(row['externalId'] or '').split(':')[0] for row in all_rows}
assert boots == {options.old_boot, new_boot}, 'Unknown playback provenance; do not repair these rows'
old_ids = {row['id'] for row in old}
track_ids = {row['assetId'] for row in old if row['type'] == 'track' and row['assetId']}
corrected = [{**row, 'startedAt': row['startedAt'] - (3600000 if row['id'] in old_ids else 0)} for row in all_rows]
corrected.sort(key=lambda row: (row['startedAt'], row['id']))
changes = []
before = {row['id']: row for row in all_rows}
for index, row in enumerate(corrected):
    following = corrected[index + 1] if index + 1 < len(corrected) else None
    row['endedAt'] = following['startedAt'] if following else None
    row['status'] = 'PLAYED' if following else 'PLAYING'
    fields = ('startedAt', 'endedAt', 'status')
    if any(row[field] != before[row['id']][field] for field in fields):
        changes.append({'id': row['id'], 'externalId': row['externalId'],
                        'before': {field: before[row['id']][field] for field in fields},
                        'after': {field: row[field] for field in fields}})
track_changes = []
for track_id in track_ids:
    previous = connection.execute('SELECT lastPlayedAt FROM Track WHERE id=?', (track_id,)).fetchone()
    if previous is None:
        continue
    latest = max(row['startedAt'] for row in corrected if row['type'] == 'track' and row['assetId'] == track_id)
    if previous['lastPlayedAt'] != latest:
        track_changes.append({'id': track_id, 'before': previous['lastPlayedAt'], 'after': latest})
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
base = project / 'storage' / 'tmp' / ('timezone-repair-' + stamp)
report = {'checkedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'oldBoot': options.old_boot, 'newUtcBoot': new_boot, 'shiftMilliseconds': -3600000,
          'firstEventMinusBootSeconds': first_offset, 'affectedOldEvents': len(old),
          'currentUtcSnapshot': current, 'eventChanges': changes, 'trackChanges': track_changes,
          'applied': options.apply}
if options.apply:
    backup_path = base.with_suffix('.db')
    with sqlite3.connect(backup_path) as backup:
        connection.backup(backup)
        assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    report['backupPath'] = str(backup_path)
    with connection:
        for change in changes:
            after = change['after']
            connection.execute('UPDATE PlayEvent SET startedAt=?,endedAt=?,status=? WHERE id=?',
                               (after['startedAt'], after['endedAt'], after['status'], change['id']))
        for change in track_changes:
            connection.execute('UPDATE Track SET lastPlayedAt=? WHERE id=?', (change['after'], change['id']))
    assert connection.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert connection.execute("SELECT COUNT(*) FROM PlayEvent WHERE status='PLAYING'").fetchone()[0] == 1
audit_path = base.with_suffix('.json')
audit_path.write_text(json.dumps(report, indent=2) + '\n')
connection.close()
print(json.dumps({'event': 'history.timezone.repaired' if options.apply else 'history.timezone.preview',
                  'oldBoot': options.old_boot, 'newUtcBoot': new_boot, 'oldEvents': len(old),
                  'changedEvents': len(changes), 'changedTracks': len(track_changes),
                  'auditPath': str(audit_path), 'backupPath': report.get('backupPath')}))
