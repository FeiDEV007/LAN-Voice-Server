/* ==============================================
   LAN Voice – app.js
   WebRTC Client + WebSocket Signaling
   ============================================== */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────
  let ws = null;
  let myId = null;
  let myUsername = '';
  let currentRoomId = null;
  let localStream = null;
  let isMuted = false;
  let masterVolume = 1.0;
  let unreadChat = 0;
  let chatOpen = false;
  let settingsOpen = false;

  let selectedMicId  = null;  // deviceId des aktiven Mikrofons
  let selectedOutId  = null;  // deviceId des aktiven Lautsprechers

  // Map<peerId, { pc: RTCPeerConnection, audioEl: HTMLAudioElement }>
  const peers = new Map();
  // Map<peerId, { username, muted }>
  const participants = new Map();

  // Audio analyser for speaking detection
  let audioCtx = null;
  let analyser = null;
  let speakingInterval = null;
  let micLevelInterval = null;  // Für den Pegel-Balken im Settings-Panel

  // STUN config (LAN – meist nicht nötig, aber als Fallback)
  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' }
    ]
  };

  // ── DOM refs ───────────────────────────────────
  const $ = id => document.getElementById(id);

  const lobbyScreen        = $('lobby-screen');
  const roomScreen         = $('room-screen');
  const createBtn          = $('create-btn');
  const joinBtn            = $('join-btn');
  const createUsername     = $('create-username');
  const roomNameInput      = $('room-name');
  const joinUsername       = $('join-username');
  const roomIdInput        = $('room-id-input');
  const roomList           = $('room-list');
  const roomCount          = $('room-count');
  const lobbyError         = $('lobby-error');
  const displayRoomName    = $('display-room-name');
  const displayRoomCode    = $('display-room-code');
  const copyCodeBtn        = $('copy-code-btn');
  const participantsList   = $('participants-list');
  const voiceGrid          = $('voice-grid');
  const muteBtn            = $('mute-btn');
  const iconUnmuted        = muteBtn.querySelector('.icon-unmuted');
  const iconMuted          = muteBtn.querySelector('.icon-muted');
  const leaveBtn           = $('leave-btn');
  const volumeSlider       = $('volume-slider');
  const chatToggleBtn      = $('chat-toggle-btn');
  const chatPanel          = $('chat-panel');
  const chatCloseBtn       = $('chat-close-btn');
  const chatMessages       = $('chat-messages');
  const chatInput          = $('chat-input');
  const chatSendBtn        = $('chat-send-btn');
  const chatBadge          = $('chat-badge');
  const connectingOverlay  = $('connecting-overlay');
  // Audio device UI
  const audioSettingsLobby = $('audio-settings-lobby');
  const micSelectLobby     = $('mic-select-lobby');
  const outSelectLobby     = $('out-select-lobby');
  const settingsToggleBtn  = $('settings-toggle-btn');
  const settingsPanel      = $('settings-panel');
  const settingsCloseBtn   = $('settings-close-btn');
  const micSelectRoom      = $('mic-select-room');
  const outSelectRoom      = $('out-select-room');
  const micLevelFill       = $('mic-level-fill');

  // ── i18n ───────────────────────────────────────
  const translations = {
    de: {
      subtitle: "Lokales Sprach-Chat · Kein Internet nötig",
      lan_banner_label: "Andere Geräte im LAN öffnen:",
      copy_btn: "Kopieren",
      copy_title: "Kopieren",
      create_room_title: "Raum erstellen",
      your_name: "Dein Name",
      name_placeholder: "z.B. Tom",
      room_name_label: "Raumname",
      room_placeholder: "z.B. Gaming Lounge",
      create_room_btn: "Raum erstellen",
      join_room_title: "Raum beitreten",
      name_placeholder2: "z.B. Lisa",
      room_code_label: "Raum-Code",
      code_placeholder: "z.B. A1B2C3",
      join_room_btn: "Beitreten",
      open_rooms: "Offene Räume",
      no_rooms: "Keine Räume offen – erstelle einen!",
      audio_settings: "Audio-Einstellungen",
      mic_label: "🎤 Mikrofon",
      out_label: "🔊 Ausgabe",
      code_label: "Code:",
      copy_code_title: "Code kopieren",
      participants: "Teilnehmer",
      leave_btn: "Verlassen",
      mute_title: "Mikrofon stummschalten",
      chat_toggle_title: "Chat ein-/ausblenden",
      out_label2: "🔊 Audio-Ausgabe",
      device_hint: "* Nicht in allen Browsern unterstützt",
      mic_level: "Mic-Pegel",
      chat: "Chat",
      chat_placeholder: "Nachricht…",
      send_btn: "Senden",
      connecting: "Verbinde…",
      
      err_enter_code: "Bitte Raum-Code eingeben.",
      err_mic_denied: "Mikrofon-Zugriff verweigert: ",
      err_mic_switch: "❌ Mikrofon konnte nicht gewechselt werden: ",
      mic_switched: "🎤 Mikrofon gewechselt",
      out_switched: "🔊 Ausgabe gewechselt",
      joined: "ist beigetreten",
      left: "hat den Raum verlassen",
      code_copied: "Raum-Code kopiert!",
      url_copied: "📋 URL kopiert!",
      all_urls_copied: "📋 Alle URLs kopiert!",
      muted_status: "🔇 Stummgeschaltet",
      ready_status: "🎤 Bereit",
      speaking_status: "🗣️ Spricht",
      me: " (Du)",
      default_name: "Nutzer",
      default_room: "Mein Raum",
      no_messages: "Noch keine Nachrichten.",
      default_device: "Gerät"
    },
    en: {
      subtitle: "Local Voice Chat · No internet required",
      lan_banner_label: "Open on other LAN devices:",
      copy_btn: "Copy",
      copy_title: "Copy",
      create_room_title: "Create Room",
      your_name: "Your Name",
      name_placeholder: "e.g. Tom",
      room_name_label: "Room Name",
      room_placeholder: "e.g. Gaming Lounge",
      create_room_btn: "Create Room",
      join_room_title: "Join Room",
      name_placeholder2: "e.g. Lisa",
      room_code_label: "Room Code",
      code_placeholder: "e.g. A1B2C3",
      join_room_btn: "Join",
      open_rooms: "Open Rooms",
      no_rooms: "No rooms open – create one!",
      audio_settings: "Audio Settings",
      mic_label: "🎤 Microphone",
      out_label: "🔊 Output",
      code_label: "Code:",
      copy_code_title: "Copy code",
      participants: "Participants",
      leave_btn: "Leave",
      mute_title: "Mute microphone",
      chat_toggle_title: "Toggle chat",
      out_label2: "🔊 Audio Output",
      device_hint: "* Not supported in all browsers",
      mic_level: "Mic Level",
      chat: "Chat",
      chat_placeholder: "Message…",
      send_btn: "Send",
      connecting: "Connecting…",
      
      err_enter_code: "Please enter a room code.",
      err_mic_denied: "Microphone access denied: ",
      err_mic_switch: "❌ Could not switch microphone: ",
      mic_switched: "🎤 Microphone switched",
      out_switched: "🔊 Output switched",
      joined: "joined the room",
      left: "left the room",
      code_copied: "Room code copied!",
      url_copied: "📋 URL copied!",
      all_urls_copied: "📋 All URLs copied!",
      muted_status: "🔇 Muted",
      ready_status: "🎤 Ready",
      speaking_status: "🗣️ Speaking",
      me: " (You)",
      default_name: "User",
      default_room: "My Room",
      no_messages: "No messages yet.",
      default_device: "Device"
    }
  };

  let currentLang = localStorage.getItem('lanvoice_lang') || 'de';

  function i18n(key) {
    return translations[currentLang][key] || key;
  }

  function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = i18n(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = i18n(el.getAttribute('data-i18n-placeholder'));
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = i18n(el.getAttribute('data-i18n-title'));
    });
    
    document.body.classList.toggle('lang-en', currentLang === 'en');
    
    const btnDe = $('lang-de');
    const btnEn = $('lang-en');
    if (btnDe) btnDe.classList.toggle('active', currentLang === 'de');
    if (btnEn) btnEn.classList.toggle('active', currentLang === 'en');
    
    if (roomList && (roomList.children.length === 0 || roomList.querySelector('.room-list-empty'))) {
      roomList.innerHTML = `<div class="room-list-empty" data-i18n="no_rooms">${i18n('no_rooms')}</div>`;
    }
    if (chatMessages && chatMessages.querySelector('.chat-msg-empty')) {
      chatMessages.innerHTML = `<div class="chat-msg-empty">${i18n('no_messages')}</div>`;
    }
    
    for (const [id, p] of participants) {
      updateMutedUI(id, p.muted);
      const isSpeaking = document.getElementById('participant-' + id)?.classList.contains('speaking');
      updateSpeaking(id, isSpeaking);
      const cardEl = document.getElementById('voice-card-' + id);
      if (cardEl && id === myId) {
        const nameDiv = cardEl.querySelector('.voice-name');
        if (nameDiv) nameDiv.textContent = p.username + i18n('me');
      }
    }
  }

  const langDe = $('lang-de');
  if (langDe) langDe.addEventListener('click', () => { currentLang = 'de'; localStorage.setItem('lanvoice_lang', 'de'); applyLanguage(); });
  const langEn = $('lang-en');
  if (langEn) langEn.addEventListener('click', () => { currentLang = 'en'; localStorage.setItem('lanvoice_lang', 'en'); applyLanguage(); });

  applyLanguage();

  // ── WebSocket connection ───────────────────────
  function connectWS() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}`);

    ws.onopen = () => {
      console.log('[WS] Connected');
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      console.log('[WS] Closed – reconnect in 2s');
      setTimeout(connectWS, 2000);
    };

    ws.onerror = (err) => {
      console.error('[WS] Error', err);
    };
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  // ── Server message handler ─────────────────────
  async function handleServerMessage(msg) {
    switch (msg.type) {

      case 'your_id':
        myId = msg.id;
        break;

      case 'room_list':
        renderRoomList(msg.rooms);
        break;

      case 'joined_room':
        await onJoinedRoom(msg);
        break;

      case 'left_room':
        onLeftRoom(msg.rooms);
        break;

      case 'participant_joined':
        await onParticipantJoined(msg);
        break;

      case 'participant_left':
        onParticipantLeft(msg.id);
        break;

      case 'participant_muted':
        onParticipantMuted(msg.id, msg.muted);
        break;

      case 'offer':
        await handleOffer(msg);
        break;

      case 'answer':
        await handleAnswer(msg);
        break;

      case 'ice_candidate':
        await handleIceCandidate(msg);
        break;

      case 'chat_message':
        addChatMessage(msg.from, msg.username, msg.text, false);
        break;

      case 'error':
        showLobbyError(msg.message);
        break;
    }
  }

  // ── Room list rendering ────────────────────────
  function renderRoomList(rooms) {
    roomCount.textContent = rooms.length;
    if (rooms.length === 0) {
      roomList.innerHTML = `<div class="room-list-empty" data-i18n="no_rooms">${i18n('no_rooms')}</div>`;
      return;
    }
    roomList.innerHTML = '';
    rooms.forEach(room => {
      const item = document.createElement('div');
      item.className = 'room-item';
      item.innerHTML = `
        <span class="room-item-name">${escHtml(room.name)}</span>
        <span class="room-item-meta">
          👤 ${room.participants}
          <span style="color:var(--accent);font-family:monospace;font-weight:700;">${room.id}</span>
        </span>`;
      item.addEventListener('click', () => {
        roomIdInput.value = room.id;
        joinUsername.focus();
      });
      roomList.appendChild(item);
    });
  }

  // ── Lobby actions ──────────────────────────────
  createBtn.addEventListener('click', async () => {
    const name = createUsername.value.trim() || i18n('default_name');
    const rName = roomNameInput.value.trim() || i18n('default_room');
    clearLobbyError();
    await requestMic();
    send({ type: 'create_room', username: name, name: rName });
    myUsername = name;
  });

  joinBtn.addEventListener('click', async () => {
    const name = joinUsername.value.trim() || i18n('default_name');
    const code = roomIdInput.value.trim().toUpperCase();
    if (!code) { showLobbyError(i18n('err_enter_code')); return; }
    clearLobbyError();
    await requestMic();
    send({ type: 'join_room', username: name, roomId: code });
    myUsername = name;
  });

  // Enter key support
  [createUsername, roomNameInput].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') createBtn.click(); });
  });
  [joinUsername, roomIdInput].forEach(el => {
    el.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn.click(); });
  });

  // ── Mic access ────────────────────────────────
  async function requestMic() {
    if (localStream) return;
    showConnecting(true);
    try {
      const constraints = { audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true, video: false };
      localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      showConnecting(false);
      showLobbyError(i18n('err_mic_denied') + err.message);
      throw err;
    }
    // Nach erster Erlaubnis: Geräteliste befüllen
    await populateDevices();
    setupAudioAnalyser();
    showConnecting(false);
  }

  function setupAudioAnalyser() {
    if (!localStream) return;
    if (audioCtx) { try { audioCtx.close(); } catch {} }
    audioCtx = new AudioContext();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    const src = audioCtx.createMediaStreamSource(localStream);
    src.connect(analyser);

    const buf = new Uint8Array(analyser.frequencyBinCount);
    if (speakingInterval) clearInterval(speakingInterval);
    speakingInterval = setInterval(() => {
      if (isMuted) { updateSpeaking(myId, false); return; }
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      updateSpeaking(myId, avg > 12);
    }, 100);
  }

  // ── Audio Device Management ───────────────────
  async function populateDevices() {
    let devices;
    try { devices = await navigator.mediaDevices.enumerateDevices(); }
    catch { return; }

    const inputs  = devices.filter(d => d.kind === 'audioinput');
    const outputs = devices.filter(d => d.kind === 'audiooutput');

    // Falls keine Labels (noch keine Permission) – abbrechen
    if (inputs.length === 0) return;

    const fillSelect = (el, list, selectedId) => {
      el.innerHTML = '';
      list.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `${i18n('default_device')} ${i + 1}`;
        if (d.deviceId === selectedId) opt.selected = true;
        el.appendChild(opt);
      });
    };

    // Lobby Selects
    fillSelect(micSelectLobby, inputs,  selectedMicId);
    fillSelect(outSelectLobby, outputs, selectedOutId);
    // Room Selects
    fillSelect(micSelectRoom, inputs,  selectedMicId);
    fillSelect(outSelectRoom, outputs, selectedOutId);

    // Lobby Audio-Bar einblenden
    audioSettingsLobby.classList.remove('hidden');
  }

  async function switchMicrophone(deviceId) {
    if (deviceId === selectedMicId) return;
    selectedMicId = deviceId;

    // Neuen Stream anfordern
    let newStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } },
        video: false
      });
    } catch (err) {
      showToast(i18n('err_mic_switch') + err.message);
      return;
    }

    // Alten Stream stoppen
    if (localStream) localStream.getTracks().forEach(t => t.stop());
    localStream = newStream;

    // Track in allen aktiven Peer Connections ersetzen
    const newTrack = localStream.getAudioTracks()[0];
    for (const [, peer] of peers) {
      const sender = peer.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (sender) {
        try { await sender.replaceTrack(newTrack); }
        catch (e) { console.warn('[switchMic] replaceTrack failed:', e); }
      }
    }

    // Track-enabled-Status beibehalten
    newTrack.enabled = !isMuted;

    // Analyser neu aufbauen
    setupAudioAnalyser();
    showToast(i18n('mic_switched'));
  }

  async function switchOutput(deviceId) {
    selectedOutId = deviceId;
    for (const [, peer] of peers) {
      if (peer.audioEl && typeof peer.audioEl.setSinkId === 'function') {
        try { await peer.audioEl.setSinkId(deviceId); }
        catch (e) { console.warn('[switchOut]', e); }
      }
    }
    showToast(i18n('out_switched'));
  }

  // Hot-Plug: Geräte-änderung
  navigator.mediaDevices.addEventListener('devicechange', () => populateDevices());

  // Lobby Selects
  micSelectLobby.addEventListener('change', () => { selectedMicId = micSelectLobby.value; });
  outSelectLobby.addEventListener('change', () => { selectedOutId = outSelectLobby.value; });

  // Room Selects
  micSelectRoom.addEventListener('change', () => switchMicrophone(micSelectRoom.value));
  outSelectRoom.addEventListener('change', () => switchOutput(outSelectRoom.value));

  // Settings Toggle
  settingsToggleBtn.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsPanel.classList.toggle('hidden', !settingsOpen);
    if (settingsOpen) startMicLevelMeter();
    else stopMicLevelMeter();
  });
  settingsCloseBtn.addEventListener('click', () => {
    settingsOpen = false;
    settingsPanel.classList.add('hidden');
    stopMicLevelMeter();
  });

  function startMicLevelMeter() {
    if (micLevelInterval) clearInterval(micLevelInterval);
    if (!analyser) return;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    micLevelInterval = setInterval(() => {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
      const pct = Math.min(100, avg * 3);
      micLevelFill.style.width = pct + '%';
    }, 60);
  }

  function stopMicLevelMeter() {
    if (micLevelInterval) { clearInterval(micLevelInterval); micLevelInterval = null; }
    micLevelFill.style.width = '0%';
  }

  // ── Join room ──────────────────────────────────
  async function onJoinedRoom(msg) {
    currentRoomId = msg.roomId;
    displayRoomName.textContent = msg.roomName;
    displayRoomCode.textContent = msg.roomId;

    // Clear UI
    participantsList.innerHTML = '';
    voiceGrid.innerHTML = '';
    participants.clear();
    chatMessages.innerHTML = `<div class="chat-msg-empty">${i18n('no_messages')}</div>`;

    // Geräteliste für Room-Settings-Panel aktualisieren
    await populateDevices();

    // Add all existing participants
    msg.participants.forEach(p => {
      participants.set(p.id, { username: p.username, muted: p.muted });
      addParticipantUI(p.id, p.username, p.muted);
      addVoiceCard(p.id, p.username, p.muted);
    });

    // Show room screen
    lobbyScreen.classList.remove('active');
    roomScreen.style.display = 'flex';

    // Initiate WebRTC connections to all existing participants (except self)
    for (const p of msg.participants) {
      if (p.id !== myId) {
        await createPeerConnection(p.id, true);
      }
    }
  }

  // ── New participant joined ─────────────────────
  async function onParticipantJoined(msg) {
    participants.set(msg.id, { username: msg.username, muted: msg.muted });
    addParticipantUI(msg.id, msg.username, msg.muted);
    addVoiceCard(msg.id, msg.username, msg.muted);
    showToast(`${msg.username} ${i18n('joined')}`);
    // They will send offer to us
  }

  // ── Participant left ───────────────────────────
  function onParticipantLeft(id) {
    const p = participants.get(id);
    if (p) showToast(`${p.username} ${i18n('left')}`);
    participants.delete(id);
    removeParticipantUI(id);
    removeVoiceCard(id);
    closePeer(id);
  }

  // ── Participant muted ──────────────────────────
  function onParticipantMuted(id, muted) {
    const p = participants.get(id);
    if (p) p.muted = muted;
    updateMutedUI(id, muted);
  }

  // ── Left room ─────────────────────────────────
  function onLeftRoom(rooms) {
    currentRoomId = null;

    // Close all peer connections
    for (const [id] of peers) closePeer(id);
    peers.clear();
    participants.clear();

    roomScreen.style.display = 'none';
    lobbyScreen.classList.add('active');

    renderRoomList(rooms || []);
    unreadChat = 0;
    chatBadge.classList.add('hidden');
  }

  // ── Leave button ──────────────────────────────
  leaveBtn.addEventListener('click', () => {
    send({ type: 'leave_room' });
    // Stop mic
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop());
      localStream = null;
    }
    if (speakingInterval)  { clearInterval(speakingInterval);  speakingInterval  = null; }
    if (micLevelInterval)  { clearInterval(micLevelInterval);  micLevelInterval  = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; analyser = null; }
  });

  // ── Copy room code ─────────────────────────────
  copyCodeBtn.addEventListener('click', () => {
    if (currentRoomId) {
      navigator.clipboard.writeText(currentRoomId).then(() => showToast(i18n('code_copied')));
    }
  });

  // ── Mute ──────────────────────────────────────
  muteBtn.addEventListener('click', () => {
    isMuted = !isMuted;
    if (localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = !isMuted);
    }
    muteBtn.classList.toggle('muted', isMuted);
    iconUnmuted.style.display = isMuted ? 'none' : '';
    iconMuted.style.display   = isMuted ? '' : 'none';
    send({ type: 'mute_status', muted: isMuted });
    updateMutedUI(myId, isMuted);
    if (isMuted) updateSpeaking(myId, false);
  });

  // ── Volume ────────────────────────────────────
  volumeSlider.addEventListener('input', () => {
    masterVolume = parseInt(volumeSlider.value) / 100;
    for (const [, peer] of peers) {
      if (peer.audioEl) peer.audioEl.volume = Math.min(masterVolume, 1);
    }
  });

  // ── Chat ──────────────────────────────────────
  chatToggleBtn.addEventListener('click', () => {
    chatOpen = !chatOpen;
    chatPanel.classList.toggle('hidden', !chatOpen);
    if (chatOpen) {
      unreadChat = 0;
      chatBadge.classList.add('hidden');
      chatInput.focus();
    }
  });

  chatCloseBtn.addEventListener('click', () => {
    chatOpen = false;
    chatPanel.classList.add('hidden');
  });

  chatSendBtn.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    send({ type: 'chat_message', text });
    addChatMessage(myId, myUsername, text, true);
    chatInput.value = '';
  }

  function addChatMessage(fromId, username, text, isMine) {
    // Remove empty placeholder
    const empty = chatMessages.querySelector('.chat-msg-empty');
    if (empty) empty.remove();

    const now = new Date();
    const time = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = 'chat-msg' + (isMine ? ' mine' : '');
    div.innerHTML = `
      <div class="chat-msg-header">
        <span class="chat-msg-user">${escHtml(username)}</span>
        <span class="chat-msg-time">${time}</span>
      </div>
      <div class="chat-msg-text">${escHtml(text)}</div>`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (!chatOpen && !isMine) {
      unreadChat++;
      chatBadge.textContent = unreadChat;
      chatBadge.classList.remove('hidden');
    }
  }

  // ── Participant UI ─────────────────────────────
  function addParticipantUI(id, username, muted) {
    const el = document.createElement('div');
    el.className = 'participant-item' + (muted ? ' muted' : '');
    el.id = 'participant-' + id;
    const initial = username.charAt(0).toUpperCase();
    const isMe = id === myId;
    el.innerHTML = `
      <div class="participant-avatar">${initial}</div>
      <span class="participant-name${isMe ? ' me' : ''}">${escHtml(username)}${isMe ? i18n('me') : ''}</span>
      <span class="muted-icon" title="${i18n('muted_status')}">🔇</span>`;
    participantsList.appendChild(el);
  }

  function removeParticipantUI(id) {
    const el = document.getElementById('participant-' + id);
    if (el) el.remove();
  }

  function updateMutedUI(id, muted) {
    const sideEl = document.getElementById('participant-' + id);
    if (sideEl) sideEl.classList.toggle('muted', muted);
    const cardEl = document.getElementById('voice-card-' + id);
    if (cardEl) {
      cardEl.classList.toggle('muted', muted);
      const statusEl = cardEl.querySelector('.voice-status');
      if (statusEl && !cardEl.classList.contains('speaking')) {
        statusEl.textContent = muted ? i18n('muted_status') : i18n('ready_status');
      }
    }
  }

  function updateSpeaking(id, speaking) {
    const sideEl = document.getElementById('participant-' + id);
    if (sideEl) sideEl.classList.toggle('speaking', speaking);
    const cardEl = document.getElementById('voice-card-' + id);
    if (cardEl) {
      cardEl.classList.toggle('speaking', speaking);
      const statusEl = cardEl.querySelector('.voice-status');
      const waveBars = cardEl.querySelector('.wave-bars');
      if (statusEl) {
        const isMutedCard = cardEl.classList.contains('muted');
        statusEl.textContent = isMutedCard ? i18n('muted_status') : (speaking ? i18n('speaking_status') : i18n('ready_status'));
      }
      if (waveBars) waveBars.classList.toggle('hidden', !speaking);
    }
  }

  // ── Voice Grid ────────────────────────────────
  function addVoiceCard(id, username, muted) {
    const card = document.createElement('div');
    card.className = 'voice-card' + (muted ? ' muted' : '');
    card.id = 'voice-card-' + id;
    const initial = username.charAt(0).toUpperCase();
    const isMe = id === myId;
    card.innerHTML = `
      <div class="voice-avatar">${initial}</div>
      <div class="voice-name">${escHtml(username)}${isMe ? i18n('me') : ''}</div>
      <div class="wave-bars hidden">
        <div class="wave-bar"></div><div class="wave-bar"></div>
        <div class="wave-bar"></div><div class="wave-bar"></div>
        <div class="wave-bar"></div>
      </div>
      <div class="voice-status">${muted ? i18n('muted_status') : i18n('ready_status')}</div>`;
    voiceGrid.appendChild(card);
  }

  function removeVoiceCard(id) {
    const el = document.getElementById('voice-card-' + id);
    if (el) el.remove();
  }

  // ── WebRTC ────────────────────────────────────
  async function createPeerConnection(peerId, isInitiator) {
    if (peers.has(peerId)) return peers.get(peerId).pc;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    const audioEl = new Audio();
    audioEl.autoplay = true;
    audioEl.volume = Math.min(masterVolume, 1);
    peers.set(peerId, { pc, audioEl });

    // Add local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Remote track → play audio
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      audioEl.srcObject = remoteStream;

      // Remote speaking detection
      try {
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        const src = ctx.createMediaStreamSource(remoteStream);
        src.connect(an);
        const buf = new Uint8Array(an.frequencyBinCount);
        setInterval(() => {
          an.getByteFrequencyData(buf);
          const avg = buf.reduce((a, b) => a + b, 0) / buf.length;
          updateSpeaking(peerId, avg > 10);
        }, 100);
      } catch {}
    };

    // ICE candidates
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        send({ type: 'ice_candidate', to: peerId, candidate: e.candidate });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] ${peerId} → ${pc.connectionState}`);
    };

    if (isInitiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'offer', to: peerId, sdp: pc.localDescription });
    }

    return pc;
  }

  async function handleOffer(msg) {
    const pc = await createPeerConnection(msg.from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'answer', to: msg.from, sdp: pc.localDescription });
  }

  async function handleAnswer(msg) {
    const peer = peers.get(msg.from);
    if (peer) {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    }
  }

  async function handleIceCandidate(msg) {
    const peer = peers.get(msg.from);
    if (peer && msg.candidate) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
      } catch (e) {
        console.warn('[ICE]', e);
      }
    }
  }

  function closePeer(id) {
    const peer = peers.get(id);
    if (peer) {
      peer.pc.close();
      if (peer.audioEl) {
        peer.audioEl.srcObject = null;
      }
      peers.delete(id);
    }
  }

  // ── Helpers ───────────────────────────────────
  function showConnecting(visible) {
    connectingOverlay.classList.toggle('hidden', !visible);
  }

  function showLobbyError(msg) {
    lobbyError.textContent = msg;
    lobbyError.classList.remove('hidden');
  }

  function clearLobbyError() {
    lobbyError.classList.add('hidden');
    lobbyError.textContent = '';
  }

  let toastTimer = null;
  function showToast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 2800);
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── LAN IP Banner ─────────────────────────────
  async function fetchLanInfo() {
    try {
      const res  = await fetch('/api/info');
      const data = await res.json();
      const banner  = $('lan-banner');
      const urlsDiv = $('lan-urls');
      const copyBtn = $('copy-lan-btn');

      if (!data.ips || data.ips.length === 0) return;

      const urls = data.ips.map(ip => `https://${ip}:${data.port}`);

      urlsDiv.innerHTML = '';
      urls.forEach(url => {
        const chip = document.createElement('span');
        chip.className = 'lan-url-chip';
        chip.textContent = url;
        chip.title = 'Klicken zum Kopieren';
        chip.addEventListener('click', () => {
          navigator.clipboard.writeText(url).then(() => showToast('📋 URL kopiert!'));
        });
        urlsDiv.appendChild(chip);
      });

      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(urls.join('\n')).then(() => showToast('📋 Alle URLs kopiert!'));
      });

      banner.classList.remove('hidden');
    } catch { /* kein Banner wenn API nicht erreichbar */ }
  }

  // ── Init ──────────────────────────────────────
  connectWS();
  fetchLanInfo();

})();
