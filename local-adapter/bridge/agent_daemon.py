"""Standalone companion for visitors who only need local Claude/Codex."""
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
from urllib.parse import urlsplit
from pathlib import Path
import agent_bridge

class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(Path(__file__).resolve().parent/'web'),**kwargs)
    def log_message(self,*args):pass
    def do_OPTIONS(self):agent_bridge.options(self)
    def do_POST(self):agent_bridge.post(self)
    def do_GET(self):
        if urlsplit(self.path).path.startswith(('/__agents/','/__connect/')):return agent_bridge.get(self)
        if self.headers.get('Host') not in {'127.0.0.1:4318','localhost:4318'}:return self.send_error(403)
        if urlsplit(self.path).path=='/':self.send_response(302);self.send_header('Location','/gadgets/');self.end_headers();return
        super().do_GET()

if __name__=='__main__':
    print('sp1e local agents: http://127.0.0.1:4318 — Ctrl+C stops the companion.')
    try:ThreadingHTTPServer(('127.0.0.1',4318),Handler).serve_forever()
    except OSError:print('Port 4318 is already in use. If the design workspace is running, use its companion.');raise SystemExit(1)
