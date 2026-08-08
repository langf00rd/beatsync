const api = window.beatsync;

const $ = (id) => document.getElementById(id);

const authView = $("auth-view");
const mainView = $("main-view");
const authForm = $("auth-form");
const firstNameInput = $("first-name");
const lastNameInput = $("last-name");
const nameFields = $("name-fields");
const emailInput = $("email");
const passwordInput = $("password");
const authError = $("auth-error");
const authSubmit = $("auth-submit");
const tabs = document.querySelectorAll(".tab");
const userEmail = $("user-email");
const signOutBtn = $("sign-out");
const dirInput = $("dir-input");
const chooseDirBtn = $("choose-dir");
const startSyncBtn = $("start-sync");
const stopSyncBtn = $("stop-sync");
const extensionsInput = $("extensions-input");
const syncState = $("sync-state");
const syncLabel = $("sync-label");
const syncMeta = $("sync-meta");
const logBox = $("log-box");
const refreshFilesBtn = $("refresh-files");
const filesEmpty = $("files-empty");
const filesBody = $("files-body");
const encStatus = $("enc-status");
const encStatusText = $("enc-status-text");
const encKeyInput = $("enc-key-input");
const encGenerateBtn = $("enc-generate");
const encSaveBtn = $("enc-save");
const encClearBtn = $("enc-clear");
const encGenerated = $("enc-generated");
const encGeneratedValue = $("enc-generated-value");
const encCopyBtn = $("enc-copy");

let authMode = "signin";
let watching = false;
let documents = [];

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function showAuth() {
  authView.classList.remove("hidden");
  mainView.classList.add("hidden");
}

function showMain(email) {
  userEmail.textContent = email;
  authView.classList.add("hidden");
  mainView.classList.remove("hidden");
  initEncryption();
  refreshDocuments();
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    tabs.forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    authMode = tab.dataset.tab;
    nameFields.classList.toggle("hidden", authMode !== "signup");
    authError.classList.add("hidden");
    authSubmit.textContent =
      authMode === "signup" ? "create account" : "sign in";
  });
});

authForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  authError.classList.add("hidden");

  const credentials = {
    email: emailInput.value.trim(),
    password: passwordInput.value,
  };

  if (emailInput.validity.typeMismatch) {
    showAuthError("please enter a valid email address.");
    return;
  }

  if (authMode === "signup") {
    const firstName = firstNameInput.value.trim();
    const lastName = lastNameInput.value.trim();
    if (!firstName || !lastName) {
      showAuthError("please enter your first and last name.");
      return;
    }
    if (credentials.password.length < 6) {
      showAuthError("password must be at least 6 characters.");
      return;
    }
    credentials.firstName = firstName;
    credentials.lastName = lastName;
  }

  authSubmit.disabled = true;
  authSubmit.textContent = "please wait…";

  try {
    const result = await withTimeout(
      authMode === "signup" ? api.signUp(credentials) : api.signIn(credentials),
      20000,
      "the request timed out — check your internet connection and try again.",
    );

    if (!result.ok) {
      showAuthError(result.error);
      return;
    }

    showMain(result.session.email);
  } catch (err) {
    showAuthError(err?.message ?? "something went wrong, please try again.");
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent =
      authMode === "signup" ? "create account" : "sign in";
  }
});

function withTimeout(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}

function showAuthError(message) {
  authError.textContent = message;
  authError.classList.remove("hidden");
}

signOutBtn.addEventListener("click", async () => {
  await api.signOut();
  resetToIdle();
  showAuth();
});

// ---------------------------------------------------------------------------
// encryption
// ---------------------------------------------------------------------------

async function initEncryption() {
  const { hasKey, matches } = await api.encryption.getStatus();
  if (!hasKey) {
    setEncStatus("none");
  } else if (matches === false) {
    setEncStatus("mismatch");
  } else {
    setEncStatus("saved");
  }
  encClearBtn.classList.toggle("hidden", !hasKey);
}

function setEncStatus(state) {
  if (state === "saved") {
    encStatus.dataset.state = "ok";
    encStatusText.textContent = "key saved";
  } else if (state === "mismatch") {
    encStatus.dataset.state = "error";
    encStatusText.textContent = "key mismatch — enter your key";
  } else {
    encStatus.dataset.state = "idle";
    encStatusText.textContent = "no key";
  }
}

encGenerateBtn.addEventListener("click", async () => {
  const { key } = await api.encryption.generate();
  encKeyInput.value = key;
  encGeneratedValue.value = key;
  encGenerated.classList.remove("hidden");
});

encCopyBtn.addEventListener("click", async () => {
  const value = encGeneratedValue.value;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  addLog("key copied to clipboard", "synced");
});

encSaveBtn.addEventListener("click", async () => {
  const key = encKeyInput.value.trim();
  if (!key) {
    addLog("paste or generate a key first", "error");
    return;
  }
  const result = await api.encryption.set(key);
  if (!result.ok) {
    addLog(result.error, "error");
    return;
  }
  encKeyInput.value = "";
  encGenerated.classList.add("hidden");
  await initEncryption();
  refreshDocuments();
  addLog("encryption key saved", "synced");
});

encClearBtn.addEventListener("click", async () => {
  if (
    !window.confirm(
      "clear the encryption key? documents already in the cloud stay encrypted and can only be read with this key.",
    )
  ) {
    return;
  }
  await api.encryption.clear();
  encClearBtn.classList.add("hidden");
  setEncStatus("none");
  addLog("encryption key cleared");
});

// ---------------------------------------------------------------------------
// sync controls
// ---------------------------------------------------------------------------

chooseDirBtn.addEventListener("click", async () => {
  const dir = await api.selectDirectory();
  if (dir) dirInput.value = dir;
});

startSyncBtn.addEventListener("click", async () => {
  const dir = dirInput.value.trim();
  if (!dir) {
    setStatus("error", "choose a folder first");
    return;
  }

  const extensions = extensionsInput.value
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  startSyncBtn.disabled = true;
  startSyncBtn.textContent = "starting…";

  const result = await api.startSync({ dir, extensions });

  startSyncBtn.disabled = false;
  startSyncBtn.textContent = "start Watching";

  if (!result.ok) {
    addLog(result.error, "error");
    setStatus("error", result.error);
    return;
  }

  if (result.pulled > 0) {
    addLog(`pulled ${result.pulled} file(s) from the cloud`, "synced");
  }
  refreshDocuments();
});

stopSyncBtn.addEventListener("click", async () => {
  await api.stopSync();
  resetToIdle();
  setStatus("idle", "not watching");
});

refreshFilesBtn.addEventListener("click", refreshDocuments);

// ---------------------------------------------------------------------------
// live events from the main process
// ---------------------------------------------------------------------------

api.onLog(({ message }) => {
  const isError = message.startsWith("error:");
  const isSynced = message.startsWith("synced:");
  addLog(message, isError ? "error" : isSynced ? "synced" : "");
});

api.onWatcherStarted(({ rootDir }) => {
  watching = true;
  setStatus("watching", `watching`);
  dirInput.value = rootDir;
  startSyncBtn.classList.add("hidden");
  stopSyncBtn.classList.remove("hidden");
  addLog(`watching ${rootDir} — changes sync automatically.`);
});

api.onWatcherStopped(() => {
  watching = false;
  resetToIdle();
});

api.onDocUpdated(({ relativePath }) => {
  const existing = documents.find((d) => d.path === relativePath);
  if (existing) {
    existing.updated_at = new Date().toISOString();
    renderFiles();
  } else {
    refreshDocuments();
  }
});

api.onDocDeleted(({ relativePath }) => {
  documents = documents.filter((d) => d.path !== relativePath);
  renderFiles();
});

// ---------------------------------------------------------------------------
// documents
// ---------------------------------------------------------------------------

async function refreshDocuments() {
  const result = await api.listDocuments();
  if (!result.ok) {
    addLog(`failed to load files: ${result.error}`, "error");
    return;
  }
  documents = result.documents ?? [];
  renderFiles();
}

function renderFiles() {
  filesBody.innerHTML = "";
  const sorted = [...documents].sort((a, b) => {
    return new Date(b.updated_at) - new Date(a.updated_at);
  });

  filesEmpty.classList.toggle("hidden", sorted.length > 0);

  for (const doc of sorted) {
    const tr = document.createElement("tr");

    const tdPath = document.createElement("td");
    tdPath.textContent = doc.path;
    tr.appendChild(tdPath);

    const tdTime = document.createElement("td");
    tdTime.textContent = formatTime(doc.updated_at);
    tr.appendChild(tdTime);

    const tdSize = document.createElement("td");
    tdSize.textContent = formatBytes((doc.content ?? "").length);
    tr.appendChild(tdSize);

    filesBody.appendChild(tr);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function setStatus(state, text) {
  syncState.dataset.state = state;
  if (state === "watching") {
    syncLabel.textContent = "watching";
    syncMeta.textContent = dirInput.value || "";
  } else if (state === "error") {
    syncLabel.textContent = "error";
    syncMeta.textContent = text;
  } else {
    syncLabel.textContent = "not watching";
    syncMeta.textContent = "";
  }
}

function resetToIdle() {
  watching = false;
  startSyncBtn.classList.remove("hidden");
  stopSyncBtn.classList.add("hidden");
  setStatus("idle", "not watching");
}

function addLog(message, className = "") {
  const line = document.createElement("div");
  line.className = "log-line" + (className ? ` ${className}` : "");
  line.textContent = message;
  logBox.appendChild(line);
  logBox.scrollTop = logBox.scrollHeight;

  while (logBox.childElementCount > 200) {
    logBox.removeChild(logBox.firstChild);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

(async function init() {
  const saved = await api.getConfig();
  if (saved.watchDir) {
    dirInput.value = saved.watchDir;
  }

  const restored = await api.restoreSession();
  if (restored.ok) {
    showMain(restored.session.email);
    // resume watching from the last session if possible, then sync the
    // controls with whatever state the main process is actually in (the
    // watcher may already be running from a previous launch or the tray).
    await api.autoResume();
    await syncUiFromMain();
  } else {
    showAuth();
  }
})();

async function syncUiFromMain() {
  const status = await api.getSyncStatus();
  if (status.watching) {
    watching = true;
    dirInput.value = status.watchDir ?? dirInput.value;
    startSyncBtn.classList.add("hidden");
    stopSyncBtn.classList.remove("hidden");
    setStatus("watching", "watching");
  } else {
    resetToIdle();
  }
}

const settingsToggle = document.getElementById("settings-toggle");
const settingsDrawer = document.getElementById("settings-drawer");

settingsToggle.addEventListener("click", () => {
  const isOpen = settingsDrawer.classList.toggle("open");
  settingsToggle.setAttribute("aria-expanded", String(isOpen));
  // remove .hidden on first open (it starts hidden via class, then CSS handles show/hide)
  settingsDrawer.classList.remove("hidden");
});
