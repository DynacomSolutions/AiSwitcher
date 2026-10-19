#!/usr/bin/env python3
"""Negotiate QMP before guest execution and persist shutdown evidence."""
import json
import os
import socket
import sys
import time

pending_events = []


def fail(message):
    print(f"qemu-test: QMP {message}", file=sys.stderr, flush=True)
    raise SystemExit(1)


def receive(stream):
    line = stream.readline()
    if not line:
        fail("connection closed without shutdown evidence")
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        fail("sent malformed JSON")


def command(stream, name, identifier):
    stream.write(json.dumps({"execute": name, "id": identifier}).encode() + b"\r\n")
    stream.flush()
    while True:
        message = receive(stream)
        if "event" in message:
            pending_events.append(message)
            continue
        if message.get("id") == identifier:
            if "error" in message:
                fail(f"command {name} failed")
            return


def main():
    if len(sys.argv) != 3:
        fail("watcher usage error")
    socket_path, evidence_path = sys.argv[1:]
    deadline = time.monotonic() + 30
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    while True:
        try:
            client.connect(socket_path)
            break
        except (FileNotFoundError, ConnectionRefusedError):
            if time.monotonic() >= deadline:
                fail("socket did not become ready")
            time.sleep(0.05)

    client.settimeout(900)
    stream = client.makefile("rwb", buffering=0)
    greeting = receive(stream)
    if "QMP" not in greeting:
        fail("greeting missing")
    command(stream, "qmp_capabilities", "ais-capabilities")
    # Firmware startup can emit RESET while capabilities are being negotiated.
    # Clear those before cont, then retain every event emitted during cont.
    pending_events[:] = [event for event in pending_events if event.get("event") != "RESET"]
    command(stream, "cont", "ais-continue")
    while True:
        message = pending_events.pop(0) if pending_events else receive(stream)
        if message.get("event") in ("RESET", "GUEST_PANICKED"):
            fail("reported " + message["event"])
        if message.get("event") != "SHUTDOWN":
            continue
        data = message.get("data")
        if not isinstance(data, dict):
            fail("SHUTDOWN event omitted data")
        evidence = {"event": "SHUTDOWN", "data": data}
        with open(evidence_path + ".new", "w", encoding="utf-8") as output:
            json.dump(evidence, output, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(evidence_path + ".new", evidence_path)
        if data.get("guest") is True and data.get("reason") == "guest-shutdown":
            print("qemu-test: QMP confirmed guest-shutdown", flush=True)
            return 0
        fail("reported non-clean shutdown: " + json.dumps(data, sort_keys=True))


if __name__ == "__main__":
    raise SystemExit(main())
