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
      roomList.innerHTML = '<div class="room-list-empty">Keine Räume offen – erstelle einen!</div>';
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
    const name = createUsername.value.trim() || 'Nutzer';
    const rName = roomNameInput.value.trim() || 'Mein Raum';
    clearLobbyError();
    await requestMic();
    send({ type: 'create_room', username: name, name: rName });
    myUsername = name;
  });

  joinBtn.addEventListener('click', async () => {
    const name = joinUsername.value.trim() || 'Nutzer';
    const code = roomIdInput.value.trim().toUpperCase();
    if (!code) { showLobbyError('Bitte Raum-Code eingeben.'); return; }
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
      showLobbyError('Mikrofon-Zugriff verweigert: ' + err.message);
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
        opt.textContent = d.label || `Gerät ${i + 1}`;
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
      showToast('❌ Mikrofon konnte nicht gewechselt werden: ' + err.message);
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
    showToast('🎤 Mikrofon gewechselt');
  }

  async function switchOutput(deviceId) {
    selectedOutId = deviceId;
    for (const [, peer] of peers) {
      if (peer.audioEl && typeof peer.audioEl.setSinkId === 'function') {
        try { await peer.audioEl.setSinkId(deviceId); }
        catch (e) { console.warn('[switchOut]', e); }
      }
    }
    showToast('🔊 Ausgabe gewechselt');
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
    chatMessages.innerHTML = '<div class="chat-msg-empty">Noch keine Nachrichten.</div>';

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
    showToast(`${msg.username} ist beigetreten`);
    // They will send offer to us
  }

  // ── Participant left ───────────────────────────
  function onParticipantLeft(id) {
    const p = participants.get(id);
    if (p) showToast(`${p.username} hat den Raum verlassen`);
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
      navigator.clipboard.writeText(currentRoomId).then(() => showToast('Raum-Code kopiert!'));
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
      <span class="participant-name${isMe ? ' me' : ''}">${escHtml(username)}</span>
      <span class="muted-icon" title="Stummgeschaltet">🔇</span>`;
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
        statusEl.textContent = muted ? '🔇 Stummgeschaltet' : '🎤 Bereit';
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
        statusEl.textContent = isMutedCard ? '🔇 Stummgeschaltet' : (speaking ? '🗣️ Spricht' : '🎤 Bereit');
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
      <div class="voice-name">${escHtml(username)}${isMe ? ' (Du)' : ''}</div>
      <div class="wave-bars hidden">
        <div class="wave-bar"></div><div class="wave-bar"></div>
        <div class="wave-bar"></div><div class="wave-bar"></div>
        <div class="wave-bar"></div>
      </div>
      <div class="voice-status">${muted ? '🔇 Stummgeschaltet' : '🎤 Bereit'}</div>`;
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
