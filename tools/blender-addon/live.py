"""Live link: an open Blender session serves its scene to running pages as it changes. A local HTTP server (loopback
only) holds the newest export at /scene.margo and announces each new version on /events as Server-Sent Events;
@margoengine/blender/live on the page fetches each announced version and swaps the model. The server is plain
Python (no bpy), so it is tested without Blender; LiveLink below ties it to Blender's depsgraph updates."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
import threading

KEEP_ALIVE = 15  # seconds between SSE comments, so proxies and browsers keep an idle stream open
LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def page_allowed(origin):
    """True for a page served from this machine (http(s)://localhost, 127.0.0.1 or [::1], any port, or a *.localhost
    name): only those may read the scene, so a web site open in another tab cannot download the artist's work."""
    try:
        parts = urlsplit(origin or "")
        host = parts.hostname or ""
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and (host in LOOPBACK or host.endswith(".localhost"))


class LiveServer:
    """Serves the newest published .margo bytes. `publish(data)` makes them the next version and wakes every
    /events stream. Binds 127.0.0.1 only, and answers cross-origin reads only for pages served from this machine
    (page_allowed), so the scene never leaves it. Use as a context manager or call close()."""

    def __init__(self, port=0):
        self.version, self.data, self.closed = 0, b"", False
        self.served = 0  # the newest version a page has downloaded
        self.changed = threading.Condition()
        live = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def headers_for(self, kind, length=None):
                self.send_header("Content-Type", kind)
                self.send_header("Cache-Control", "no-store")
                origin = self.headers.get("Origin")
                if page_allowed(origin):
                    self.send_header("Access-Control-Allow-Origin", origin)
                    self.send_header("Access-Control-Expose-Headers", "X-Margo-Version")
                    self.send_header("Vary", "Origin")
                if length is not None:
                    self.send_header("Content-Length", str(length))

            def do_GET(self):
                path = self.path.split("?", 1)[0]
                if path == "/scene.margo":
                    with live.changed:
                        version, data = live.version, live.data
                    if not version:
                        self.send_response(503)
                        self.headers_for("text/plain", 0)
                        self.end_headers()
                        return
                    self.send_response(200)
                    self.headers_for("application/octet-stream", len(data))
                    self.send_header("X-Margo-Version", str(version))
                    self.end_headers()
                    self.wfile.write(data)
                    with live.changed:
                        live.served = max(live.served, version)
                        live.changed.notify_all()
                elif path == "/events":
                    self.send_response(200)
                    self.headers_for("text/event-stream")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    self.close_connection = True
                    sent = 0
                    try:
                        while True:
                            with live.changed:
                                live.changed.wait_for(lambda: live.closed or live.version != sent, timeout=KEEP_ALIVE)
                                closed, version = live.closed, live.version
                            if closed:
                                return
                            if version != sent:
                                self.wfile.write(f"id: {version}\nevent: scene\ndata: {version}\n\n".encode())
                                sent = version
                            else:
                                self.wfile.write(b": keep-alive\n\n")
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        return
                else:
                    self.send_response(404)
                    self.headers_for("text/plain", 0)
                    self.end_headers()

        self.server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.url = f"http://127.0.0.1:{self.port}/"
        self.thread = threading.Thread(target=self.server.serve_forever, name="margo-live", daemon=True)
        self.thread.start()

    def publish(self, data):
        """Makes `data` (the bytes of a .margo file) the newest version and returns its number."""
        with self.changed:
            self.version += 1
            self.data = bytes(data)
            self.changed.notify_all()
            return self.version

    def wait_served(self, version, timeout):
        """Waits until a page has downloaded `version` (for tests and tools); returns whether it did in time."""
        with self.changed:
            return self.changed.wait_for(lambda: self.served >= version, timeout=timeout)

    def close(self):
        with self.changed:
            self.closed = True
            self.changed.notify_all()
        self.server.shutdown()
        self.server.server_close()

    def __enter__(self):
        return self

    def __exit__(self, *error):
        self.close()


class LiveLink:
    """Re-exports the scene after Blender's depsgraph changes, at most every `interval` seconds, and publishes it on a
    LiveServer. `export(context) -> bytes` does the export (the add-on passes export_scene with a temporary file).
    start() registers the handler and timer; stop() removes them and closes the server."""

    def __init__(self, export, port=0, interval=0.25):
        self.export, self.port, self.interval = export, port, interval
        self.server, self.dirty, self.error = None, True, None

    def changed(self, scene, depsgraph):
        # A change the export reads: geometry, transforms, materials or properties.
        if any(update.is_updated_geometry or update.is_updated_transform or update.is_updated_shading for update in depsgraph.updates):
            self.dirty = True

    def tick(self):
        import bpy

        if self.server is None:
            return None
        if self.dirty:
            self.dirty = False
            try:
                self.server.publish(self.export(bpy.context))
                self.error = None
            except (ValueError, OSError, OverflowError, RuntimeError) as error:
                # The page keeps the last good version; the panel shows why this one did not export.
                self.error = str(error)
        return self.interval

    def start(self):
        import bpy

        self.server = LiveServer(self.port)
        bpy.app.handlers.depsgraph_update_post.append(self.changed)
        bpy.app.timers.register(self.tick, first_interval=0)
        return self.server.url

    def stop(self):
        import bpy

        if self.changed in bpy.app.handlers.depsgraph_update_post:
            bpy.app.handlers.depsgraph_update_post.remove(self.changed)
        if bpy.app.timers.is_registered(self.tick):
            bpy.app.timers.unregister(self.tick)
        if self.server:
            self.server.close()
            self.server = None
