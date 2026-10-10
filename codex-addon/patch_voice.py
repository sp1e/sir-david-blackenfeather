"""Sir David Blackenfeather's local ElevenLabs voice bridge. Python standard library; Windows only."""
from __future__ import annotations
import argparse, base64, ctypes, hashlib, hmac, html, json, os, queue, re
import secrets, socket, subprocess, sys, threading, time, urllib.error, urllib.request, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "private"
CONFIG = DATA / "profile.json"
RUNTIME = DATA / "runtime.json"
KEYFILE = DATA / "elevenlabs-key.dpapi"
PET_ID = "pet_6ac28512fc448191bcf37d57ad28298c"
CURRENT_CHAT = "example-chat-id"
DESCRIPTION = ("Native British English, traditional upper-class Received Pronunciation. Male, 70 years old. "
    "An elderly distinguished gentleman and observant natural-history narrator. Very low, dark baritone, "
    "warm chest resonance, audible age, gentle lived-in rasp and slight breathiness at phrase endings. "
    "Measured conversational pace, clear articulation, restrained intonation. Calm and quietly amused. "
    "Dry humour with small pauses and understatement. Original character voice, natural clear recording.")
PREVIEW = ("Ah, there you are. I have been keeping an eye on things. A demanding occupation, naturally, "
    "though someone must maintain standards. Shall we begin? I should hate to interrupt a perfectly good spell of procrastination.")
DEFAULTS = dict(pet_id=PET_ID, voice_id="", voice_name="Sir David Blackenfeather — British Gentleman, 70", enabled=False,
    muted=False, scope="listed", chats=[], max_chars=1200, speed=0.90, stability=0.65,
    similarity_boost=0.80, model_id="eleven_multilingual_v2", description=DESCRIPTION)
LOCK = threading.RLock()

def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + secrets.token_hex(4) + ".tmp")
    temp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(temp, path)

def profile():
    with LOCK:
        return {**DEFAULTS, **(json.loads(CONFIG.read_text(encoding="utf-8")) if CONFIG.exists() else {})}

def save_profile(value):
    with LOCK:
        atomic_json(CONFIG, value)

class Blob(ctypes.Structure):
    _fields_ = [("size", ctypes.c_ulong), ("data", ctypes.POINTER(ctypes.c_ubyte))]

def protect(value: bytes, decrypt=False):
    if os.name != "nt":
        raise RuntimeError("Windows is required to protect this credential.")
    buffer = ctypes.create_string_buffer(value)
    incoming = Blob(len(value), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    api = ctypes.windll.crypt32.CryptUnprotectData if decrypt else ctypes.windll.crypt32.CryptProtectData
    api.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                   ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(Blob)]
    api.restype = ctypes.c_int
    if not api(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
        raise RuntimeError("Windows could not unlock the local credential.")
    try:
        return ctypes.string_at(outgoing.data, outgoing.size)
    finally:
        ctypes.windll.kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        ctypes.windll.kernel32.LocalFree(ctypes.cast(outgoing.data, ctypes.c_void_p))

def key():
    if KEYFILE.exists():
        return protect(KEYFILE.read_bytes(), True).decode()
    value = os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVEN_API_KEY")
    if not value:
        raise ValueError("Connect your ElevenLabs API key in the setup panel first.")
    return value

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def eleven(path, body=None, audio=False, supplied_key=None):
    if not path.startswith("/v1/") or ".." in path:
        raise ValueError("Invalid service operation.")
    request = urllib.request.Request("https://api.elevenlabs.io" + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"xi-api-key": supplied_key or key(), "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=90) as response:
            result = response.read(20_000_001)
            if len(result) > 20_000_000:
                raise ValueError("The audio response was too large.")
            return result if audio else json.loads(result)
    except urllib.error.HTTPError as error:
        messages = {401:"The API key was not accepted.", 403:"This API key lacks the required permission.",
            402:"Your account requires credits or a different plan.", 429:"ElevenLabs is busy or your credit limit has been reached."}
        raise ValueError(messages.get(error.code, f"ElevenLabs returned error {error.code}. Check your account and voice settings.")) from None
    except urllib.error.URLError:
        raise ValueError("Could not reach ElevenLabs. Check your connection.") from None

def patch_active(state_path=None):
    try:
        state = json.loads((state_path or Path.home()/".codex/.codex-global-state.json").read_text(encoding="utf-8"))
        selection = state["electron-persisted-atom-state"]["last-observed-cloud-pet-selection-v1"]
        return isinstance(selection, dict) and len(selection) == 1 and next(iter(selection.values())) == PET_ID
    except (OSError, ValueError, KeyError, TypeError):
        return False

def spoken_text(value, limit=1200):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"<oai-mem-citation>[\s\S]*?</oai-mem-citation>", "", value)
    value = re.sub(r"```[\s\S]*?```", "", value)
    value = re.sub(r"::[\w-]+\{[^\n]*\}", "", value)
    value = re.sub(r"!\[[^\]]*\]\([^\n]*?\)", "", value)
    value = re.sub(r"\[([^\]]+)\]\([^\n]*?\)", r"\1", value)
    value = re.sub(r"https?://\S+|[A-Za-z]:[\\/]\S+", "", value)
    # Fail closed on recognisable credentials and operational output.
    if re.search(r"\b(?:sk-|sk_[A-Za-z0-9]|sk-proj-|xi-api-key|api[_ -]?key\s*[:=]|password\s*[:=])", value, re.I):
        return ""
    lines = [line.strip(" #>*_`-") for line in value.splitlines()
             if line.strip() and not line.startswith("|") and "graft saved" not in line]
    value = re.sub(r"\s+", " ", " ".join(lines)).strip()
    if len(value) > limit:
        prefix = value[:limit]
        match = list(re.finditer(r"[.!?](?:\s|$)", prefix))
        value = prefix[:match[-1].start()+1] if match else prefix.rsplit(" ", 1)[0]
    return value

def chat_allowed(event, cfg):
    session_id = event.get("session_id")
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", session_id):
        return False
    return cfg.get("scope", "listed") == "patch" or session_id in cfg["chats"]

def eligible(event, cfg, active=None):
    return (event.get("hook_event_name") == "Stop" and cfg["enabled"] and not cfg["muted"]
        and bool(cfg["voice_id"]) and chat_allowed(event, cfg)
        and not event.get("stop_hook_active", False) and (patch_active() if active is None else active))

class Playback:
    def __init__(self):
        self.lock = threading.Lock()
        self.commands = queue.Queue()
        threading.Thread(target=self._run_commands, daemon=True).start()
    def _run_commands(self):
        # MCI aliases belong to the calling thread. Keep play, status and stop on one owner.
        while True:
            command, result, ready = self.commands.get()
            try:
                output = ctypes.create_unicode_buffer(128)
                code = ctypes.windll.winmm.mciSendStringW(command, output, len(output), None)
                result.append((code, output.value))
            except Exception:
                result.append((-1, ""))
            finally:
                ready.set()
                self.commands.task_done()
    def _send(self, command):
        if os.name != "nt":
            return 0, ""
        ready = threading.Event()
        result = []
        self.commands.put((command, result, ready))
        if not ready.wait(5):
            raise ValueError("Windows playback did not respond. Restart the Sir David add-on.")
        return result[0]
    def command(self, command):
        return self._send(command)[0]
    def stop(self):
        with self.lock:
            self.command("stop patchvoice")
            self.command("close patchvoice")
    def is_playing(self):
        with self.lock:
            error, result = self._send("status patchvoice mode")
            return not error and result == "playing"
    def play(self, path):
        with self.lock:
            self.command("close patchvoice")
            if self.command(f'open "{path}" type mpegvideo alias patchvoice'):
                raise ValueError("Windows could not play the audio. Use the preview player instead.")
            if self.command("play patchvoice"):
                raise ValueError("Windows could not start audio playback.")

class Engine:
    def __init__(self):
        self.player = Playback()
        self.jobs = queue.Queue(maxsize=4)
        self.generation = 0
        self.status = "Ready for setup"
        self.last_error = ""
        self.seen = set()
        self.preview_ids = {}
        threading.Thread(target=self.worker, daemon=True).start()
    def stop(self):
        with LOCK:
            self.generation += 1
            self.player.stop()
            self.status = "Stopped"
    def enqueue(self, text, event=None):
        cfg = profile()
        if event is not None:
            if not eligible(event, cfg):
                return False
            identity = event.get("turn_id") or hashlib.sha256((event["session_id"]+text).encode()).hexdigest()
            if identity in self.seen:
                return False
        else:
            identity = None
        clean = spoken_text(text, cfg["max_chars"])
        if not clean or not cfg["voice_id"]:
            return False
        with LOCK:
            if self.jobs.full():
                return False
            self.jobs.put_nowait((clean, self.generation, event, cfg["voice_id"]))
            if identity:
                self.seen.add(identity)
                if len(self.seen) > 1000:
                    self.seen = {identity}
        return True
    def worker(self):
        while True:
            text, generation, event, voice_id = self.jobs.get()
            try:
                cfg = profile()
                if generation != self.generation or cfg["muted"] or cfg["voice_id"] != voice_id:
                    continue
                if event and not eligible(event, cfg):
                    continue
                self.status = "Preparing Sir David's reply"
                audio = eleven(f"/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128",
                    dict(text=text, model_id=cfg["model_id"], voice_settings=dict(
                        stability=cfg["stability"], similarity_boost=cfg["similarity_boost"],
                        style=0.10, use_speaker_boost=True, speed=cfg["speed"])), audio=True)
                with LOCK:
                    cfg = profile()
                    if generation != self.generation or cfg["muted"] or cfg["voice_id"] != voice_id:
                        continue
                    if event and not eligible(event, cfg):
                        continue
                    target = DATA / "last-reply.mp3"
                    self.player.stop()
                    target.write_bytes(audio)
                    self.player.play(target)
                    self.status = "Sir David is speaking"
                    self.last_error = ""
            except Exception as error:
                self.last_error = str(error) if isinstance(error, ValueError) else "Sir David could not speak this reply. Try again from the panel."
                self.status = "Needs attention"
            finally:
                self.jobs.task_done()

class Handler(BaseHTTPRequestHandler):
    engine: Engine
    token: str
    def log_message(self, *args):
        pass
    def allowed(self, authenticated=False):
        expected = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") != expected or self.headers.get("Sec-Fetch-Site") == "cross-site":
            return False
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + expected:
            return False
        return not authenticated or hmac.compare_digest(self.headers.get("X-Patch-Token", ""), self.token)
    def reply(self, data, status=200, mime="application/json"):
        content = json.dumps(data).encode() if mime == "application/json" else data
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; media-src 'self' data:; frame-ancestors 'none'; form-action 'self'")
        self.end_headers()
        self.wfile.write(content)
    def do_GET(self):
        if not self.allowed():
            return self.reply({"error":"Local access only"}, 403)
        if self.path == "/":
            page = (ROOT/"panel.html").read_text(encoding="utf-8").replace("__CSRF__", self.token)
            return self.reply(page.encode(), mime="text/html; charset=utf-8")
        if not self.allowed(True):
            return self.reply({"error":"Open the Sir David panel first"}, 403)
        if self.path == "/api/state":
            cfg = profile()
            if self.engine.status == "Sir David is speaking" and not self.engine.player.is_playing():
                self.engine.status = "Ready"
            return self.reply({**cfg, "key_connected": KEYFILE.exists() or bool(os.environ.get("ELEVENLABS_API_KEY") or os.environ.get("ELEVEN_API_KEY")),
                "patch_active": patch_active(), "status":self.engine.status, "error":self.engine.last_error,
                "preview_text":PREVIEW, "hook_registered":hook_registered()})
        return self.reply({"error":"Not found"}, 404)
    def do_POST(self):
        if not self.allowed(True):
            return self.reply({"error":"Local authorization required"}, 403)
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 64000:
                return self.reply({"error":"Invalid request size"}, 413)
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("Invalid request.")
            cfg = profile()
            if self.path == "/api/connect":
                credential = str(body.get("key", "")).strip()
                if not 10 <= len(credential) <= 500:
                    raise ValueError("Enter your ElevenLabs API key in this local form.")
                eleven("/v1/voices", supplied_key=credential)
                DATA.mkdir(parents=True, exist_ok=True)
                KEYFILE.write_bytes(protect(credential.encode()))
                return self.reply({"ok":True})
            if self.path == "/api/voices":
                voices = eleven("/v1/voices").get("voices", [])
                return self.reply({"voices":[{"voice_id":v["voice_id"], "name":v.get("name", "Voice")} for v in voices]})
            if self.path == "/api/design":
                description = str(body.get("description", DESCRIPTION)).strip()
                if not 20 <= len(description) <= 1000:
                    raise ValueError("The voice description must contain 20–1000 characters.")
                result = eleven("/v1/text-to-voice/design", dict(voice_description=description, text=PREVIEW,
                    model_id="eleven_multilingual_ttv_v2", guidance_scale=5, loudness=0.5))
                previews = []
                for item in result.get("previews", [])[:3]:
                    identifier = str(item["generated_voice_id"])
                    self.engine.preview_ids[identifier] = description
                    previews.append(dict(generated_voice_id=identifier, audio_base_64=item["audio_base_64"],
                        media_type=item.get("media_type", "audio/mpeg")))
                return self.reply({"previews":previews})
            if self.path == "/api/save-preview":
                identifier = str(body.get("generated_voice_id", ""))
                if identifier not in self.engine.preview_ids:
                    raise ValueError("Generate and choose a preview in this panel first.")
                description = self.engine.preview_ids[identifier]
                result = eleven("/v1/text-to-voice", dict(voice_name=DEFAULTS["voice_name"],
                    voice_description=description, generated_voice_id=identifier))
                cfg.update(voice_id=result["voice_id"], voice_name=result.get("name", DEFAULTS["voice_name"]), description=description)
                save_profile(cfg)
                self.engine.preview_ids = {}
                return self.reply({"ok":True, "voice_id":cfg["voice_id"]})
            if self.path == "/api/settings":
                if "voice_id" in body:
                    identifier = str(body["voice_id"])
                    if not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", identifier):
                        raise ValueError("Select a saved voice first.")
                    voices = eleven("/v1/voices").get("voices", [])
                    selected = next((v for v in voices if v["voice_id"] == identifier), None)
                    if not selected:
                        raise ValueError("That voice is not available to your account.")
                    cfg.update(voice_id=identifier, voice_name=selected.get("name", "Patch"))
                for name in ("enabled", "muted"):
                    if name in body:
                        if not isinstance(body[name], bool):
                            raise ValueError("Invalid switch setting.")
                        cfg[name] = body[name]
                if "scope" in body:
                    if body["scope"] not in ("listed", "patch"):
                        raise ValueError("Choose where Sir David speaks.")
                    cfg["scope"] = body["scope"]
                if "chats" in body:
                    chats = body["chats"]
                    if not isinstance(chats, list) or len(chats) > 50 or any(not isinstance(v,str) or not re.fullmatch(r"[A-Za-z0-9_-]{8,100}",v) for v in chats):
                        raise ValueError("Enter valid chat IDs, one per line.")
                    cfg["chats"] = list(dict.fromkeys(chats))
                if "speed" in body:
                    cfg["speed"] = max(0.7,min(1.2,float(body["speed"])))
                if "max_chars" in body:
                    cfg["max_chars"] = max(100,min(3000,int(body["max_chars"])))
                if cfg["enabled"] and (not cfg["voice_id"] or cfg["scope"] == "listed" and not cfg["chats"]):
                    raise ValueError("Choose a voice and at least one Patch chat before enabling speech.")
                save_profile(cfg)
                self.engine.stop()
                return self.reply({"ok":True})
            if self.path == "/api/test":
                if cfg["muted"]:
                    raise ValueError("Unmute Sir David first.")
                if not self.engine.enqueue(PREVIEW):
                    raise ValueError("Choose a saved voice first, or wait for the current request.")
                return self.reply({"ok":True})
            if self.path == "/api/stop":
                self.engine.stop()
                return self.reply({"ok":True})
            if self.path == "/api/hook":
                return self.reply({"queued":self.engine.enqueue(body.get("last_assistant_message", ""), body)})
            if self.path == "/api/interrupt":
                if chat_allowed(body, cfg):
                    self.engine.stop()
                return self.reply({"ok":True})
            return self.reply({"error":"Not found"}, 404)
        except (ValueError, KeyError, TypeError) as error:
            message = str(error) if isinstance(error, ValueError) else "Invalid response or setting."
            return self.reply({"error":message}, 400)
        except Exception:
            return self.reply({"error":"Could not complete this operation. Check the account connection."}, 500)

def runtime_request(path, body=None):
    data = json.loads(RUNTIME.read_text(encoding="utf-8"))
    token = protect(base64.b64decode(data["token_dpapi"]), True).decode()
    port = data["port"]
    if not isinstance(port,int) or not 1024 <= port <= 65535:
        raise ValueError("Invalid local port.")
    request = urllib.request.Request(f"http://127.0.0.1:{port}"+path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"X-Patch-Token":token, "Content-Type":"application/json"})
    with urllib.request.build_opener(NoRedirect()).open(request,timeout=2) as response:
        return json.load(response), port

def ensure_server():
    try:
        _, port = runtime_request("/api/state")
        return port
    except Exception:
        executable = Path(sys.executable).with_name("pythonw.exe")
        subprocess.Popen([str(executable), str(Path(__file__).resolve()), "serve"],
            creationflags=0x08000000, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        for _ in range(50):
            time.sleep(.1)
            try:
                _, port = runtime_request("/api/state")
                return port
            except Exception:
                pass
        raise ValueError("Patch's panel could not start. Run Start Patch Voice.cmd again.")

def hook_registered():
    try:
        data = json.loads((Path.home()/".codex/hooks.json").read_text(encoding="utf-8"))
        return any(str(Path(__file__).resolve()) in h.get("command", "")
            for group in data.get("hooks",{}).get("Stop",[]) for h in group.get("hooks",[]))
    except (OSError,ValueError,TypeError):
        return False

def install():
    target = Path.home()/".codex/hooks.json"
    data = json.loads(target.read_text(encoding="utf-8")) if target.exists() else {"hooks":{}}
    if not isinstance(data.get("hooks"),dict):
        raise ValueError("Existing hook settings require manual review; nothing changed.")
    if not CONFIG.exists():
        save_profile(DEFAULTS)
    original = target.read_bytes() if target.exists() else None
    if original is not None:
        backup = ROOT/"backups"/f"hooks-{time.time_ns()}.json"
        backup.parent.mkdir(exist_ok=True)
        backup.write_bytes(original)
    for event in ("Stop", "Interrupt", "UserPromptSubmit"):
        groups = data["hooks"].setdefault(event, [])
        command = f'"{sys.executable}" "{Path(__file__).resolve()}" hook'
        if not any(command == item.get("command") for group in groups for item in group.get("hooks",[])):
            handler=dict(type="command",command=command,timeout=10 if event=="Stop" else 3)
            if event == "UserPromptSubmit":
                handler["additionalContextLimit"] = 500
            groups.append({"hooks":[handler]})
    atomic_json(target, data)
    print("Patch hooks registered. Existing hooks preserved. Review new hooks in Codex before they run.")

def serve():
    # Single bridge per user/session: a named mutex prevents competing startup calls.
    mutex_name = "Local\\PatchVoiceBridge-" + hashlib.sha256(str(ROOT).encode()).hexdigest()[:20]
    ctypes.windll.kernel32.CreateMutexW.restype = ctypes.c_void_p
    handle = ctypes.windll.kernel32.CreateMutexW(None, False, mutex_name)
    if ctypes.windll.kernel32.GetLastError() == 183:
        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(handle))
        return
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        if not CONFIG.exists():
            save_profile(DEFAULTS)
        server = ThreadingHTTPServer(("127.0.0.1",0), Handler)
        Handler.token = secrets.token_urlsafe(32)
        Handler.engine = Engine()
        atomic_json(RUNTIME, dict(port=server.server_port,pid=os.getpid(),
            token_dpapi=base64.b64encode(protect(Handler.token.encode())).decode()))
        server.serve_forever()
    finally:
        ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(handle))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["serve","start","open","hook","install","status"])
    args = parser.parse_args()
    if args.action == "serve":
        serve()
    elif args.action == "install":
        install()
    elif args.action == "open":
        webbrowser.open(f"http://127.0.0.1:{ensure_server()}/")
    elif args.action == "start":
        print(f"Panel: http://127.0.0.1:{ensure_server()}/")
    elif args.action == "status":
        state, port = runtime_request("/api/state")
        print(json.dumps({k:state[k] for k in ("key_connected","voice_id","scope","enabled","muted","patch_active","hook_registered","status","error")},indent=2))
        print(f"Panel: http://127.0.0.1:{port}/")
    elif args.action == "hook":
        try:
            event = json.loads(sys.stdin.read(64001))
            cfg = profile()
            if (event.get("hook_event_name") == "UserPromptSubmit" and cfg["enabled"]
                and chat_allowed(event,cfg) and patch_active()):
                print(json.dumps({"hookSpecificOutput":{"hookEventName":"UserPromptSubmit", "additionalContext":
                    "You are Sir David Blackenfeather, an observant British gentleman of seventy. "
                    "Keep replies helpful and accurate, with occasional gentle dry humour and understated phrasing. "
                    "Preserve the user's requested language and professional tone. Do not force jokes into serious work, "
                    "code or factual explanations. Speech uses the saved voice through a separate local add-on."}}))
                return
            if event.get("hook_event_name") == "Interrupt":
                if chat_allowed(event,cfg) and RUNTIME.exists():
                    runtime_request("/api/interrupt", {"session_id":event["session_id"]})
            elif eligible(event,cfg):
                ensure_server()
                runtime_request("/api/hook", {k:event.get(k) for k in
                    ("hook_event_name","session_id","turn_id","stop_hook_active","last_assistant_message")})
        except Exception:
            pass  # Advisory hook: a voice fault must never interrupt the user's work.
        print("{}")

if __name__ == "__main__":
    main()
