#!/usr/bin/env python3
"""Send a deliberately small set of keyboard events through QMP to tty1."""

import argparse
import json
import os
import stat
import socket
import sys


KEYS = {
    "/": ["slash"],
    ".": ["dot"],
    "_": ["shift", "minus"],
    "-": ["minus"],
    " ": ["spc"],
}


def key_events(text):
    if not isinstance(text, str) or not text or len(text) > 160:
        raise ValueError("text must contain 1 to 160 characters")
    events = []
    for char in text:
        if char == "\n":
            events.append(["ret"])
        elif char.isascii() and char.isalpha():
            if char.isupper():
                events.append(["shift", char.lower()])
            else:
                events.append([char.lower()])
        elif char.isascii() and char.isdigit():
            events.append(["0" if char == "0" else char])
        elif char in KEYS:
            events.append(KEYS[char])
        else:
            raise ValueError("unsupported key character")
    return events


def exchange(sock, message, buffer):
    sock.sendall((json.dumps(message, separators=(",", ":")) + "\r\n").encode())
    while True:
        if b"\n" in buffer[0]:
            line, buffer[0] = buffer[0].split(b"\n", 1)
            response = json.loads(line)
            if "error" in response:
                raise OSError(f"QMP error: {response['error'].get('desc', 'request failed')}")
            if "return" in response:
                return response
            continue
        chunk = sock.recv(4096)
        if not chunk:
            raise OSError("QMP closed the connection")
        buffer[0] += chunk
        if len(buffer[0]) > 65536:
            raise OSError("QMP response too large")


def send(socket_path, text):
    events = key_events(text)
    if not os.path.exists(socket_path) or not stat.S_ISSOCK(os.stat(socket_path).st_mode):
        raise OSError("QMP socket is missing")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(3)
        sock.connect(socket_path)
        buffer = [b""]
        while b"\n" not in buffer[0]:
            chunk = sock.recv(4096)
            if not chunk:
                raise OSError("QMP closed before greeting")
            buffer[0] += chunk
            if len(buffer[0]) > 65536:
                raise OSError("QMP greeting too large")
        line, buffer[0] = buffer[0].split(b"\n", 1)
        greeting = json.loads(line)
        if "QMP" not in greeting:
            raise OSError("invalid QMP greeting")
        exchange(sock, {"execute": "qmp_capabilities"}, buffer)
        for chord in events:
            exchange(sock, {"execute": "send-key", "arguments": {"keys": [{"type": "qcode", "data": key} for key in chord], "hold-time": 40}}, buffer)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--map-text")
    parser.add_argument("--socket")
    parser.add_argument("--text")
    args = parser.parse_args()
    try:
        if args.map_text is not None and args.socket is None and args.text is None:
            print(json.dumps(key_events(args.map_text)))
            return 0
        if args.socket and args.text is not None and args.map_text is None:
            send(args.socket, args.text)
            return 0
        parser.error("choose --map-text or both --socket and --text")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"guard-qmp: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
