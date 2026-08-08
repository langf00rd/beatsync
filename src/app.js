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
const statusEl = $("status");
const statusText = $("status-text");
const logBox = $("log-box");
const refreshFilesBtn = $("refresh-files");
const filesEmpty = $("files-empty");
const filesBody = $("files-body");

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

  const result =
    authMode === "signup"
      ? await api.signUp(credentials)
      : await api.signIn(credentials);

  authSubmit.disabled = false;
  authSubmit.textContent = authMode === "signup" ? "create account" : "sign in";

  if (!result.ok) {
    showAuthError(result.error);
    return;
  }

  showMain(result.session.email);
});

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
  statusEl.dataset.state = state;
  statusText.textContent = text;
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
  } else {
    showAuth();
  }
})();
