const state = {
  offline: false,
  queue: JSON.parse(localStorage.getItem("fieldvoice.queue") || "[]"),
  recognition: null,
  mediaRecorder: null,
  mediaStream: null,
  audioChunks: [],
  backendSpeech: null,
  audioPlayer: null,
  listening: false,
  lockedRecording: false,
  speaking: false,
  recordingTranscript: "",
  pressStartedAt: 0,
};

const els = {
  socketStatus: document.querySelector("#socketStatus"),
  voiceText: document.querySelector("#voiceText"),
  confirmation: document.querySelector("#confirmation"),
  activityFeed: document.querySelector("#activityFeed"),
  queueCount: document.querySelector("#queueCount"),
  workOrders: document.querySelector("#workOrders"),
  totalWorkOrders: document.querySelector("#totalWorkOrders"),
  openWorkOrders: document.querySelector("#openWorkOrders"),
  escalatedWorkOrders: document.querySelector("#escalatedWorkOrders"),
  highSeverity: document.querySelector("#highSeverity"),
  speechStatus: document.querySelector("#speechStatus"),
  aiStatus: document.querySelector("#aiStatus"),
};

els.workOrders.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-close-order]");
  if (!button) {
    return;
  }
  await closeWorkOrder(button.dataset.closeOrder);
});

document
  .querySelector("#sendInspection")
  .addEventListener("click", () => submitVoice("create_work_order"));
document
  .querySelector("#askQuestion")
  .addEventListener("click", () => submitVoice("query"));
document
  .querySelector("#escalate")
  .addEventListener("click", () =>
    submitVoice("escalate", "Escalate this fault to supervisor."),
  );
document
  .querySelector("#syncQueue")
  .addEventListener("click", handleNetworkSync);
document.querySelector("#refresh").addEventListener("click", refreshAll);

bindPushToTalk();
connectEvents();
initializeVoiceStack();
initializeAIStatus();
refreshAll();
updateQueueCount();
updateNetworkControls();

async function submitVoice(commandMode, overrideTranscript) {
  const payload = {
    client_uuid: crypto.randomUUID(),
    worker_id: "field-tech-01",
    transcript: overrideTranscript || els.voiceText.value.trim(),
    command_mode: commandMode,
  };

  if (state.offline) {
    state.queue.push(payload);
    persistQueue();
    noteActivity("QUEUED_OFFLINE", `Queued ${commandMode} while offline`);
    els.confirmation.textContent =
      "Offline mode: command queued and ready to sync.";
    return;
  }

  const response = await postJson("/api/ingest", payload);
  els.confirmation.textContent = response.spoken_confirmation;
  speak(response.spoken_confirmation);
  noteActivity(response.intent.toUpperCase(), response.spoken_confirmation);
  await refreshAll();
}

async function syncQueue() {
  if (!state.queue.length) {
    els.confirmation.textContent = "Offline queue is empty.";
    return;
  }
  if (state.offline) {
    els.confirmation.textContent = "Still offline. Reconnect before syncing.";
    return;
  }
  const response = await postJson("/api/sync", { items: state.queue });
  state.queue = [];
  persistQueue();
  els.confirmation.textContent = `Synced ${response.processed} queued command(s), ${response.duplicates} duplicate(s).`;
  speak(els.confirmation.textContent);
  noteActivity("SYNC_COMPLETED", els.confirmation.textContent);
  await refreshAll();
}

async function handleNetworkSync() {
  if (state.offline) {
    state.offline = false;
    updateNetworkControls();
    if (state.queue.length) {
      els.confirmation.textContent = "Back online. Syncing queued commands...";
      await syncQueue();
    } else {
      els.confirmation.textContent = "Back online. Offline queue is empty.";
    }
    return;
  }
  if (state.queue.length) {
    await syncQueue();
    return;
  }
  state.offline = true;
  updateNetworkControls();
  els.confirmation.textContent =
    "Offline mode enabled. New commands will be queued.";
}

async function initializeVoiceStack() {
  try {
    const response = await fetch("/api/speech/status");
    state.backendSpeech = await response.json();
  } catch {
    state.backendSpeech = null;
  }
  setupBrowserVoiceCapture();
  updateSpeechStatus();
}

async function initializeAIStatus() {
  try {
    const response = await fetch("/api/ai/status");
    const status = await response.json();
    els.aiStatus.textContent = status.available
      ? `OpenAI ${status.model}`
      : "OpenAI fallback";
  } catch {
    els.aiStatus.textContent = "OpenAI fallback";
  }
}

function updateSpeechStatus() {
  const stt = state.backendSpeech?.stt;
  const tts = state.backendSpeech?.tts;
  const sttLabel = stt?.available ? "Whisper STT" : "Browser STT";
  const ttsLabel = tts?.available ? "Server TTS" : "Browser TTS";
  els.speechStatus.textContent = `${sttLabel} / ${ttsLabel}`;
}

function setupBrowserVoiceCapture() {
  const Recognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  const button = document.querySelector("#voiceCapture");
  if (!Recognition && !canRecordForBackend()) {
    button.disabled = true;
    button.setAttribute("aria-label", "Voice unavailable");
    button.dataset.tooltip = "Voice capture is unavailable in this browser";
    return;
  }
  if (!Recognition) {
    return;
  }

  const recognition = new Recognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = "en-IN";
  recognition.onresult = (event) => {
    const transcriptParts = [];
    for (let index = 0; index < event.results.length; index += 1) {
      transcriptParts.push(event.results[index][0].transcript.trim());
    }
    state.recordingTranscript = cleanTranscript(transcriptParts.join(" "));
    els.voiceText.value = state.recordingTranscript;
  };
  recognition.onend = () => {
    state.listening = false;
    state.lockedRecording = false;
    setVoiceButtonIdle();
  };
  recognition.onerror = () => {
    state.listening = false;
    state.lockedRecording = false;
    setVoiceButtonIdle();
    els.confirmation.textContent =
      "Voice capture stopped. You can still type or paste the transcript.";
  };
  state.recognition = recognition;
}

function bindPushToTalk() {
  const button = document.querySelector("#voiceCapture");
  button.addEventListener("contextmenu", (event) => event.preventDefault());
  button.addEventListener("pointerdown", startPushToTalk);
  button.addEventListener("pointerup", stopPushToTalk);
  button.addEventListener("pointercancel", stopPushToTalk);
  button.addEventListener("pointerleave", (event) => {
    if (state.listening && event.buttons === 1) {
      stopPushToTalk(event);
    }
  });
  button.addEventListener("keydown", (event) => {
    if (
      (event.code === "Space" || event.code === "Enter") &&
      !state.listening
    ) {
      startPushToTalk(event);
    }
  });
  button.addEventListener("keyup", (event) => {
    if (event.code === "Space" || event.code === "Enter") {
      stopPushToTalk(event);
    }
  });
}

function startPushToTalk(event) {
  event.preventDefault();
  if (state.listening) {
    stopRecording();
    return;
  }
  state.lockedRecording = false;
  state.pressStartedAt = Date.now();
  startCapture();
}

function stopPushToTalk(event) {
  event.preventDefault();
  const pressDuration = Date.now() - state.pressStartedAt;
  if (state.listening && pressDuration < 240) {
    state.lockedRecording = true;
    els.confirmation.textContent =
      "Recording locked on. Tap the mic again when done.";
    updateStopControl();
    return;
  }
  if (state.lockedRecording) {
    return;
  }
  stopRecording();
}

function toggleLockedRecording() {
  if (state.listening) {
    stopRecording();
    return;
  }
  state.lockedRecording = true;
  startCapture();
}

function startCapture() {
  stopSpeech();
  els.voiceText.value = "";
  state.recordingTranscript = "";

  if (state.backendSpeech?.stt?.available && canRecordForBackend()) {
    startBackendRecording();
  } else {
    startBrowserRecording();
  }
}

function startBrowserRecording() {
  if (!state.recognition) {
    els.confirmation.textContent =
      "Voice capture is unavailable in this browser.";
    return;
  }
  const button = document.querySelector("#voiceCapture");
  try {
    state.recognition.start();
    state.listening = true;
    button.classList.add("is-recording");
    updateVoiceControlState();
    els.confirmation.textContent =
      "Listening with browser STT. Release when done.";
  } catch {
    els.confirmation.textContent =
      "Voice capture is already starting. Try again in a moment.";
  }
}

async function startBackendRecording() {
  const button = document.querySelector("#voiceCapture");
  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    state.audioChunks = [];
    state.mediaRecorder = new MediaRecorder(
      state.mediaStream,
      mediaRecorderOptions(),
    );
    state.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        state.audioChunks.push(event.data);
      }
    };
    state.mediaRecorder.onstop = transcribeRecordedAudio;
    state.mediaRecorder.start();
    state.listening = true;
    button.classList.add("is-recording");
    updateVoiceControlState();
    els.confirmation.textContent =
      "Recording for backend STT. Release when done.";
  } catch {
    startBrowserRecording();
  }
}

function mediaRecorderOptions() {
  const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  const mimeType = preferred.find((type) =>
    MediaRecorder.isTypeSupported(type),
  );
  return mimeType ? { mimeType } : {};
}

function canRecordForBackend() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

async function transcribeRecordedAudio() {
  stopMediaTracks();
  const blob = new Blob(state.audioChunks, {
    type: state.mediaRecorder?.mimeType || "audio/webm",
  });
  state.audioChunks = [];
  if (!blob.size) {
    els.confirmation.textContent =
      "No audio captured. Hold the button while speaking.";
    return;
  }
  els.confirmation.textContent = "Transcribing field audio...";
  const formData = new FormData();
  formData.append("audio", blob, "fieldvoice-capture.webm");
  try {
    const response = await fetch("/api/speech/transcribe", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();
    if (result.available && result.transcript) {
      els.voiceText.value = cleanTranscript(result.transcript);
      els.confirmation.textContent = `Transcript ready via ${result.engine}.`;
    } else {
      els.confirmation.textContent =
        result.message ||
        "Backend STT unavailable. Use browser voice or type the transcript.";
    }
  } catch {
    els.confirmation.textContent =
      "Backend transcription failed. Use browser voice or type the transcript.";
  }
}

function speak(text) {
  if (state.backendSpeech?.tts?.available) {
    speakWithBackend(text);
    return;
  }
  speakWithBrowser(text);
}

async function speakWithBackend(text) {
  stopSpeech();
  try {
    const response = await fetch("/api/speech/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !contentType.startsWith("audio/")) {
      speakWithBrowser(text);
      return;
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    state.audioPlayer = audio;
    audio.onplay = () => {
      state.speaking = true;
      updateStopControl();
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      state.speaking = false;
      state.audioPlayer = null;
      updateStopControl();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      state.speaking = false;
      state.audioPlayer = null;
      updateStopControl();
      els.confirmation.textContent =
        "Server audio could not play here, using browser voice instead.";
      speakWithBrowser(text);
    };
    await audio.play();
  } catch {
    els.confirmation.textContent =
      "Audio playback was blocked, using browser voice instead.";
    speakWithBrowser(text);
  }
}

function speakWithBrowser(text) {
  if (!("speechSynthesis" in window)) {
    return;
  }
  window.speechSynthesis.cancel();
  state.speaking = false;
  updateVoiceControlState();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-IN";
  utterance.rate = 0.95;
  utterance.pitch = 1;
  utterance.onstart = () => {
    state.speaking = true;
    updateVoiceControlState();
  };
  utterance.onend = () => {
    state.speaking = false;
    updateVoiceControlState();
  };
  utterance.onerror = () => {
    state.speaking = false;
    updateVoiceControlState();
  };
  window.speechSynthesis.speak(utterance);
}

function stopActiveInteraction() {
  const wasRecording = state.listening;
  const wasSpeaking = state.speaking;
  stopRecording();
  stopSpeech();
  if (wasRecording && wasSpeaking) {
    els.confirmation.textContent = "Recording and voice playback stopped.";
  } else if (wasRecording) {
    els.confirmation.textContent = "Recording stopped.";
  } else if (wasSpeaking) {
    els.confirmation.textContent = "Voice playback stopped.";
  }
}

function stopRecording() {
  if (!state.listening) {
    return;
  }
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
  if (state.recognition) {
    try {
      state.recognition.stop();
    } catch {
      // Browser recognition can throw if it has already ended.
    }
  }
  state.listening = false;
  state.lockedRecording = false;
  setVoiceButtonIdle();
}

function stopSpeech() {
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  if (state.audioPlayer) {
    state.audioPlayer.pause();
    state.audioPlayer.currentTime = 0;
    state.audioPlayer = null;
  }
  state.speaking = false;
  updateVoiceControlState();
}

function setVoiceButtonIdle() {
  const button = document.querySelector("#voiceCapture");
  button.classList.remove("is-recording");
  updateVoiceControlState();
}

function updateStopControl() {
  updateVoiceControlState();
}

function updateVoiceControlState() {
  const button = document.querySelector("#voiceCapture");
  if (state.listening) {
    button.setAttribute("aria-label", "Stop recording");
    button.dataset.tooltip = state.lockedRecording
      ? "Tap to stop recording"
      : "Release to stop recording";
  } else {
    button.setAttribute(
      "aria-label",
      "Hold to talk or press to turn recording on",
    );
    button.dataset.tooltip = "Hold to talk or press to turn recording on";
  }
}

function cleanTranscript(value) {
  return value.replace(/\s+/g, " ").trim();
}

function stopMediaTracks() {
  if (!state.mediaStream) {
    return;
  }
  state.mediaStream.getTracks().forEach((track) => track.stop());
  state.mediaStream = null;
}

function toggleOffline() {
  state.offline = !state.offline;
  updateNetworkControls();
}

async function refreshAll() {
  const [orders, stats] = await Promise.all([
    fetch("/api/work-orders").then((res) => res.json()),
    fetch("/api/dashboard/stats").then((res) => res.json()),
  ]);
  renderOrders(orders);
  renderStats(stats);
}

function renderOrders(orders) {
  els.workOrders.innerHTML = orders
    .map(
      (order) => `
    <article class="work-card">
      <div class="work-card-head">
        <div>
          <strong>${escapeHtml(order.equipment_code)}</strong>
          <p>${escapeHtml(order.location)}</p>
        </div>
        <span class="badge ${order.status}">${order.status}</span>
      </div>
      <div class="work-meta">
        <span><b>Fault</b>${escapeHtml(order.fault_code || "N/A")}</span>
        <span><b>Severity</b><i class="severity-text ${order.severity}">${order.severity}</i></span>
      </div>
      <p class="work-transcript">${escapeHtml(order.transcript).slice(0, 190)}</p>
      <div class="work-card-actions">${renderCloseAction(order)}</div>
    </article>
  `,
    )
    .join("");
}

function renderCloseAction(order) {
  if (order.status === "CLOSED") {
    return '<span class="closed-text">Closed</span>';
  }
  return `<button class="table-action" data-close-order="${escapeHtml(order.id)}">Close</button>`;
}

async function closeWorkOrder(orderId) {
  const response = await fetch(`/api/work-orders/${orderId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "CLOSED" }),
  });
  if (!response.ok) {
    els.confirmation.textContent = "Could not close this work order.";
    return;
  }
  const order = await response.json();
  const message = `Closed work order for ${order.equipment_code}.`;
  els.confirmation.textContent = message;
  speak(message);
  noteActivity("WORK_ORDER_CLOSED", message);
  await refreshAll();
}

function renderStats(stats) {
  els.totalWorkOrders.textContent = stats.total_work_orders;
  els.openWorkOrders.textContent = stats.open_work_orders;
  els.escalatedWorkOrders.textContent = stats.escalated_work_orders;
  els.highSeverity.textContent = stats.critical_or_high;
}

function connectEvents() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${location.host}/api/events`);
  socket.addEventListener("open", () => {
    if (!state.offline) {
      els.socketStatus.textContent = "Live";
      els.socketStatus.classList.remove("offline");
    }
  });
  socket.addEventListener("close", () => {
    els.socketStatus.textContent = "Reconnecting";
    setTimeout(connectEvents, 1200);
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const summary =
      message.payload?.spoken_confirmation ||
      message.payload?.message ||
      message.payload?.equipment_code ||
      "";
    noteActivity(message.type, summary);
    refreshAll();
  });
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || "Request failed");
  }
  return response.json();
}

function noteActivity(type, summary) {
  const item = document.createElement("li");
  item.innerHTML = `<strong>${escapeHtml(type)}</strong><br>${escapeHtml(summary || "Event received")}`;
  els.activityFeed.prepend(item);
  while (els.activityFeed.children.length > 12) {
    els.activityFeed.lastElementChild.remove();
  }
}

function persistQueue() {
  localStorage.setItem("fieldvoice.queue", JSON.stringify(state.queue));
  updateQueueCount();
}

function updateQueueCount() {
  els.queueCount.textContent = `${state.queue.length} queued`;
  updateNetworkControls();
}

function updateNetworkControls() {
  const syncButton = document.querySelector("#syncQueue");
  if (state.offline) {
    syncButton.textContent = state.queue.length
      ? "Go online & sync"
      : "Go online";
    els.socketStatus.textContent = "Offline";
    els.socketStatus.classList.add("offline");
    return;
  }
  syncButton.textContent = state.queue.length
    ? `Sync ${state.queue.length}`
    : "Go offline";
  if (els.socketStatus.textContent !== "Live") {
    els.socketStatus.textContent = "Online";
  }
  els.socketStatus.classList.remove("offline");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
