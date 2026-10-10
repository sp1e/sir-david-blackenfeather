(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let history = [], busy = false, speechBusy = false, connected = false, speechConnected = false, audio = null, audioUrl = null, controller = null;
  let epoch = 0, revision = 0, authorized = false;
  let speechEpoch = 0, speechController = null;
  let initialized = false, initializing = false;
  let autoSpeak = false, preferencesReady = false, preferencesBusy = false, preferenceRevision = -1, voicePlayer = null, preferencesFailed = false;
  const silentAudio = new URL('/admin/assets/silence.wav', window.location.origin).href;
  function setPanel(open, syncUrl = true) {
    $('sir-david-panel').hidden = !open;
    $('admin-launcher').hidden = open;
    $('new-chat').hidden = !open;
    $('speech-note').hidden = !open;
    $('open-sir-david').setAttribute('aria-expanded', String(open));
    if (syncUrl) {
      const url = new URL(window.location.href);
      if (open) url.searchParams.set('panel', 'sir-david'); else url.searchParams.delete('panel');
      window.history.replaceState(null, '', url);
    }
    if (open) {
      if (!initialized && !initializing) init();
      $('close-sir-david').focus();
    } else {
      epoch++; controller?.abort(); cancelSpeech();
      $('open-sir-david').focus();
    }
  }
  $('open-sir-david').addEventListener('click', () => setPanel(true));
  $('close-sir-david').addEventListener('click', () => setPanel(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('sir-david-panel').hidden) setPanel(false); });
  window.addEventListener('popstate', () => setPanel(new URL(window.location.href).searchParams.get('panel') === 'sir-david', false));
  async function api(route, options = {}) {
    const response = await fetch('/api/sir-david/' + route, { credentials: 'same-origin', cache: 'no-store', ...options });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) { authorized = false; connected = false; speechConnected = false; cancelSpeech(); $('messages').replaceChildren(); $('memories').replaceChildren(); history = []; update(); }
      const data = await response.json().catch(() => ({}));
      throw Error(data.error || 'Anropet kunde inte slutföras.');
    }
    return response;
  }
  const post = (route, body, signal) => api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  function update() { $('send').disabled = busy || !connected; $('model').disabled = busy || !connected; $('prompt').disabled = busy; $('new-chat').disabled = !authorized; $('reload-chat').disabled = busy || !authorized; $('save-memory').disabled = !authorized; $('sound-toggle').disabled = !authorized || !preferencesReady || preferencesBusy; $('sound-toggle').textContent = !preferencesReady ? 'Läser ljudval…' : autoSpeak ? 'Ljud på' : 'Ljud av'; $('sound-toggle').setAttribute('aria-pressed', String(autoSpeak)); document.querySelectorAll('.listen-button').forEach(button => { button.disabled = !autoSpeak || speechBusy; }); }
  function stopAudio() { if (audio) { audio.pause(); audio = null; } if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; } }
  function cancelSpeech() { speechEpoch++; speechController?.abort(); speechController = null; speechBusy = false; stopAudio(); $('stop-speech').hidden = true; }
  $('stop-speech').addEventListener('click', () => { cancelSpeech(); $('status').textContent = 'Rösten är stoppad.'; });
  function applyPreferences(value) {
    if (!value || typeof value.autoSpeak !== 'boolean' || !Number.isSafeInteger(value.version) || value.version < 0) throw Error('Ljudinställningen kunde inte läsas.');
    if (value.version < preferenceRevision) return;
    preferenceRevision = value.version; autoSpeak = value.autoSpeak; preferencesReady = true;
    if (!autoSpeak) cancelSpeech(); update();
  }
  async function refreshPreferences() { const value = (await (await api('preferences')).json()).preferences; if (!preferencesBusy) applyPreferences(value); }
  function primeAudio() {
    if (!speechConnected) return;
    voicePlayer ??= new Audio(); const player = voicePlayer;
    if (audio || speechBusy) return;
    player.src = silentAudio;
    Promise.resolve(player.play()).then(() => { if (player.src === silentAudio) player.pause(); }).catch(() => {});
  }
  $('sound-toggle').addEventListener('click', async () => {
    if (!authorized || !preferencesReady || preferencesBusy) return;
    const desired = !autoSpeak, expected = preferenceRevision;
    if (desired) primeAudio(); else { autoSpeak = false; cancelSpeech(); }
    preferencesBusy = true; update();
    try {
      const result = await (await api('preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoSpeak: desired, version: expected }) })).json();
      preferencesFailed = false; applyPreferences(result.preferences); $('status').textContent = desired ? 'Ljud på, sparat för Admin och skrivbord.' : 'Ljud av, sparat för Admin och skrivbord.';
    } catch (error) {
      // Stay silent on a failed save; reload server truth only after the user retries.
      preferencesFailed = true; autoSpeak = false; cancelSpeech(); $('status').textContent = error.message + ' Läs in samtalet för att hämta ljudvalet igen.';
    } finally { preferencesBusy = false; update(); }
  });
  async function speakContent(content) {
    if (!authorized || !speechConnected || !autoSpeak || preferencesBusy || preferencesFailed) return;
    cancelSpeech(); const ownSpeechEpoch = speechEpoch;
    speechBusy = true; speechController = new AbortController(); $('stop-speech').hidden = false; update();
    try {
      for (let offset = 0; offset < content.length; offset += 1200) {
        if (ownSpeechEpoch !== speechEpoch || !authorized || !autoSpeak) return;
        $('status').textContent = 'Förbereder rösten…';
        const response = await post('speech', { text: content.slice(offset, offset + 1200) }, speechController.signal);
        const blob = await response.blob();
        if (ownSpeechEpoch !== speechEpoch || !authorized || !autoSpeak) return;
        await refreshPreferences();
        if (ownSpeechEpoch !== speechEpoch || !authorized || !autoSpeak) return;
        const url = URL.createObjectURL(blob), playing = voicePlayer ?? new Audio(); voicePlayer = playing;
        audioUrl = url; audio = playing; playing.src = url;
        const signal = speechController.signal;
        let onEnded, onError;
        const ended = new Promise((resolve, reject) => {
          onEnded = resolve; onError = () => reject(Error('Rösten kunde inte spelas upp.'));
          playing.addEventListener('ended', onEnded, { once: true });
          playing.addEventListener('error', onError, { once: true });
          signal.addEventListener('abort', onEnded, { once: true });
        });
        ended.catch(() => {});
        try {
          await playing.play();
          if (ownSpeechEpoch !== speechEpoch) return;
          $('status').textContent = 'Sir David talar…';
          await ended;
        } finally {
          playing.removeEventListener('ended', onEnded); playing.removeEventListener('error', onError); signal.removeEventListener('abort', onEnded);
        }
        if (ownSpeechEpoch !== speechEpoch) return;
        stopAudio();
      }
      if (ownSpeechEpoch === speechEpoch) $('status').textContent = '';
    } catch (error) {
      if (ownSpeechEpoch === speechEpoch) {
        $('status').textContent = error.name === 'AbortError' ? 'Rösten är stoppad.' : error.name === 'NotAllowedError' ? 'Webbläsaren blockerade automatljud. Välj Lyssna vid svaret.' : error.message;
        stopAudio();
      }
    } finally {
      if (ownSpeechEpoch === speechEpoch) { speechBusy = false; speechController = null; $('stop-speech').hidden = true; update(); }
    }
  }
  function message(role, content) {
    const row = document.createElement('article'); row.className = 'message ' + role;
    const label = document.createElement('span'); label.className = 'eyebrow'; label.textContent = role === 'user' ? 'Du' : 'Sir David';
    const paragraph = document.createElement('p'); paragraph.textContent = content; row.append(label, paragraph);
    if (role === 'assistant' && speechConnected) {
      const speak = document.createElement('button'); speak.type = 'button'; speak.className = 'pill listen-button'; speak.textContent = 'Lyssna'; speak.disabled = !autoSpeak || speechBusy;
      speak.addEventListener('click', () => { if (!speechBusy && autoSpeak) { primeAudio(); speakContent(content); } }); row.append(speak);
    }
    $('messages').append(row);
  }
  function renderConversation(value) { revision = value.version; history = value.messages; $('messages').replaceChildren(); for (const item of history) message(item.role, item.content); }
  async function loadConversation() { const data = await (await api('conversation')).json(); renderConversation(data.conversation); }
  $('reload-chat').addEventListener('click', async () => { if (busy) return; try { await refreshPreferences(); preferencesFailed = false; await loadConversation(); $('status').textContent = 'Samtalet är inläst.'; } catch (error) { $('status').textContent = error.message; } });
  async function loadMemories() {
    const data = await (await api('memories')).json(); $('memories').replaceChildren(); $('memory-count').textContent = String(data.memories.length);
    for (const item of data.memories) {
      const row = document.createElement('li'), paragraph = document.createElement('p'), remove = document.createElement('button'); paragraph.textContent = item.content;
      remove.type = 'button'; remove.className = 'pill'; remove.textContent = 'Radera'; remove.setAttribute('aria-label', 'Radera anteckning: ' + item.content.slice(0, 60));
      remove.addEventListener('click', async () => {
        if (!confirm('Radera den här anteckningen från ditt gemensamma minne?')) return;
        remove.disabled = true;
        try { await api('memories/' + encodeURIComponent(item.id), { method: 'DELETE' }); await loadMemories(); $('memory-status').textContent = 'Anteckningen är raderad.'; }
        catch (error) { $('memory-status').textContent = error.message; remove.disabled = false; }
      }); row.append(paragraph, remove); $('memories').append(row);
    }
  }
  $('chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !connected) return;
    const content = $('prompt').value.trim(); if (!content) return;
    cancelSpeech(); if (autoSpeak) primeAudio();
    busy = true; controller = new AbortController(); const ownEpoch = epoch; update(); $('status').textContent = 'Sir David funderar…';
    try {
      const data = await (await post('chat', { model: $('model').value, text: content, version: revision }, controller.signal)).json();
      if (ownEpoch !== epoch) return;
      renderConversation(data.conversation); $('prompt').value = ''; $('status').textContent = '';
      if (!preferencesFailed) await refreshPreferences();
      if (ownEpoch === epoch && autoSpeak && !preferencesBusy && !preferencesFailed) {
        const reply = data.conversation.messages.at(-1);
        if (reply?.role === 'assistant') speakContent(reply.content);
      }
    } catch (error) { if (ownEpoch === epoch) $('status').textContent = error.name === 'AbortError' ? 'Anropet avbröts.' : error.message; }
    finally { busy = false; controller = null; update(); }
  });
  $('new-chat').addEventListener('click', async () => {
    if (!confirm('Radera det gemensamma samtalet? Sparade minnesanteckningar behålls.')) return;
    epoch++; controller?.abort(); cancelSpeech();
    try { const data = await (await api('conversation', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: revision }) })).json(); renderConversation(data.conversation); $('status').textContent = 'Samtalet är raderat.'; }
    catch (error) { $('status').textContent = error.message; }
  });
  $('memory-form').addEventListener('submit', async event => {
    event.preventDefault(); $('save-memory').disabled = true;
    try { await post('memories', { content: $('memory-text').value }); $('memory-text').value = ''; await loadMemories(); $('memory-status').textContent = 'Anteckningen finns nu i ditt gemensamma minne.'; }
    catch (error) { $('memory-status').textContent = error.message; }
    finally { $('save-memory').disabled = !authorized; }
  });
  window.addEventListener('pagehide', () => { epoch++; controller?.abort(); cancelSpeech(); history = []; });
  async function init() {
    initializing = true;
    try {
      const data = await (await api('profile')).json(); authorized = true; connected = data.chatConnected; speechConnected = data.speechConnected;
      applyPreferences(data.preferences);
      $('name').textContent = data.profile.displayName;
      $('model').replaceChildren();
      for (const model of data.models) { const option = document.createElement('option'); option.value = model; option.textContent = model; $('model').append(option); }
      $('connection').textContent = (connected ? 'Ollama Cloud anslutet' : 'Ollama Cloud väntar på anslutning') + ' · ' + (speechConnected ? 'Din röst är ansluten' : 'Rösten väntar på en servernyckel');
      await loadMemories(); await loadConversation();
      initialized = true;
    } catch (error) { $('connection').textContent = error.message; }
    finally { initializing = false; }
    update();
  }
  if (new URL(window.location.href).searchParams.get('panel') === 'sir-david') setPanel(true, false);
  const preferenceTimer = setInterval(() => { if (initialized && authorized && !preferencesBusy && !preferencesFailed && !$('sir-david-panel').hidden) refreshPreferences().catch(() => { preferencesFailed = true; autoSpeak = false; cancelSpeech(); update(); }); }, 5000);
  window.addEventListener('pagehide', () => clearInterval(preferenceTimer));
})();
