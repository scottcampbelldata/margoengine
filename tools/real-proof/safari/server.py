# Serves the page and takes its reports. Python only: there is no node on the Mac.
import http.server, sys, json, os
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); b = self.rfile.read(n)
        open(sys.argv[3], 'wb').write(b)
        self.send_response(204); self.end_headers()
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
H.extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.wasm': 'application/wasm', '.mjs': 'text/javascript'}
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
