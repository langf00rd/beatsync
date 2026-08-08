const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createClient } = require("@supabase/supabase-js");
const { WebSocket } = require("ws");
const { SupabaseSyncClient } = require("./sync.js");
const { DirectoryWatcher } = require("./watcher");

// credentials are written into config.generated.js by scripts/inject-config.js
// (which reads the repo root .env) so end users never configure anything.
const CONFIG = require("./config.generated.js");

let mainWindow = null;
let supabase = null;
let userId = null;
let syncClient = null;
let watcher = null;
let watchDir = null;

const statePath = () => path.join(app.getPath("userData"), "state.json");
const sessionPath = () => path.join(app.getPath("userData"), "session.json");

function loadJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadSession() {
  return loadJson(sessionPath());
}

function saveSession(session) {
  fs.writeFileSync(sessionPath(), JSON.stringify(session, null, 2));
}

function loadState() {
  return loadJson(statePath()) ?? {};
}

function saveState(state) {
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 700,
    minHeight: 500,
    title: "beatsync",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));
  mainWindow.on("closed", () => (mainWindow = null));
}

// file-backed storage adapter so supabase-js persists (and auto-refreshes)
// the session across app restarts without any user setup.
const sessionStorage = {
  getItem: (key) => {
    const session = loadSession();
    return session ? (session[key] ?? null) : null;
  },
  setItem: (key, value) => {
    const session = loadSession() ?? {};
    session[key] = value;
    saveSession(session);
  },
  removeItem: (key) => {
    const session = loadSession() ?? {};
    delete session[key];
    saveSession(session);
  },
};

function createAppClient() {
  return createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: sessionStorage,
    },
    // electron bundles node 20, which has no native websocket — the realtime
    // client (created eagerly by supabase-js) needs one supplied via `ws`.
    realtime: { transport: WebSocket },
  });
}

async function authenticate({ email, password, signUp }) {
  const client = createAppClient();

  let data, error;
  if (signUp) {
    ({ data, error } = await client.auth.signUp({ email, password }));
    if (error) throw new Error(error.message);
    if (!data.session) {
      throw new Error(
        "Account created! Please check your email to confirm, then sign in.",
      );
    }
  } else {
    ({ data, error } = await client.auth.signInWithPassword({
      email,
      password,
    }));
    if (error) throw new Error(error.message);
  }

  // the storage adapter persists the full session (tokens included) during
  // sign-in, and autoRefreshToken keeps it fresh across restarts.
  supabase = client;
  userId = data.user.id;
  return { email: data.user.email ?? email };
}

async function restoreSession() {
  if (!loadSession()) return null;

  try {
    const client = createAppClient();
    // the storage-backed client recovers the persisted session on the first
    // getSession() call, auto-refreshing the token if needed.
    const { data, error } = await client.auth.getSession();

    if (error || !data.session) {
      clearSession();
      return null;
    }

    supabase = client;
    userId = data.session.user.id;
    return { email: data.session.user.email };
  } catch {
    clearSession();
    return null;
  }
}

function clearSession() {
  try {
    fs.unlinkSync(sessionPath());
  } catch {}
}

function startWatching(dir, extensions) {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }

  syncClient = syncClient ?? new SupabaseSyncClient(supabase, userId);
  watchDir = dir;

  watcher = new DirectoryWatcher({
    rootDir: dir,
    extensions,
    syncClient,
    logger: {
      log: (...args) => sendLog(args.join(" ")),
      error: (...args) => sendLog("error: " + args.join(" ")),
    },
  });

  watcher.on("sync", ({ relativePath }) =>
    sendToRenderer("doc-updated", { relativePath }),
  );
  watcher.on("delete", ({ relativePath }) =>
    sendToRenderer("doc-deleted", { relativePath }),
  );

  watcher.start();
  sendToRenderer("watcher-started", { rootDir: dir, extensions });
}

function stopWatching() {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  sendToRenderer("watcher-stopped", {});
}

function sendLog(message) {
  sendToRenderer("log", { message });
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// ipc handlers
// ---------------------------------------------------------------------------

ipcMain.handle("auth:signIn", async (_event, credentials) => {
  try {
    const session = await authenticate({ ...credentials, signUp: false });
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("auth:signUp", async (_event, credentials) => {
  try {
    const session = await authenticate({ ...credentials, signUp: true });
    return { ok: true, session };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("auth:restore", async () => {
  const session = await restoreSession();
  return { ok: !!session, session };
});

ipcMain.handle("auth:signOut", async () => {
  if (watcher) stopWatching();
  clearSession();
  supabase = null;
  userId = null;
  syncClient = null;
  watchDir = null;
  return { ok: true };
});

ipcMain.handle("sync:start", async (_event, { dir, extensions }) => {
  try {
    if (!fs.existsSync(dir)) {
      throw new Error("that folder no longer exists. please pick it again.");
    }

    const extList = extensions?.length ? extensions : CONFIG.defaultExtensions;
    if (!supabase || !userId) {
      throw new Error("not signed in. please sign in first.");
    }
    syncClient = new SupabaseSyncClient(supabase, userId);
    const pulled = await syncClient.pullMissingFiles(dir);
    if (pulled > 0) {
      sendLog(`pulled ${pulled} file(s) from beatsync cloud`);
    }

    startWatching(dir, extList);
    saveState({ watchDir: dir, extensions: extList });
    return { ok: true, pulled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("sync:stop", async () => {
  stopWatching();
  saveState({});
  return { ok: true };
});

ipcMain.handle("sync:listDocuments", async () => {
  try {
    if (!supabase || !userId) return { ok: true, documents: [] };
    const { data, error } = await supabase
      .from("documents")
      .select("path, content, updated_at, hash")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });

    if (error) throw new Error(error.message);
    return { ok: true, documents: data ?? [] };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("dialog:selectDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "choose your scripts folder",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("config:get", () => {
  return loadState();
});

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (watcher) stopWatching();
  if (process.platform !== "darwin") app.quit();
});
