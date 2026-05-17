(() => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: '/' }).catch(() => {});
  }

  const socket = io();

  const el = (id) => document.getElementById(id);
  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  const $pairing = el('pairing-screen');
  const $chat = el('chat-screen');
  const $codeSpans = $$('.code-digits .cd');
  const $copyBtn = el('copy-btn');
  const $statusDot = el('status-dot');
  const $statusText = el('status-text');
  const $pairInputs = $$('.pair-digits .pd');
  const $pairError = el('pair-error');
  const $pairBtn = el('pair-btn');
  const $peerName = el('peer-name');
  const $peerStatus = el('peer-status');
  const $messages = el('messages');
  const $scrollBottom = el('scroll-bottom');
  const $typing = el('typing-indicator');
  const $chatInput = el('chat-input');
  const $sendBtn = el('send-btn');
  const $leaveBtn = el('leave-btn');
  const $fileInput = el('file-input');
  const $filePreview = el('file-preview');
  const $fileName = el('file-name');
  const $fileSize = el('file-size');
  const $cancelFile = el('cancel-file-btn');
  const $toast = el('toast');

  let myCode = null;
  let peerCode = null;
  let selectedFile = null;
  let paired = false;
  let typingTimer = null;
  let toastTimer = null;
  let msgCount = 0;

  // ── Canvas background ──
  const canvas = el('bg-canvas');
  const ctx = canvas.getContext('2d');
  let particles = [];

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * canvas.width;
      this.y = Math.random() * canvas.height;
      this.size = Math.random() * 1.8 + 0.5;
      this.speedX = (Math.random() - 0.5) * 0.2;
      this.speedY = (Math.random() - 0.5) * 0.2;
      this.opacity = Math.random() * 0.5 + 0.1;
    }
    update() {
      this.x += this.speedX;
      this.y += this.speedY;
      if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
      if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
    }
    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(91, 91, 240, ${this.opacity})`;
      ctx.fill();
    }
  }

  for (let i = 0; i < 60; i++) particles.push(new Particle());

  let animId;
  function animateBg() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of particles) { p.update(); p.draw(); }
    for (let i = 0; i < particles.length; i++) {
      for (let j = i + 1; j < particles.length; j++) {
        const dx = particles[i].x - particles[j].x;
        const dy = particles[i].y - particles[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 120) {
          ctx.beginPath();
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.strokeStyle = `rgba(91, 91, 240, ${0.06 * (1 - dist / 120)})`;
          ctx.stroke();
        }
      }
    }
    animId = requestAnimationFrame(animateBg);
  }
  animateBg();

  // ── Helpers ──
  function showToast(msg, duration = 2500) {
    $toast.textContent = msg;
    $toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $toast.classList.add('hidden'), duration);
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  function setCodeDigits(code) {
    const digits = code.padStart(4, '0').split('');
    $codeSpans.forEach((el, i) => { el.textContent = digits[i]; });
  }

  function scrolledToBottom() {
    const threshold = 60;
    return $messages.scrollTop >= $messages.scrollHeight - $messages.clientHeight - threshold;
  }

  function scrollToBottom(force) {
    if (force || !scrolledToBottom()) {
      $messages.scrollTop = $messages.scrollHeight;
      $scrollBottom.classList.add('hidden');
    } else {
      $scrollBottom.classList.remove('hidden');
    }
  }

  $messages.addEventListener('scroll', () => {
    if (scrolledToBottom()) $scrollBottom.classList.add('hidden');
    else $scrollBottom.classList.remove('hidden');
  });

  $scrollBottom.addEventListener('click', () => scrollToBottom(true));

  // ── Connection status ──
  function setConnStatus(state) {
    $statusDot.className = 'status-dot';
    if (state === 'connected') {
      $statusDot.classList.add('connected');
      $statusText.textContent = 'Connected';
    } else if (state === 'connecting') {
      $statusDot.classList.add('connecting');
      $statusText.textContent = 'Connecting...';
    } else {
      $statusDot.classList.add('disconnected');
      $statusText.textContent = 'Disconnected';
    }
  }

  socket.on('connect', () => setConnStatus('connected'));
  socket.on('disconnect', () => {
    setConnStatus('disconnected');
    if (paired) {
      addSystemMsg('Connection lost — reconnecting...');
    }
  });
  socket.on('reconnect_attempt', () => setConnStatus('connecting'));
  setConnStatus('connecting');

  // ── Pairing ──
  function focusNextPairInput(idx) {
    const next = $pairInputs[idx + 1];
    if (next) { next.focus(); next.select(); }
  }

  function focusPrevPairInput(idx) {
    const prev = $pairInputs[idx - 1];
    if (prev) { prev.focus(); prev.select(); }
  }

  function getPairCode() {
    return $pairInputs.map(i => i.value).join('');
  }

  function isPairCodeComplete() {
    return $pairInputs.every(i => i.value.length === 1);
  }

  function updatePairBtn() {
    $pairBtn.disabled = !isPairCodeComplete();
  }

  function resetPairInputs() {
    $pairInputs.forEach(i => { i.value = ''; i.classList.remove('filled', 'error'); });
    updatePairBtn();
    $pairInputs[0].focus();
  }

  $pairInputs.forEach((input, idx) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/, '').slice(0, 1);
      input.classList.remove('error');
      input.classList.toggle('filled', input.value.length === 1);
      $pairError.textContent = '';
      updatePairBtn();
      if (input.value.length === 1) focusNextPairInput(idx);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !input.value) {
        focusPrevPairInput(idx);
      }
      if (e.key === 'Enter' && isPairCodeComplete()) {
        $pairBtn.click();
      }
    });

    input.addEventListener('focus', () => input.select());
  });

  $pairBtn.addEventListener('click', () => {
    const code = getPairCode();
    if (code.length !== 4) return;
    $pairBtn.disabled = true;
    $pairBtn.classList.add('loading');
    $pairError.textContent = '';
    socket.emit('pair', code);
  });

  // ── Messages ──
  function addMsg(data, isOwn) {
    const div = document.createElement('div');
    div.className = 'msg' + (isOwn ? ' own' : ' peer');

    if (data.file) {
      const isImage = data.type && data.type.startsWith('image/');
      if (isImage) {
        div.classList.add('msg-image');
        const img = document.createElement('img');
        img.src = 'data:' + data.type + ';base64,' + data.buffer;
        img.alt = data.name;
        img.loading = 'lazy';
        div.appendChild(img);
        div.title = data.name + ' (' + fmtSize(data.size) + ') \u2022 click to download';
        div.addEventListener('click', () => downloadFile(data));
      } else {
        div.classList.add('msg-file');
        div.innerHTML =
          '<div class="file-body">' +
            '<div class="file-icon">\uD83D\uDCCE</div>' +
            '<div class="file-meta">' +
              '<span class="file-name">' + escHtml(data.name) + '</span>' +
              '<span class="file-size">' + fmtSize(data.size) + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="time">' + fmtTime(data.time) + '</span>';
        div.addEventListener('click', () => downloadFile(data));
      }
    } else {
      div.textContent = data.text;
      const time = document.createElement('span');
      time.className = 'time';
      time.textContent = fmtTime(data.time);
      div.appendChild(time);
    }

    $messages.appendChild(div);
    msgCount++;
    scrollToBottom();
  }

  function downloadFile(data) {
    const byteChars = atob(data.buffer);
    const byteNums = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteNums[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteNums], { type: data.type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = data.name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function addSystemMsg(text) {
    const div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    $messages.appendChild(div);
    $messages.scrollTop = $messages.scrollHeight;
  }

  // ── Socket events ──
  socket.on('your-code', (code) => {
    myCode = code;
    setCodeDigits(code);
  });

  socket.on('paired', (data) => {
    peerCode = data.peerCode;
    paired = true;
    $peerName.textContent = 'Code ' + peerCode;
    $peerStatus.textContent = 'Online';
    $peerStatus.className = 'header-status';
    $pairing.classList.add('hidden');
    $chat.classList.remove('hidden');
    addSystemMsg('You are now connected');
    $pairBtn.classList.remove('loading');
    $pairBtn.disabled = true;
    resetPairInputs();
  });

  socket.on('pair-error', (msg) => {
    $pairError.textContent = msg;
    $pairBtn.classList.remove('loading');
    updatePairBtn();
    $pairInputs.forEach(i => i.classList.add('error'));
    setTimeout(() => $pairInputs.forEach(i => i.classList.remove('error')), 600);
  });

  socket.on('message', (data) => addMsg(data, false));
  socket.on('file', (data) => addMsg({ ...data, file: true }, false));

  socket.on('typing', (data) => {
    if (data.isTyping) {
      $typing.classList.remove('hidden');
    } else {
      $typing.classList.add('hidden');
    }
  });

  socket.on('peer-left', () => {
    addSystemMsg('Peer has left the chat');
    paired = false;
    $peerStatus.textContent = 'Offline';
    $peerStatus.classList.add('offline');
  });

  socket.on('left', () => {
    resetChat();
  });

  // ── Send message ──
  function sendMessage() {
    if (selectedFile) {
      $sendBtn.disabled = true;
      const reader = new FileReader();
      reader.onload = (e) => {
        const buffer = e.target.result.split(',')[1];
        socket.emit('file', { name: selectedFile.name, size: selectedFile.size, type: selectedFile.type, buffer });
        addMsg({ name: selectedFile.name, size: selectedFile.size, type: selectedFile.type, buffer, file: true, time: Date.now() }, true);
        clearFile();
        $sendBtn.disabled = false;
        $chatInput.focus();
      };
      reader.readAsDataURL(selectedFile);
      return;
    }

    const text = $chatInput.value.trim();
    if (!text) return;
    socket.emit('message', { text });
    addMsg({ text, time: Date.now() }, true);
    $chatInput.value = '';
    $sendBtn.disabled = true;
    $chatInput.focus();
    socket.emit('typing', false);
  }

  $sendBtn.addEventListener('click', sendMessage);

  $chatInput.addEventListener('input', () => {
    $sendBtn.disabled = !$chatInput.value.trim() && !selectedFile;
    socket.emit('typing', $chatInput.value.trim().length > 0);
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', false), 1200);
  });

  $chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── File handling ──
  $fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      showToast('File exceeds 50 MB limit');
      $fileInput.value = '';
      return;
    }
    selectedFile = file;
    $fileName.textContent = file.name;
    $fileSize.textContent = fmtSize(file.size);
    $filePreview.classList.remove('hidden');
    $sendBtn.disabled = false;
    $chatInput.focus();
  });

  function clearFile() {
    selectedFile = null;
    $fileInput.value = '';
    $filePreview.classList.add('hidden');
    $fileName.textContent = '';
    $fileSize.textContent = '';
  }

  $cancelFile.addEventListener('click', clearFile);

  // ── Leave ──
  function resetChat() {
    $messages.innerHTML = '';
    $typing.classList.add('hidden');
    paired = false;
    peerCode = null;
    msgCount = 0;
    $chatInput.value = '';
    $sendBtn.disabled = true;
    clearFile();
    $chat.classList.add('hidden');
    $pairing.classList.remove('hidden');
    resetPairInputs();
  }

  $leaveBtn.addEventListener('click', () => {
    if (paired) socket.emit('leave');
    else resetChat();
  });

  // ── Mobile keyboard handling ──
  if ('visualViewport' in window) {
    let prevHeight = window.visualViewport.height;

    window.visualViewport.addEventListener('resize', () => {
      const diff = prevHeight - window.visualViewport.height;
      if (diff > 100) {
        const focused = document.activeElement;
        if (focused === $chatInput || $pairInputs.includes(focused)) {
          setTimeout(() => focused.scrollIntoView({ block: 'center' }), 150);
        }
        if (paired) {
          $messages.scrollTop = $messages.scrollHeight;
        }
      }
      prevHeight = window.visualViewport.height;
    });
  }

  document.addEventListener('gesturestart', (e) => e.preventDefault());
})();
