var SirDavidLocal = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // ../local-adapter/claude-adapter.mjs
  var claude_adapter_exports = {};
  __export(claude_adapter_exports, {
    ClaudeAdapter: () => ClaudeAdapter,
    localRequest: () => localRequest
  });
  var BRIDGE = "http://127.0.0.1:4318";
  var ORIGINS = /* @__PURE__ */ new Set(["https://sp1e.se", "https://www.sp1e.se"]);
  var abortError = () => new DOMException("Uppdraget avbr\xF6ts.", "AbortError");
  function boundedText(value, limit) {
    if (typeof value !== "string" || !value.trim() || value.length > limit) throw Error("Ogiltigt eller f\xF6r stort underlag.");
    return value;
  }
  function localRequest(prepared, now = Date.now()) {
    const { turn, context } = prepared ?? {};
    if (!turn || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(turn.id) || !Number.isSafeInteger(turn.version) || turn.version < 0 || !Number.isSafeInteger(turn.expiresAt) || turn.expiresAt <= now || turn.expiresAt > now + 18e4) throw Error("Turen saknas eller har g\xE5tt ut.");
    const persona = boundedText(context?.persona, 6e3), prompt = boundedText(context?.text, 4e3);
    const messages = context?.messages, memories = context?.memories;
    if (!Array.isArray(messages) || messages.length > 15 || messages.some((item) => !item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string" || item.content.length > 12e3) || messages.reduce((sum, item) => sum + item.content.length, 0) > 16e3) throw Error("Samtalet \xE4r f\xF6r stort.");
    if (!Array.isArray(memories) || memories.length > 100 || memories.some((item) => typeof item !== "string" || item.length > 1e3)) throw Error("Minnesunderlaget \xE4r ogiltigt.");
    const notes = JSON.stringify(memories);
    if (notes.length > 2e4) throw Error("Minnesunderlaget \xE4r f\xF6r stort.");
    return { provider: "claude", kind: "sir-david", prompt, persona, notes: [...memories], messages: messages.map((item) => ({ role: item.role, content: item.content })) };
  }
  var ClaudeAdapter = class {
    #token = null;
    #expiresAt = 0;
    #generation = 0;
    #active = null;
    #pairing = null;
    constructor({ origin, fetchImpl = (...args) => globalThis.fetch(...args), events = globalThis.window, openPopup = (...args) => globalThis.window.open(...args), now = Date.now, sleep } = {}) {
      if (!ORIGINS.has(origin)) throw Error("Lokal anslutning kr\xE4ver r\xE4tt Admin-webbplats.");
      Object.assign(this, { origin, fetchImpl, events, openPopup, now });
      this.sleep = sleep ?? ((ms, signal) => new Promise((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(abortError());
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, ms);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }));
    }
    get connected() {
      return Boolean(this.#token && this.#expiresAt > this.now());
    }
    async pair({ signal } = {}) {
      if (signal?.aborted) throw abortError();
      const popup = this.openPopup(BRIDGE + "/__connect/?origin=" + encodeURIComponent(this.origin), "sir-david-local", "popup,width=520,height=640");
      if (!popup) throw Error("Till\xE5t anslutningsf\xF6nstret f\xF6r att koppla Claude.");
      this.#pairing?.abort();
      const pairing = new AbortController();
      this.#pairing = pairing;
      signal = AbortSignal.any([pairing.signal, ...signal ? [signal] : []]);
      const generation = this.#generation;
      try {
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer);
            this.events.removeEventListener("message", receive);
            signal?.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup();
            popup.close();
            reject(abortError());
          };
          const receive = (event) => {
            if (event.origin !== BRIDGE || event.source !== popup || event.data?.type !== "sp1e-local-paired" || typeof event.data.token !== "string" || !/^[A-Za-z0-9_-]{30,100}$/.test(event.data.token)) return;
            cleanup();
            if (generation !== this.#generation) {
              popup.close();
              reject(abortError());
              return;
            }
            this.#token = event.data.token;
            this.#expiresAt = this.now() + 36e5;
            popup.close();
            resolve();
          };
          const timer = setTimeout(() => {
            cleanup();
            popup.close();
            reject(Error("Anslutningen tog f\xF6r l\xE5ng tid."));
          }, 12e4);
          this.events.addEventListener("message", receive);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      } finally {
        if (this.#pairing === pairing) this.#pairing = null;
      }
    }
    async #request(path, { body, signal, token = this.#token } = {}) {
      if (!token || token === this.#token && !this.connected) throw Error("Anslut Claude igen.");
      const timeout = AbortSignal.timeout(path.startsWith("/__agents/status") ? 25e3 : 15e3);
      const response = await this.fetchImpl(BRIDGE + path, {
        method: body ? "POST" : "GET",
        credentials: "omit",
        cache: "no-store",
        headers: { "X-Sp1e-Session": token, ...body ? { "Content-Type": "application/json" } : {} },
        ...body ? { body: JSON.stringify(body) } : {},
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout
      });
      const reader = response.body.getReader(), chunks = [];
      let size = 0;
      try {
        while (true) {
          const { done, value: value2 } = await reader.read();
          if (done) break;
          size += value2.byteLength;
          if (size > 64e3) {
            await reader.cancel();
            throw Error("Den lokala agentens svar \xE4r f\xF6r stort.");
          }
          chunks.push(value2);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const source = new TextDecoder().decode(bytes);
      const value = JSON.parse(source);
      if (!response.ok) {
        if (response.status === 401 && token === this.#token) {
          this.#token = null;
          this.#expiresAt = 0;
        }
        throw Error(response.status === 401 ? "Anslut Claude igen." : "Den lokala agenten kunde inte slutf\xF6ra uppdraget.");
      }
      return value;
    }
    async status(signal) {
      return this.#request("/__agents/status?provider=claude&kind=sir-david", { signal });
    }
    async workspace(signal) {
      return this.#request("/__agents/workspace", { signal });
    }
    async undo(changeId, expectedVersion, signal) {
      return this.#request("/__agents/workspace/undo", { body: { changeId, expectedVersion }, signal });
    }
    async disconnect() {
      const token = this.#token;
      this.#generation++;
      this.#token = null;
      this.#expiresAt = 0;
      this.#active?.abort();
      this.#pairing?.abort();
      if (token) await this.#request("/__agents/disconnect", { token, body: {} }).catch(() => {
      });
    }
    async answer(prepared, { signal, model = "", effort = "", workspace = false } = {}) {
      if (this.#active) throw Error("Claude arbetar redan.");
      const request = localRequest(prepared, this.now()), turn = { ...prepared.turn }, generation = this.#generation, token = this.#token;
      const controller = new AbortController();
      this.#active = controller;
      const combined = AbortSignal.any([controller.signal, AbortSignal.timeout(15e4), ...signal ? [signal] : []]);
      let id;
      try {
        const status = await this.status(combined), claude = status.providers?.find((item) => item.id === "claude");
        if (!claude?.installed || !claude.signedIn) throw Error("Logga in i Claude Code p\xE5 datorn.");
        if (claude.billingMode !== "subscription") throw Error("Bryggan m\xE5ste bekr\xE4fta Claude-abonnemanget f\xF6re aktivering.");
        if (workspace) {
          if (claude.workspace?.enabled !== true) throw Error("Anslut igen och godk\xE4nn arbetsmappens fil\xE5tkomst.");
          request.workspace = true;
        }
        if (model || effort) {
          const choice = claude.models?.find((item) => item.id === model);
          if (!choice || effort && !choice.efforts?.includes(effort)) throw Error("V\xE4lj en tillg\xE4nglig Claude-modell och niv\xE5.");
          request.model = model;
          if (effort) request.effort = effort;
        }
        if (combined.aborted || generation !== this.#generation) throw abortError();
        const job = await this.#request("/__agents/jobs", { body: request, signal: combined });
        id = job.id;
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{10,80}$/.test(id)) throw Error("Den lokala uppgiften saknar ett giltigt ID.");
        while (true) {
          if (combined.aborted || generation !== this.#generation) throw abortError();
          if (turn.expiresAt <= this.now()) throw Error("Turen har g\xE5tt ut.");
          const result = await this.#request("/__agents/jobs/" + encodeURIComponent(id), { signal: combined });
          if (combined.aborted || generation !== this.#generation) throw abortError();
          if (turn.expiresAt <= this.now()) throw Error("Turen har g\xE5tt ut.");
          if (result.state === "done") return { turnId: turn.id, version: turn.version, text: boundedText(result.result?.text, 12e3) };
          if (["error", "cancelled"].includes(result.state)) throw Error("Claude kunde inte slutf\xF6ra svaret. Kontrollera inloggning och kvot.");
          if (result.state !== "running") throw Error("Ok\xE4nd lokal uppgiftsstatus.");
          await this.sleep(500, combined);
        }
      } catch (error) {
        if (id) await this.#request("/__agents/cancel", { token, body: { id } }).catch(() => {
        });
        throw error;
      } finally {
        if (this.#active === controller) this.#active = null;
      }
    }
  };
  return __toCommonJS(claude_adapter_exports);
})();
