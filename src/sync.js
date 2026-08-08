const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// postgrest error codes that mean "retrying won't help" — a unique
// violation or an rls rejection is a logic problem, not a network blip.
const NON_RETRYABLE_CODES = new Set(["23505", "42501"]);

/**
 * pushes/pulls document snapshots to/from the `documents` table. content
 * lives in the db row, not a storage bucket, by design (per the ask).
 */
class SupabaseSyncClient {
  constructor(supabase, userId) {
    this.supabase = supabase;
    this.userId = userId;
    this._lastHashes = new Map(); // relativePath -> content hash
  }

  /**
   * on startup: any document that exists in supabase but not locally gets
   * written into `rootDir`, so a fresh machine/folder ends up with every
   * file already there before the watcher even starts. files that already
   * exist locally are left alone — local is the source of truth for those.
   * @returns {Promise<number>} number of files pulled down.
   */
  async pullMissingFiles(rootDir) {
    const { data, error } = await this.supabase
      .from("documents")
      .select("path, content, hash")
      .eq("user_id", this.userId);

    if (error)
      throw new Error(`failed to list remote documents: ${error.message}`);

    let pulled = 0;
    for (const doc of data ?? []) {
      const absPath = path.join(rootDir, doc.path);

      if (fs.existsSync(absPath)) {
        // already local — remember its remote hash so the watcher's initial
        // scan doesn't immediately re-push it as a "change".
        this._lastHashes.set(doc.path, doc.hash);
        continue;
      }

      await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
      await fs.promises.writeFile(absPath, doc.content, "utf8");
      this._lastHashes.set(doc.path, doc.hash);
      pulled += 1;
    }
    return pulled;
  }

  /** @returns {Promise<"synced"|"unchanged">} */
  async sync(relativePath, content) {
    const hash = crypto.createHash("sha256").update(content).digest("hex");
    if (this._lastHashes.get(relativePath) === hash) {
      return "unchanged";
    }

    await this._withRetry(() =>
      this.supabase.from("documents").upsert(
        {
          user_id: this.userId,
          path: relativePath,
          content,
          hash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,path" },
      ),
    );

    this._lastHashes.set(relativePath, hash);
    return "synced";
  }

  async delete(relativePath) {
    await this._withRetry(() =>
      this.supabase
        .from("documents")
        .delete()
        .match({ user_id: this.userId, path: relativePath }),
    );
    this._lastHashes.delete(relativePath);
  }

  async _withRetry(operation) {
    let attempt = 0;
    for (;;) {
      const { error } = await operation();
      if (!error) return;

      attempt += 1;
      if (attempt >= MAX_RETRIES || NON_RETRYABLE_CODES.has(error.code)) {
        throw new Error(
          `supabase operation failed: ${error.message}` +
            (error.code ? ` [code: ${error.code}]` : "") +
            (error.details ? ` details: ${error.details}` : "") +
            (error.hint ? ` hint: ${error.hint}` : ""),
        );
      }
      await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { SupabaseSyncClient };
