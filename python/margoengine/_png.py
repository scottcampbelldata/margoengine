"""PNG export: draws a figure's standalone page in a headless Chrome, Edge or Chromium and captures it.

WebGPU drawing happens in a browser, so ``Figure.to_png`` starts one without a window, loads the page ``to_html``
writes, waits until the figure has drawn and asks the browser for a screenshot. It speaks the Chrome DevTools
Protocol (the browser's remote debugging protocol: JSON commands over a WebSocket) with a small WebSocket client
written from RFC 6455, so it needs no Python packages, only the browser.

References: RFC 6455 "The WebSocket Protocol" (opening handshake, base framing, client masking); the Chrome DevTools
Protocol documentation for ``Target.attachToTarget`` (flat sessions), ``Emulation.setDeviceMetricsOverride``,
``Page.navigate``, ``Runtime.evaluate`` (``awaitPromise``), ``Page.captureScreenshot`` and ``Browser.close``.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlparse

__all__ = ["find_browser", "render_png", "WebSocket"]

HELP = "https://margoengine.com/errors#python-png"

# Waits for the figure the page builds (window.margoFigure), its axes and labels, then three animation frames so the
# canvas shows the finished picture.
_DRAWN = """
(async () => {
  const figure = await window.margoFigure;
  await figure.ready();
  for (let k = 0; k < 3; k++) await new Promise((r) => requestAnimationFrame(r));
  return true;
})()
"""


def find_browser(browser: Optional[str] = None) -> str:
    """The browser executable: ``browser``, else ``$MARGO_BROWSER``, else an installed Chrome, Edge or Chromium."""
    chosen = browser or os.environ.get("MARGO_BROWSER")
    if chosen:
        # A path, a command on PATH, or the name of an installed browser ("msedge", "chrome") from the usual places.
        found = shutil.which(chosen) or (chosen if Path(chosen).is_file() else None)
        found = found or next((c for c in _installed() if _kind(c) == _kind(chosen)), None)
        if not found:
            raise FileNotFoundError(f"browser {chosen!r} not found; give the path to Chrome, Edge or Chromium ({HELP})")
        return found
    for path in _installed():
        return path
    raise FileNotFoundError(
        "to_png needs Chrome, Edge or Chromium (it draws the figure with WebGPU in a headless browser); install one or "
        f"set MARGO_BROWSER to its path ({HELP})"
    )


# The names one browser goes by: its Windows file, its Linux commands and its macOS app all name the same browser, so
# browser="msedge" finds "Microsoft Edge.app" on macOS and microsoft-edge on Linux.
_KINDS = {
    "msedge": "edge",
    "edge": "edge",
    "microsoft edge": "edge",
    "microsoft-edge": "edge",
    "microsoft-edge-stable": "edge",
    "chrome": "chrome",
    "google chrome": "chrome",
    "google-chrome": "chrome",
    "google-chrome-stable": "chrome",
    "chromium": "chromium",
    "chromium-browser": "chromium",
}


def _kind(name: str) -> str:
    # Either separator, so a Windows path reads the same on every system.
    stem = name.replace("\\", "/").rsplit("/", 1)[-1].lower()
    stem = stem[:-4] if stem.endswith(".exe") else stem
    return _KINDS.get(stem, stem)


def _installed() -> List[str]:
    # Chrome, Edge and Chromium where their installers put them, then on PATH; only files that exist.
    candidates: List[str] = []
    if sys.platform == "win32":
        for base in (os.environ.get("PROGRAMFILES"), os.environ.get("PROGRAMFILES(X86)"), os.environ.get("LOCALAPPDATA")):
            if base:
                candidates += [
                    os.path.join(base, "Google", "Chrome", "Application", "chrome.exe"),
                    os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                ]
    elif sys.platform == "darwin":
        candidates += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "chrome", "msedge"):
        path = shutil.which(name)
        if path:
            candidates.append(path)
    return [path for path in candidates if Path(path).is_file()]


class WebSocket:
    """A minimal RFC 6455 client: text messages out (masked, as clients must), text messages in."""

    def __init__(self, url: str, timeout: float):
        parts = urlparse(url)
        self._sock = socket.create_connection((parts.hostname, parts.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {parts.path or '/'} HTTP/1.1\r\nHost: {parts.hostname}:{parts.port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self._sock.sendall(request.encode("ascii"))
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("the browser closed the DevTools connection during the handshake")
            head += chunk
        head, self._pending = head.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0]
        if b" 101 " not in status + b" ":
            raise ConnectionError(f"DevTools WebSocket handshake failed: {status.decode('latin-1')}")

    @staticmethod
    def frame(payload: bytes, opcode: int = 0x1, mask: Optional[bytes] = None) -> bytes:
        """One final, masked client frame."""
        mask = mask if mask is not None else os.urandom(4)
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 1 << 16:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        return header + mask + _xor(payload, mask)

    def send(self, text: str) -> None:
        self._sock.sendall(self.frame(text.encode("utf-8")))

    def _read(self, n: int) -> bytes:
        out = bytearray(self._pending[:n])
        self._pending = self._pending[n:]
        while len(out) < n:
            chunk = self._sock.recv(max(65536, n - len(out)))
            if not chunk:
                raise ConnectionError("the browser closed the DevTools connection")
            out += chunk
        if len(out) > n:
            self._pending = bytes(out[n:]) + self._pending
            del out[n:]
        return bytes(out)

    def receive(self) -> str:
        """The next text message (fragments joined; pings answered)."""
        message = bytearray()
        while True:
            b0, b1 = self._read(2)
            opcode, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                (n,) = struct.unpack("!H", self._read(2))
            elif n == 127:
                (n,) = struct.unpack("!Q", self._read(8))
            mask = self._read(4) if b1 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = _xor(payload, mask)
            if opcode == 0x8:
                raise ConnectionError("the browser closed the DevTools connection")
            if opcode == 0x9:
                self._sock.sendall(self.frame(payload, opcode=0xA))
                continue
            if opcode == 0xA:
                continue
            message += payload
            if b0 & 0x80:
                return message.decode("utf-8")

    def close(self) -> None:
        self._sock.close()


def _xor(payload: bytes, mask: bytes) -> bytes:
    # Masking XORs the payload with the 4-byte key repeated; doing it as one big integer keeps large frames fast.
    n = len(payload)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


class _DevTools:
    """Commands to the browser (and to one page over a flat session) on one WebSocket."""

    def __init__(self, url: str, timeout: float):
        self._ws = WebSocket(url, timeout)
        self._id = 0

    def wait_for(self, event: str, session: str) -> None:
        """Reads messages until ``event`` arrives for ``session``."""
        while True:
            message = json.loads(self._ws.receive())
            if message.get("method") == event and message.get("sessionId") == session:
                return

    def call(self, method: str, params: Optional[Dict[str, Any]] = None, session: Optional[str] = None) -> Dict[str, Any]:
        self._id += 1
        message: Dict[str, Any] = {"id": self._id, "method": method, "params": params or {}}
        if session:
            message["sessionId"] = session
        self._ws.send(json.dumps(message))
        while True:
            reply = json.loads(self._ws.receive())
            if reply.get("id") == self._id:
                if "error" in reply:
                    raise RuntimeError(f"browser refused {method}: {reply['error'].get('message')} ({HELP})")
                return reply.get("result", {})

    def close(self) -> None:
        self._ws.close()


def _endpoint(profile: Path, process: subprocess.Popen, timeout: float) -> str:
    # Once its DevTools server listens, the browser writes the port and the browser target's path to
    # DevToolsActivePort in the profile folder (the process started may hand over to a relaunched browser process, so
    # the file, not that process's output, is the signal).
    marker = profile / "DevToolsActivePort"
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if marker.is_file():
            lines = marker.read_text(encoding="utf-8").split()
            if len(lines) >= 2:
                return f"ws://127.0.0.1:{lines[0]}{lines[1]}"
        if process.poll() not in (None, 0):
            raise RuntimeError(f"the browser exited with code {process.returncode} before it was ready ({HELP})")
        time.sleep(0.02)
    raise RuntimeError(f"the browser did not start its DevTools endpoint within {timeout:g} s ({HELP})")


def _alive(pid: int) -> bool:
    if sys.platform == "win32":
        import ctypes

        kernel = ctypes.windll.kernel32  # type: ignore[attr-defined]
        handle = kernel.OpenProcess(0x00100000 | 0x1000, False, pid)  # SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            return kernel.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _end(pids: List[int], process: subprocess.Popen, grace: float) -> None:
    # Waits for the browser's processes to exit after Browser.close, so its profile folder can be removed; any still
    # running after `grace` seconds (or all of them, with grace 0 on an error) are terminated.
    def alive(pid: int) -> bool:
        # Our own child is asked through its Popen (on POSIX it stays a zombie until reaped).
        return process.poll() is None if pid == process.pid else _alive(pid)

    deadline = time.monotonic() + grace
    for pid in pids:
        while alive(pid) and time.monotonic() < deadline:
            time.sleep(0.02)
        if alive(pid):
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                os.kill(pid, 9)
    if process.poll() is None:
        process.kill()
    process.wait()
    for pid in pids:
        while _alive(pid):
            time.sleep(0.02)


def render_png(page: str, *, width: int, height: int, scale: float, browser: Optional[str], timeout: float) -> bytes:
    """PNG bytes of ``page`` (a standalone figure page) drawn at ``width`` x ``height`` CSS pixels times ``scale``."""
    executable = find_browser(browser)
    with tempfile.TemporaryDirectory(prefix="margo-png-") as folder:
        html_path = Path(folder, "figure.html")
        html_path.write_text(page, encoding="utf-8")
        # A profile of its own: without one the browser hands the request to an already open window of the same
        # browser and exits.
        profile = Path(folder, "profile")
        process = subprocess.Popen(
            [
                executable,
                "--headless",
                "--remote-debugging-port=0",
                f"--user-data-dir={profile}",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--disable-component-update",
                "--disable-background-networking",
                "--enable-unsafe-webgpu",
                "--hide-scrollbars",
                "about:blank",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        tools: Optional[_DevTools] = None
        pids: List[int] = [process.pid]
        closed = False
        try:
            tools = _DevTools(_endpoint(profile, process, timeout), timeout)
            # Every process of this browser (browser, GPU, renderers, utilities), to wait for once it is closed.
            info = tools.call("SystemInfo.getProcessInfo").get("processInfo", [])
            pids = list(dict.fromkeys([process.pid] + [int(p["id"]) for p in info if p.get("id")]))
            targets = tools.call("Target.getTargets")["targetInfos"]
            target = next((t["targetId"] for t in targets if t.get("type") == "page"), None)
            if target is None:
                target = tools.call("Target.createTarget", {"url": "about:blank"})["targetId"]
            session = tools.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
            tools.call(
                "Emulation.setDeviceMetricsOverride",
                {"width": width, "height": height, "deviceScaleFactor": scale, "mobile": False},
                session,
            )
            tools.call("Page.enable", None, session)
            tools.call("Page.navigate", {"url": html_path.as_uri()}, session)
            # The page's inline scripts (the last one defines window.margoFigure) have run once it has loaded.
            tools.wait_for("Page.loadEventFired", session)
            result = tools.call(
                "Runtime.evaluate",
                {
                    "expression": _DRAWN.strip(),
                    "awaitPromise": True,
                    "timeout": int(timeout * 1000),
                },
                session,
            )
            if "exceptionDetails" in result:
                details = result["exceptionDetails"]
                text = (details.get("exception") or {}).get("description") or details.get("text", "")
                if "WebGPU unavailable" in text:
                    raise RuntimeError(f"the browser at {executable} has no WebGPU adapter, so the figure cannot draw ({HELP})")
                raise RuntimeError(f"the figure failed to draw: {text} ({HELP})")
            shot = tools.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False}, session)
            png = base64.b64decode(shot["data"])
            tools.call("Browser.close")
            closed = True
        finally:
            if tools is not None:
                tools.close()
            # After Browser.close the processes exit by themselves; after an error they are ended at once.
            _end(pids, process, grace=timeout if closed else 0)
    return png


def png_size(png: bytes) -> Tuple[int, int]:
    """Width and height from a PNG's IHDR chunk."""
    if png[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack("!II", png[16:24])
