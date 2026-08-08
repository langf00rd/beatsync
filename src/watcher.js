const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const chokidar = require("chokidar");

const DEFAULT_DEBOUNCE_MS = 1500;

/**
 * watches a directory for changes to files matching `extensions` and syncs
 * them via `syncClient`. debounces per-file so a burst of writes (autosave,
 * editors that write in chunks) collapses into a single sync call.
 *
 * emits:
 *   "sync"   { relativePath } after a successful push
 *   "delete" { relativePath } after a successful remote delete
 */
class DirectoryWatcher extends EventEmitter {
  constructor({
    rootDir,
    extensions,
    syncClient,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    logger = console,
  }) {
    super();
    this.rootDir = path.resolve(rootDir);
    this.extensions = new Set(extensions.map((ext) => ext.toLowerCase()));
    this.syncClient = syncClient;
    this.debounceMs = debounceMs;
    this.logger = logger;
    this._timers = new Map(); // relativePath -> debounce timer
    this._watcher = null;
  }

  start() {
    let initialScanCount = 0;
    let initialScanDone = false;

    this._watcher = chokidar.watch(this.rootDir, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this._watcher
      .on("add", (absPath) => {
        if (!initialScanDone && this._matchesExtension(absPath)) {
          initialScanCount += 1;
        }
        this._scheduleSync(absPath);
      })
      .on("change", (absPath) => {
        this._scheduleSync(absPath);
      })
      .on("unlink", (absPath) => {
        this._handleDelete(absPath);
      })
      .on("error", (err) => {
        this.logger.error("watcher error:", err);
      })
      .on("ready", () => {
        initialScanDone = true;

        this.logger.log(
          `initial scan complete: found ${initialScanCount} matching file(s) in ${this.rootDir}`,
        );

        if (initialScanCount === 0) {
          this.logger.log(
            `no files matching ${[...this.extensions].join(", ")} found. ` +
              `if you expected existing files to sync, check the extension and path is right.`,
          );
        }
      });

    this.logger.log(
      `watching ${this.rootDir} for changes to ${[...this.extensions].join(", ")}`,
    );

    return this._watcher;
  }

  stop() {
    if (this._watcher) {
      this._watcher.close();
      this._watcher = null;
    }
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  _scheduleSync(absPath) {
    if (!this._matchesExtension(absPath)) {
      this.logger.log(`[skip] ${absPath} — extension not in watch list`);
      return;
    }

    const relPath = path.relative(this.rootDir, absPath);
    clearTimeout(this._timers.get(relPath));

    const timer = setTimeout(() => {
      this._timers.delete(relPath);
      this._syncNow(relPath, absPath);
    }, this.debounceMs);

    this._timers.set(relPath, timer);
  }

  async _syncNow(relPath, absPath) {
    try {
      const content = await fs.promises.readFile(absPath, "utf8");
      const result = await this.syncClient.sync(relPath, content);
      if (result === "synced") {
        this.logger.log(`synced: ${relPath}`);
        this.emit("sync", { relativePath: relPath });
      }
    } catch (err) {
      // a file can vanish between the debounce firing and the read (race
      // with a delete/rename) — that's not a real failure, just a miss.
      if (err.code === "ENOENT") return;
      this.logger.error(`failed to sync ${relPath}:`, err.message);
    }
  }

  async _handleDelete(absPath) {
    if (!this._matchesExtension(absPath)) return;
    const relPath = path.relative(this.rootDir, absPath);
    clearTimeout(this._timers.get(relPath));
    this._timers.delete(relPath);

    try {
      await this.syncClient.delete(relPath);
      this.logger.log(`deleted remotely: ${relPath}`);
      this.emit("delete", { relativePath: relPath });
    } catch (err) {
      this.logger.error(`failed to delete ${relPath} remotely:`, err.message);
    }
  }

  _matchesExtension(absPath) {
    const extension = path.extname(absPath).toLowerCase();
    return this.extensions.has(extension);
  }
}

module.exports = { DirectoryWatcher };
