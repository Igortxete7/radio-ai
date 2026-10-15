#!/usr/bin/env python3
"""Prove the soak runner rejects early EOF and stalled audio using local fixtures."""
import http.server
import json
import os
import pathlib
import subprocess
import threading
import time

project = pathlib.Path(__file__).resolve().parents[2]
storage = project / 'storage'
audio = (storage / 'jingles' / 'demo-ident.mp3').read_bytes()


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        if self.path == '/finite':
            self.send_header('Content-Length', str(len(audio)))
        self.end_headers()
        self.wfile.write(audio if self.path == '/finite' else audio[:8192])
        self.wfile.flush()
        if self.path == '/stall':
            time.sleep(30)


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
results = []
try:
    for fixture in ('finite', 'stall'):
        environment = {
            **os.environ,
            'RADIO_ENV_FILE': '/dev/null',
            'STORAGE_ROOT': str(storage),
            'ICECAST_HOST': '127.0.0.1',
            'ICECAST_PORT': str(server.server_port),
            'ICECAST_MOUNT': '/' + fixture,
        }
        process = subprocess.run(['bash', 'scripts/soak-stream.sh', '10'], cwd=project,
                                 env=environment, capture_output=True, text=True, timeout=80)
        assert process.returncode != 0, fixture + ' must not pass as ten decoded seconds'
        latest = json.loads((storage / 'tmp' / 'soak-latest.json').read_text())
        result = json.loads((pathlib.Path(latest['directory']) / 'finish.json').read_text())
        assert result['status'] == 'FAILED' and result['decodedSeconds'] < 9.75
        if fixture == 'finite':
            assert result['reason'] == 'EARLY_EOF'
        else:
            assert result['decoderExitCode'] != 0
        results.append({'fixture': fixture, 'reason': result['reason'], 'decodedSeconds': result['decodedSeconds']})
finally:
    server.shutdown()
    server.server_close()
print(json.dumps({'event': 'stream.soak.runner.verified', 'checks': results}))
