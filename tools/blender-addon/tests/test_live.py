"""The live link's server without Blender: versions, the scene bytes, the event stream and shutdown."""
import http.client
import importlib.util
from pathlib import Path
import threading
import unittest

root = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("live", root / "live.py")
live = importlib.util.module_from_spec(spec)
spec.loader.exec_module(live)


def get(server, path, origin="http://localhost:5173"):
    connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
    connection.request("GET", path, headers={"Origin": origin} if origin else {})
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response, body


class LiveServerTests(unittest.TestCase):
    def test_scene_is_unavailable_until_published_then_newest_wins(self):
        with live.LiveServer() as server:
            self.assertTrue(server.url.startswith("http://127.0.0.1:"))
            response, _ = get(server, "/scene.margo")
            self.assertEqual(response.status, 503)
            self.assertEqual(server.publish(b"one"), 1)
            self.assertEqual(server.publish(b"two"), 2)
            self.assertFalse(server.wait_served(2, 0.01))
            response, body = get(server, "/scene.margo?v=2")
            self.assertTrue(server.wait_served(2, 0))
            self.assertEqual((response.status, body), (200, b"two"))
            self.assertEqual(response.getheader("X-Margo-Version"), "2")
            self.assertEqual(response.getheader("Cache-Control"), "no-store")
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"), "http://localhost:5173")
            self.assertEqual(get(server, "/other")[0].status, 404)

    def test_only_pages_on_this_machine_may_read_the_scene(self):
        allowed = ["http://localhost:5173", "http://127.0.0.1:8080", "https://[::1]:3000", "http://app.localhost"]
        refused = ["https://example.com", "http://localhost.example.com", "null", "file://", "", None, "http://[bad"]
        self.assertEqual([live.page_allowed(o) for o in allowed], [True] * len(allowed))
        self.assertEqual([live.page_allowed(o) for o in refused], [False] * len(refused))
        with live.LiveServer() as server:
            server.publish(b"scene")
            response, _ = get(server, "/scene.margo", "https://example.com")
            self.assertIsNone(response.getheader("Access-Control-Allow-Origin"))

    def test_events_announce_each_version_and_end_on_close(self):
        server = live.LiveServer()
        server.publish(b"first")
        connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=10)
        connection.request("GET", "/events")
        response = connection.getresponse()
        self.assertEqual(response.getheader("Content-Type"), "text/event-stream")

        def event():
            lines = []
            while True:
                line = response.fp.readline().decode().rstrip("\n")
                if not line:
                    return lines
                lines.append(line)

        # A stream opened after a publish hears the current version at once, so a page never waits for an edit.
        self.assertEqual(event(), ["id: 1", "event: scene", "data: 1"])
        threading.Timer(0.05, server.publish, [b"second"]).start()
        self.assertEqual(event(), ["id: 2", "event: scene", "data: 2"])
        server.close()
        self.assertEqual(response.fp.read(), b"", "the stream must end when Blender stops the link")
        connection.close()
        # The port is free again: closing released the socket.
        with live.LiveServer(server.port) as again:
            self.assertEqual(again.port, server.port)


if __name__ == "__main__":
    unittest.main()
