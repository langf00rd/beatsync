const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createClient } = require("@supabase/supabase-js");
const { WebSocket } = require("ws");
const { SupabaseSyncClient } = require("./sync.js");
const { DirectoryWatcher } = require("./watcher");
const {
  generateKey,
  normalizeKey,
  fingerprint,
  isEncrypted,
  decrypt,
} = require("./crypto");

// credentials are written into config.generated.js by scripts/inject-config.js
// (which reads the repo root .env) so end users never configure anything.
const CONFIG = require("./config.generated.js");

// network calls against supabase get a hard timeout so a stalled connection
// fails with a clear error instead of hanging the sign-in/sync forever.
const REQUEST_TIMEOUT_MS = 15000;

function timedFetch(input, init) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return fetch(input, { ...init, signal });
}

let mainWindow = null;
let supabase = null;
let userId = null;
let syncClient = null;
let watcher = null;
let watchDir = null;
let encryptionKey = null;
let tray = null;
let isQuitting = false;

const statePath = () => path.join(app.getPath("userData"), "state.json");
const sessionPath = () => path.join(app.getPath("userData"), "session.json");
const encryptionKeyPath = () =>
  path.join(app.getPath("userData"), "encryption-key.bin");

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

  // closing the window hides it to the menu bar instead of stopping the sync:
  // beatsync keeps watching in the background and the tray "open beatsync"
  // item brings the window back. only a real quit (cmd+q / tray quit) closes it.
  mainWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => (mainWindow = null));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

const trayIconPath = () =>
  path.join(__dirname, "..", "assets", "trayTemplate.png");

function buildTrayMenu() {
  const watching = !!watcher;
  const statusLabel = watching
    ? `running — watching ${watchDir}`
    : "running — not watching";

  const items = [{ label: statusLabel, enabled: false }, { type: "separator" }];

  if (watching) {
    items.push({
      label: "stop watching",
      click: () => {
        stopWatching();
        saveState({});
      },
    });
  } else {
    items.push({ label: "start watching", click: trayStartWatching });
  }

  items.push(
    { type: "separator" },
    { label: "open beatsync", click: showMainWindow },
    { label: "quit beatsync", click: () => app.quit() },
  );

  return Menu.buildFromTemplate(items);
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(watchingLabel());
}

function watchingLabel() {
  return watcher
    ? `beatsync — watching ${watchDir}`
    : "beatsync — not watching";
}

function createTray() {
  const icon = nativeImage.createFromPath(trayIconPath());
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on("click", () => tray.popUpContextMenu(buildTrayMenu()));
  updateTrayMenu();
}

async function trayStartWatching() {
  try {
    const saved = loadState();
    let dir = watchDir || saved.watchDir;
    if (!dir) {
      const result = await dialog.showOpenDialog({
        title: "choose your scripts folder",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || result.filePaths.length === 0) return;
      dir = result.filePaths[0];
    }
    await startWatchingFlow({ dir, extensions: saved.extensions });
    sendLog(`watching ${dir} — started from the menu bar.`);
  } catch (err) {
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "beatsync",
      message: err.message,
      buttons: ["open beatsync", "ok"],
    });
    if (response === 0) showMainWindow();
  }
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
    fetch: timedFetch,
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

async function authenticate({ email, password, signUp, firstName, lastName }) {
  const client = createAppClient();

  let data, error;
  if (signUp) {
    ({ data, error } = await client.auth.signUp({
      email,
      password,
      options: { data: { first_name: firstName, last_name: lastName } },
    }));
    if (error) throw new Error(error.message);
    if (!data.session) {
      throw new Error(
        "account created! please check your email to confirm, then sign in.",
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

  // keep the app-level profile row in sync: names come from the signup form
  // (or persisted user metadata), last_login is stamped on every sign-in.
  const meta = data.user.user_metadata ?? {};
  const profile = {
    id: userId,
    email: data.user.email ?? email,
    last_login: new Date().toISOString(),
  };
  if (signUp) {
    profile.first_name = firstName ?? meta.first_name ?? "";
    profile.last_name = lastName ?? meta.last_name ?? "";
  } else if (meta.first_name || meta.last_name) {
    profile.first_name = meta.first_name ?? "";
    profile.last_name = meta.last_name ?? "";
  }

  try {
    await client.from("profiles").upsert(profile, { onConflict: "id" });
  } catch (err) {
    sendLog(`failed to update profile: ${err.message}`);
  }

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

// the encryption key never touches supabase — it is stored encrypted by the
// os keychain (macOS keychain, windows dpapi, linux libsecret) via electron's
// safeStorage, so the app can decrypt documents without the server ever
// seeing the key or the plaintext.
function loadEncryptionKey() {
  try {
    if (!fs.existsSync(encryptionKeyPath())) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(encryptionKeyPath()));
  } catch {
    return null;
  }
}

function saveEncryptionKey(key) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("secure key storage is not available on this machine.");
  }
  fs.writeFileSync(encryptionKeyPath(), safeStorage.encryptString(key));
}

function clearEncryptionKey() {
  try {
    fs.unlinkSync(encryptionKeyPath());
  } catch {}
}

// the device key's server-side fingerprint (see crypto.fingerprint): used to
// detect a wrong key before any document is decrypted or written.
function keyFingerprint(key) {
  return fingerprint(key);
}

// returns the stored key fingerprint for the signed-in user, or null when the
// user has never synced with a key (fresh account or pre-fingerprint legacy).
async function storedKeyFingerprint() {
  if (!supabase || !userId) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("key_hash")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw keyCheckError(error);
  return data?.key_hash ?? null;
}

async function storeKeyFingerprint(fp) {
  if (!supabase || !userId) return;
  const { error } = await supabase
    .from("profiles")
    .update({ key_hash: fp })
    .eq("id", userId);
  if (error) throw keyCheckError(error);
}

// maps postgrest errors to a clear message; "column does not exist" (42703)
// means schema.sql hasn't been applied to the project yet.
function keyCheckError(error) {
  if (error.code === "42703") {
    return new Error(
      "the database is missing the encryption key column — run the latest schema.sql in the supabase sql editor.",
    );
  }
  return new Error(`failed to verify encryption key: ${error.message}`);
}

function startWatching(dir, extensions) {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }

  syncClient =
    syncClient ?? new SupabaseSyncClient(supabase, userId, encryptionKey);
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
  updateTrayMenu();
}

function stopWatching() {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  sendToRenderer("watcher-stopped", {});
  updateTrayMenu();
}

// the shared start sequence used by both the window's "start watching" button
// and the menu-bar tray item. verifies the key fingerprint before touching any
// document, pulls anything missing, then starts the watcher.
async function startWatchingFlow({ dir, extensions }) {
  if (!fs.existsSync(dir)) {
    throw new Error("that folder no longer exists. please pick it again.");
  }

  const extList = extensions?.length ? extensions : CONFIG.defaultExtensions;
  if (!supabase || !userId) {
    throw new Error("not signed in. please sign in first.");
  }
  if (!encryptionKey) {
    throw new Error(
      "no encryption key set — generate or paste one in the encryption section first.",
    );
  }

  // reject a wrong key before touching any document: the stored fingerprint
  // tells us which key encrypted this user's docs. a device without the
  // original key must not be able to read or write them.
  const fp = keyFingerprint(encryptionKey);
  const storedFp = await storedKeyFingerprint();
  if (storedFp && storedFp !== fp) {
    throw new Error(
      "this device's encryption key doesn't match the one that encrypted your documents. " +
        "to read and write your documents, you need the original key — a new key can't open them.",
    );
  }

  syncClient = new SupabaseSyncClient(supabase, userId, encryptionKey);
  const { pulled, migrated } = await syncClient.pullMissingFiles(dir);
  if (pulled > 0) {
    sendLog(`pulled ${pulled} file(s) from beatsync cloud`);
  }
  if (migrated > 0) {
    sendLog(`re-encrypted ${migrated} legacy file(s)`);
  }

  // first successful sync (or a legacy account with no fingerprint yet):
  // only now is this key proven to be the right one, so stamp it.
  if (!storedFp) {
    await storeKeyFingerprint(fp);
  }

  startWatching(dir, extList);
  saveState({ watchDir: dir, extensions: extList });
  return { pulled };
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
    const { pulled } = await startWatchingFlow({ dir, extensions });
    return { ok: true, pulled };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("sync:autoResume", async () => {
  const saved = loadState();
  if (!saved.watchDir) return { ok: true, resumed: false };
  if (!supabase || !userId) return { ok: true, resumed: false };
  if (!encryptionKey) return { ok: true, resumed: false };
  try {
    const { pulled } = await startWatchingFlow({
      dir: saved.watchDir,
      extensions: saved.extensions,
    });
    if (pulled > 0) {
      sendLog(`pulled ${pulled} file(s) from beatsync cloud`);
    }
    return { ok: true, resumed: true };
  } catch (err) {
    sendLog(`auto-resume failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("sync:getStatus", () => ({
  watching: !!watcher,
  watchDir: watcher ? watchDir : null,
  signedIn: !!supabase && !!userId,
  hasKey: !!encryptionKey,
}));

ipcMain.handle("sync:stop", async () => {
  stopWatching();
  saveState({});
  return { ok: true };
});

ipcMain.handle("sync:listDocuments", async () => {
  try {
    if (!supabase || !userId) return { ok: true, documents: [] };
    if (!encryptionKey) {
      return {
        ok: false,
        error:
          "no encryption key set — nothing can be read or written until a key is set in the encryption section.",
      };
    }
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

ipcMain.handle("encryption:getStatus", async () => {
  // matches: true when the device key is the one that encrypted this account's
  // documents, false when it's a different key, null when we can't tell yet
  // (no key, not signed in, or offline).
  if (!encryptionKey) return { hasKey: false, matches: null };
  try {
    const storedFp = await storedKeyFingerprint();
    return {
      hasKey: true,
      matches: storedFp ? storedFp === keyFingerprint(encryptionKey) : null,
    };
  } catch {
    return { hasKey: true, matches: null };
  }
});

ipcMain.handle("encryption:generate", () => {
  return { key: generateKey() };
});

ipcMain.handle("encryption:set", async (_event, key) => {
  try {
    const buffer = normalizeKey(key);

    // a wrong key must never be accepted: if this account already has a key
    // fingerprint stored, only the matching key can unlock its documents.
    const storedFp = await storedKeyFingerprint();
    if (storedFp && storedFp !== keyFingerprint(buffer)) {
      throw new Error(
        "this key doesn't match the original key used to encrypt your documents. " +
          "you need the original key to access them",
      );
    }

    // no fingerprint yet (fresh account or pre-fingerprint documents): prove
    // the key is the right one by decrypting the most recent document.
    if (!storedFp && supabase && userId) {
      const { data: sample, error: sampleErr } = await supabase
        .from("documents")
        .select("content")
        .eq("user_id", userId)
        .order("updated_at", { ascending: false })
        .limit(1);
      if (sampleErr) {
        throw new Error(
          `failed to verify encryption key: ${sampleErr.message}`,
        );
      }
      const content = sample?.[0]?.content;
      if (content && isEncrypted(content)) {
        try {
          decrypt(buffer, content);
        } catch {
          throw new Error(
            "this encryption key can't open your existing documents. " +
              "use the key you saved when you first set up beatsync.",
          );
        }
      }
    }

    const changed = !encryptionKey || !encryptionKey.equals(buffer);
    if (changed) {
      // drop any live sync: it still holds the previous key in memory, and a
      // changed key must be re-verified before reading or writing resumes.
      stopWatching();
      syncClient = null;
    }

    saveEncryptionKey(key);
    encryptionKey = buffer;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("encryption:getKey", () => {
  if (!encryptionKey) return { key: null };
  return { key: loadEncryptionKey() };
});

ipcMain.handle("encryption:clear", () => {
  // no key on the device means nothing can be read from or written to the
  // cloud: stop the watcher and drop the in-memory client (which holds the
  // old key) so no document is touched until a key is set again.
  stopWatching();
  syncClient = null;
  clearEncryptionKey();
  encryptionKey = null;
  return { ok: true };
});

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  try {
    const raw = loadEncryptionKey();
    encryptionKey = raw ? normalizeKey(raw) : null;
  } catch {
    encryptionKey = null;
  }
  if (process.platform === "win32") app.setAppUserModelId("com.beatsync.app");
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (watcher) stopWatching();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
