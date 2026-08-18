"""A deliberately slow stub bank for UI async-loading tests.

Every response is delayed 5s and carries permissive CORS, so the web app can
pin it as a peer bank. It answers any path with a minimal discovery-shaped
JSON — enough for pinning (barter-bank.json) and harmless junk for RPC calls.
"""
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PUB = "EWp6umhXgrkk4Jmmdo3x3muHTRQmTJJc7wsmNMskB82P"  # throwaway test key (not any real bank's)
DELAY = 5


class Handler(BaseHTTPRequestHandler):
    def _go(self):
        time.sleep(DELAY)
        if self.path.startswith("/rpc"):
            # RPC-shaped error: slow AND failing, so the client counts the
            # bank unreachable (a junk 200 would read as "reachable, empty").
            body = json.dumps({"jsonrpc": "2.0", "id": None,
                               "error": {"code": -32603, "message": "slow bank"}}).encode()
        else:
            body = json.dumps({
                "name": "slowbank",
                "pubkey": PUB,
                "url": "http://localhost:8201",
                "protocol_version": "barter.game/v1",
            }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _go
    do_POST = _go

    def do_OPTIONS(self):
        # CORS preflight must succeed or the browser never sends the real
        # request — and a fast preflight failure would defeat the slowness.
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type, x-barter-auth")
        self.end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", 8201), Handler).serve_forever()
