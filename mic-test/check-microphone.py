"""Probe UI feature discovery and the real microphone WebSocket upgrade."""
import base64
import hashlib
import json
import os
import socket
import sys
import time
import urllib.request

port, audio = map(int, sys.argv[1:])
http = urllib.request.build_opener(urllib.request.ProxyHandler({}))
base = f"http://127.0.0.1:{port}"
for attempt in range(30):
    try:
        with http.open(base + "/webdata.json", timeout=2) as response:
            data = json.load(response)
        break
    except OSError:
        if attempt == 29:
            raise
        time.sleep(1)
assert data["microphoneSupport"] is True, data
assert data["audioSupport"] is bool(audio), data
with http.open(base + "/app/microphone.js", timeout=5) as response:
    assert b"new MediaRecorder(" in response.read()

with socket.create_connection(("127.0.0.1", port), timeout=5) as stream:
    key = base64.b64encode(os.urandom(16)).decode()
    stream.sendall((
        "GET /websockify-microphone HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n"
        "Sec-WebSocket-Protocol: binary\r\n\r\n"
    ).encode())
    headers = b""
    while b"\r\n\r\n" not in headers:
        chunk = stream.recv(4096)
        assert chunk, "Connection closed before WebSocket upgrade"
        headers += chunk
        assert len(headers) < 65536, "Oversized WebSocket response"
    assert headers.split(b"\r\n", 1)[0].split()[1] == b"101", headers
    fields = {}
    for line in headers.split(b"\r\n\r\n", 1)[0].split(b"\r\n")[1:]:
        name, value = line.split(b":", 1)
        fields[name.lower()] = value.strip()
    accept = base64.b64encode(hashlib.sha1(
        (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()
    ).digest())
    assert fields[b"sec-websocket-accept"] == accept, headers
    assert fields[b"sec-websocket-protocol"] == b"binary", headers
    # No obsolete raw PCM payload: the bridge now expects WebM/Ogg Opus.
print(f"Microphone route and Firefox startup passed (WEB_AUDIO={audio}).")
