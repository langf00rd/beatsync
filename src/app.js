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
const toastHost = $("toast-host");
const userEmail = $("user-email");
const statFiles = $("stat-files");
const statSize = $("stat-size");
const statLast = $("stat-last");
const sidebarBadge = $("sidebar-badge");
const sidebarItems = document.querySelectorAll(".sidebar-item");
const contentViews = document.querySelectorAll(".content-view");

const TOAST_DURATION_MS = 6000;

let authMode = "signin";
let watching = false;
let documents = [];
let activeView = "activity";

const THEME_STORAGE_KEY = "beatsync-theme";
const themeOptions = document.querySelectorAll("[data-theme-option]");
let currentTheme = "dark";

function updateThemeButtons(theme) {
  themeOptions.forEach((button) => {
    const isActive = button.dataset.themeOption === theme;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function applyTheme(theme) {
  const nextTheme = theme === "light" ? "light" : "dark";
  currentTheme = nextTheme;
  document.documentElement.setAttribute("data-theme", nextTheme);
  document.body.setAttribute("data-theme", nextTheme);

  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, nextTheme);
  } catch {}

  updateThemeButtons(nextTheme);
}

function initTheme() {
  let savedTheme = "dark";
  try {
    savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY) ?? "dark";
  } catch {}
  applyTheme(savedTheme);
}

function setActiveView(viewName) {
  activeView = viewName;
  sidebarItems.forEach((item) => {
    const isActive = item.dataset.view === viewName;
    item.classList.toggle("active", isActive);
  });

  contentViews.forEach((view) => {
    view.classList.toggle("hidden", view.id !== `view-${viewName}`);
  });
}

function setUserEmail(email) {
  if (!userEmail) return;
  userEmail.textContent = email
    ? `Signed in as ${email}`
    : "Sign in to sync your files.";
}

function updateSummary() {
  if (!statFiles || !statSize || !statLast) return;

  const trackedCount = documents.length;
  const totalSize = documents.reduce((sum, doc) => sum + (doc.content?.length ?? 0), 0);
  const lastUpdated = documents.reduce((latest, doc) => {
    if (!doc.updated_at) return latest;
    if (!latest) return doc.updated_at;
    return doc.updated_at > latest ? doc.updated_at : latest;
  }, "");

  statFiles.textContent = trackedCount > 0 ? trackedCount : "—";
  statSize.textContent = trackedCount > 0 ? formatBytes(totalSize) : "—";
  statLast.textContent = lastUpdated ? formatTime(lastUpdated) : "—";

  if (sidebarBadge) {
    sidebarBadge.textContent = trackedCount > 0 ? String(trackedCount) : "";
    sidebarBadge.classList.toggle("hidden", trackedCount === 0);
  }
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

function showAuth() {
  authView.classList.remove("hidden");
  mainView.classList.add("hidden");
}

function showMain() {
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

    showMain();
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
  setUserEmail("");
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
  addLog("synced: key copied", "synced");
});

encSaveBtn.addEventListener("click", async () => {
  const key = encKeyInput.value.trim();
  if (!key) {
    addLog("error: key missing", "error");
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
  addLog("synced: key saved", "synced");
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
  addLog("synced: key cleared", "synced");
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
    const msg = "choose a folder in settings first";
    setStatus("error", msg);
    showError(msg);
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
  startSyncBtn.innerHTML =
    '<span class="icon icon-plus" aria-hidden="true"></span> start watching';

  if (!result.ok) {
    addLog(result.error, "error");
    setStatus("error", result.error);
    return;
  }

  if (result.pulled > 0) {
    addLog(`synced: pulled ${result.pulled} files`, "synced");
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
  addLog("watching: changes");
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
    addLog(`error: files load failed: ${result.error}`, "error");
    return;
  }
  documents = result.documents ?? [];
  renderFiles();
  updateSummary();
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
  syncMeta.classList.toggle("sync-meta-error", state === "error");

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

  if (className === "error") {
    showError(message);
  }
}

function normalizeErrorMessage(message) {
  return String(message)
    .replace(/^error:\s*/i, "")
    .trim();
}

function showError(message) {
  showToast(normalizeErrorMessage(message), "error");
}

function showToast(message, type = "error") {
  if (!message || !toastHost) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "alert");

  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "toast-dismiss";
  dismiss.setAttribute("aria-label", "dismiss alert");
  dismiss.textContent = "×";

  toast.append(text, dismiss);
  toastHost.appendChild(toast);

  while (toastHost.childElementCount > 3) {
    removeToast(toastHost.firstElementChild);
  }

  requestAnimationFrame(() => toast.classList.add("visible"));

  let timer = setTimeout(() => removeToast(toast), TOAST_DURATION_MS);

  dismiss.addEventListener("click", () => {
    clearTimeout(timer);
    removeToast(toast);
  });
}

function removeToast(toast) {
  if (!toast || toast.classList.contains("leaving")) return;
  toast.classList.remove("visible");
  toast.classList.add("leaving");
  toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  setTimeout(() => toast.remove(), 350);
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
  setStatus("idle", "not watching");
  setActiveView("activity");

  const saved = await api.getConfig();
  if (saved.watchDir) {
    dirInput.value = saved.watchDir;
  }

  const restored = await api.restoreSession();
  if (restored.ok) {
    setUserEmail(restored.session?.email ?? "");
    showMain();
    // resume watching from the last session if possible, then sync the
    // controls with whatever state the main process is actually in (the
    // watcher may already be running from a previous launch or the tray).
    await api.autoResume();
    await syncUiFromMain();
  } else {
    setUserEmail("");
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

initTheme();

themeOptions.forEach((button) => {
  button.addEventListener("click", () => {
    applyTheme(button.dataset.themeOption);
  });
});

sidebarItems.forEach((item) => {
  item.addEventListener("click", () => {
    setActiveView(item.dataset.view);
  });
});
