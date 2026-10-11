(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let history = [], busy = false, speechBusy = false, connected = false, speechConnected = false, audio = null, audioUrl = null, controller = null;
  let epoch = 0, revision = 0, authorized = false;
  let speechEpoch = 0, speechController = null;
  let initialized = false, initializing = false;
  let autoSpeak = false, preferencesReady = false, preferencesBusy = false, preferenceRevision = -1, voicePlayer = null, preferencesFailed = false;
  const silentAudio = new URL('/admin/assets/silence.wav', window.location.origin).href;
  let localReady = false, localConnecting = false, localModels = [], pairController = null;
  let workspaceReady = false, workspaceName = '', filesBusy = false;
  let planner = null;
  let nativeVisible = true;
  window.chrome?.webview?.addEventListener('message', event => { if (event.data?.type === 'sir-david-native-tick' && typeof event.data.visible === 'boolean') { nativeVisible = event.data.visible; if (!nativeVisible) { cancelSpeech(); update(); } } });
  // Unsupported preview origins must not stop the existing cloud companion.
  let localAdapter = null;
  if (window.SirDavidLocal) {
    try { localAdapter = new window.SirDavidLocal.ClaudeAdapter({ origin: window.location.origin }); }
    catch { /* Pairing remains limited to the approved production origins. */ }
  }
  const isLocal = () => $('provider').value === 'claude';
  const canChat = () => authorized && (isLocal() ? localReady && localAdapter?.connected : connected);
  function connectionStatus() {
    $('connection').textContent = (isLocal() ? localConnecting ? 'Ansluter Claude Code…' : localReady && localAdapter?.connected ? 'Claude Code anslutet · lokalt' : 'Claude Code väntar på anslutning' : connected ? 'Ollama Cloud anslutet' : 'Ollama Cloud väntar på anslutning') + ' · ' + (speechConnected ? 'Din röst är ansluten' : 'Rösten väntar på en servernyckel');
  }
  function claudeEfforts() {
    const prior = $('claude-effort').value, levels = localModels.find(item => item.id === $('claude-model').value)?.efforts ?? [];
    $('claude-effort').replaceChildren(new Option('Standardnivå', ''));
    const names = { low: 'Låg', medium: 'Mellan', high: 'Hög', xhigh: 'Mycket hög', max: 'Max' };
    for (const level of levels) if (Object.hasOwn(names, level)) $('claude-effort').append(new Option(names[level], level));
    if (levels.includes(prior)) $('claude-effort').value = prior;
    $('claude-effort').disabled = busy || !localReady || levels.length === 0;
    $('claude-note').textContent = $('claude-model').value === 'fable' ? 'Fable kan använda extrakrediter enligt ditt Claude-kontos villkor.' : 'Använder din Claude-inloggning och dess användningsgränser. Datorn behöver vara igång.';
  }
  async function verifyClaude(signal) {
    if (!localAdapter?.connected) throw Error('Anslut Claude Code först.');
    const value = await localAdapter.status(signal), provider = value.providers?.find(item => item.id === 'claude');
    if (signal?.aborted || !authorized) throw new DOMException('Avbrutet', 'AbortError');
    if (!provider?.installed || !provider.signedIn || provider.billingMode !== 'subscription') {
      localReady = false; update(); throw Error('Claude-inloggningen kunde inte verifieras. Uppdatera och starta om den lokala anslutningen.');
    }
    workspaceReady = provider.workspace?.enabled === true;
    workspaceName = workspaceReady && typeof provider.workspace.name === 'string' ? provider.workspace.name.slice(0,100) : '';
    if (!workspaceReady) $('files-mode').checked = false;
    const selected = $('claude-model').value, effort = $('claude-effort').value;
    localModels = Array.isArray(provider.models) ? provider.models.filter(item => item && typeof item.id === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(item.id) && typeof item.name === 'string' && Array.isArray(item.efforts)) : [];
    $('claude-model').replaceChildren(new Option('Claudes standardmodell', ''));
    for (const item of localModels) $('claude-model').append(new Option(item.name.slice(0, 100), item.id));
    const choice = localModels.find(item => item.id === selected);
    if (choice) $('claude-model').value = selected;
    localReady = true; claudeEfforts(); update();
    if (selected && (!choice || (effort && !choice.efforts.includes(effort)))) throw Error('Det tidigare modellvalet är inte tillgängligt. Välj modell och nivå igen.');
  }
  $('provider').addEventListener('change', () => { cancelSpeech(); $('claude-options').hidden = !isLocal(); $('model').hidden = isLocal(); update(); });
  async function fileActivity() {
    if (!authorized || !workspaceReady || !localAdapter?.connected) return;
    const ownEpoch = epoch;
    await api('preferences');
    const value = await localAdapter.workspace();
    if (!authorized || ownEpoch !== epoch) return;
    $('file-activity').replaceChildren();
    for (const item of Array.isArray(value.activity) ? value.activity.slice(0,20) : []) {
      if (!item || typeof item.path !== 'string' || !/^[0-9]{10,22}-[a-f0-9]{32}$/.test(item.id) || !(item.action === 'undo-create' && item.afterVersion === null) && !/^[a-f0-9]{64}$/.test(item.afterVersion)) continue;
      const row = document.createElement('li'), label = document.createElement('span'), button = document.createElement('button');
      const action = {create:'Skapad',edit:'Ändrad','undo-create':'Borttagen vid återställning'}[item.action] || 'Ändrad';
      label.textContent = item.path.slice(0,240) + ' · ' + action; button.className = 'pill'; button.type = 'button'; button.textContent = item.action === 'undo-create' ? 'Återskapa filen' : 'Återställ'; button.disabled = busy || filesBusy;
      button.addEventListener('click', async () => {
        if (busy || filesBusy || !authorized) return;
        filesBusy = true; update();
        try { await api('preferences'); if (!authorized || ownEpoch !== epoch) return; await localAdapter.undo(item.id,item.afterVersion); if (!authorized || ownEpoch !== epoch) return; $('file-status').textContent = 'Ändringen är återställd.'; await fileActivity(); }
        catch (error) { if (authorized && ownEpoch === epoch) $('file-status').textContent = 'Filen har ändrats eller kunde inte återställas. Läs in filhistoriken igen.'; }
        finally { filesBusy = false; update(); }
      });
      row.append(label,button); $('file-activity').append(row);
    }
  }
  $('reload-files').addEventListener('click', () => fileActivity().catch(() => { if (authorized) $('file-status').textContent = 'Filhistoriken kunde inte hämtas. Anslut igen.'; }));
  $('claude-model').addEventListener('change', claudeEfforts);
  $('connect-claude').addEventListener('click', async () => {
    if (busy || !authorized) return;
    if (localConnecting) { pairController?.abort(); return; }
    if (localAdapter?.connected) { localReady = false; workspaceReady = false; $('files-mode').checked = false; $('file-activity').replaceChildren(); await localAdapter.disconnect(); update(); return; }
    if (!localAdapter) { $('status').textContent = 'Lokal Claude ansluts från sp1e.se. Öppna din Admin-sida där.'; return; }
    localConnecting = true; pairController = new AbortController(); update(); $('status').textContent = 'Godkänn anslutningen i det lokala fönstret.';
    try { await localAdapter.pair({ signal: pairController.signal }); await verifyClaude(pairController.signal); await fileActivity(); $('status').textContent = 'Claude Code är anslutet. Sir David använder samma minne och röst.'; }
    catch (error) { localReady = false; await localAdapter.disconnect(); $('status').textContent = error.name === 'AbortError' ? 'Anslutningen avbröts.' : error.message; }
    finally { localConnecting = false; pairController = null; update(); }
  });
  $('stop-chat').addEventListener('click', () => { epoch++; controller?.abort(); cancelSpeech(); $('status').textContent = 'Avbryter svaret…'; update(); });
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
      epoch++; controller?.abort(); pairController?.abort(); cancelSpeech();
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
      if (response.status === 401 || response.status === 403) { authorized = false; connected = false; speechConnected = false; localReady = false; workspaceReady = false; planner?.clear(); $('files-mode').checked = false; $('file-activity').replaceChildren(); pairController?.abort(); controller?.abort(); localAdapter?.disconnect(); cancelSpeech(); $('messages').replaceChildren(); $('memories').replaceChildren(); history = []; update(); }
      const data = await response.json().catch(() => ({}));
      throw Error(data.error || 'Anropet kunde inte slutföras.');
    }
    return response;
  }
  const post = (route, body, signal) => api(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  planner = window.SirDavidPlanner?.create({ api, post, authorized: () => authorized, speechEnabled: () => autoSpeak && speechConnected && preferencesReady && !preferencesFailed, canSpeak: () => !busy && !speechBusy && !preferencesBusy, speak: content => speakContent(content) });
  function update() {
    $('send').disabled = busy || filesBusy || !canChat(); $('model').disabled = busy || !connected;
    $('files-mode').disabled = busy || filesBusy || !authorized || !workspaceReady || !localAdapter?.connected;
    $('file-panel').hidden = !authorized || !isLocal() || !workspaceReady || !localAdapter?.connected;
    $('reload-files').disabled = busy || filesBusy;
    $('file-activity').querySelectorAll('button').forEach(button => { button.disabled = busy || filesBusy; });
    $('workspace-note').textContent = workspaceReady && localAdapter?.connected ? 'Arbetsmapp: ' + workspaceName + '. Filinnehåll som behövs för uppdraget skickas till Claude. Ändringar får lokal filhistorik.' : 'Anslut Claude och godkänn filåtkomst i det lokala fönstret. Filåtkomsten gäller bara din valda arbetsmapp.';
    $('provider').disabled = busy || localConnecting || !authorized;
    $('claude-model').disabled = busy || !localReady;
    $('claude-effort').disabled = busy || !localReady || !localModels.find(item => item.id === $('claude-model').value)?.efforts.length;
    $('connect-claude').disabled = busy || !authorized;
    $('connect-claude').textContent = localConnecting ? 'Avbryt anslutning' : localAdapter?.connected ? 'Koppla från Claude' : 'Anslut Claude';
    $('stop-chat').hidden = !busy; $('stop-chat').disabled = Boolean(controller?.signal.aborted);
    $('prompt').disabled = busy; $('new-chat').disabled = !authorized; $('reload-chat').disabled = busy || !authorized; $('save-memory').disabled = !authorized;
    $('sound-toggle').disabled = !authorized || !preferencesReady || preferencesBusy;
    $('sound-toggle').textContent = !preferencesReady ? 'Läser ljudval…' : autoSpeak ? 'Ljud på' : 'Ljud av';
    $('sound-toggle').setAttribute('aria-pressed', String(autoSpeak));
    document.querySelectorAll('.listen-button').forEach(button => { button.disabled = !autoSpeak || speechBusy; });
    if (authorized) connectionStatus();
  }
  function stopAudio() { if (audio) { audio.pause(); audio = null; } if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; } }
  function cancelSpeech() { speechEpoch++; speechController?.abort(); speechController = null; speechBusy = false; stopAudio(); $('stop-speech').hidden = true; }
  $('stop-speech').addEventListener('click', () => { cancelSpeech(); update(); $('status').textContent = 'Rösten är stoppad.'; });
  function applyPreferences(value) {
    if (!value || typeof value.autoSpeak !== 'boolean' || !Number.isSafeInteger(value.version) || value.version < 0) throw Error('Ljudinställningen kunde inte läsas.');
    if (value.version < preferenceRevision) return;
    const mutedWhileSpeaking = !value.autoSpeak && speechBusy;
    preferenceRevision = value.version; autoSpeak = value.autoSpeak; preferencesReady = true;
    if (!autoSpeak) cancelSpeech();
    if (mutedWhileSpeaking) $('status').textContent = 'Ljudet är avstängt i din andra vy.';
    update();
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
    if (!authorized || !nativeVisible || !speechConnected || !autoSpeak || preferencesBusy || preferencesFailed) return;
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
  async function localChat(content, signal, ownEpoch) {
    const wantsFiles = $('files-mode').checked;
    let turn;
    try {
      await verifyClaude(signal);
      if (wantsFiles && !workspaceReady) throw Error('Filåtkomsten har upphört. Anslut igen innan du fortsätter filuppdraget.');
      const prepared = await (await post('local/prepare', { text: content, version: revision, provider: 'claude' }, signal)).json();
      turn = prepared.turn;
      if (signal.aborted || ownEpoch !== epoch || !authorized) throw new DOMException('Avbrutet', 'AbortError');
      const answer = await localAdapter.answer(prepared, { signal, model: $('claude-model').value, effort: $('claude-effort').value, workspace: wantsFiles });
      if (signal.aborted || ownEpoch !== epoch || !authorized) throw new DOMException('Avbrutet', 'AbortError');
      return await (await post('local/commit', answer, signal)).json();
    } finally {
      if (turn?.id) await api('local/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ turnId: turn.id }), signal: AbortSignal.timeout(15_000), keepalive: true }).catch(() => {});
    }
  }
  $('chat-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || filesBusy || !canChat()) return;
    const content = $('prompt').value.trim(); if (!content) return;
    cancelSpeech(); if (autoSpeak) primeAudio();
    busy = true; controller = new AbortController(); const ownEpoch = epoch; update(); $('status').textContent = 'Sir David funderar…';
    try {
      const data = isLocal() ? await localChat(content, controller.signal, ownEpoch) : await (await post('chat', { model: $('model').value, text: content, version: revision }, controller.signal)).json();
      if (ownEpoch !== epoch || !authorized) return;
      renderConversation(data.conversation); $('prompt').value = ''; $('status').textContent = '';
      if (!preferencesFailed) await refreshPreferences();
      if (ownEpoch === epoch && autoSpeak && nativeVisible && !preferencesBusy && !preferencesFailed) {
        const reply = data.conversation.messages.at(-1);
        if (reply?.role === 'assistant') speakContent(reply.content);
      }
    } catch (error) { if (ownEpoch === epoch) $('status').textContent = error.name === 'AbortError' ? 'Anropet avbröts.' : error.message; }
    finally { busy = false; controller = null; if ($('status').textContent === 'Avbryter svaret…') $('status').textContent = 'Svaret avbröts. Kontrollera filhistoriken om du arbetade med filer.'; update(); if (workspaceReady && authorized && !$('sir-david-panel').hidden) fileActivity().catch(() => {}); }
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
  window.addEventListener('pagehide', () => { epoch++; controller?.abort(); pairController?.abort(); localAdapter?.disconnect(); cancelSpeech(); history = []; });
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
      await planner?.init().catch(error => { if (authorized) $('planner-status').textContent = error.message; });
    } catch (error) { $('connection').textContent = error.message; }
    finally { initializing = false; }
    update();
  }
  if (new URL(window.location.href).searchParams.get('panel') === 'sir-david') setPanel(true, false);
  const pollPreferences = () => { if (initialized && authorized && !preferencesBusy && !preferencesFailed && !$('sir-david-panel').hidden && (speechBusy || document.visibilityState !== 'hidden')) refreshPreferences().catch(() => { preferencesFailed = true; autoSpeak = false; cancelSpeech(); update(); }); };
  const preferenceTimer = setInterval(pollPreferences, 5000);
  document.addEventListener('visibilitychange', pollPreferences);
  window.addEventListener('pagehide', () => clearInterval(preferenceTimer));
})();
