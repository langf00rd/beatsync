const fs = require("node:fs");
const path = require("node:path");
const enc = require("./crypto");

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

// postgrest error codes that mean "retrying won't help" — a unique
// violation or an rls rejection is a logic problem, not a network blip.
const NON_RETRYABLE_CODES = new Set(["23505", "42501"]);

/**
 * pushes/pulls document snapshots to/from the `documents` table. content
 * is encrypted (aes-256-gcm) before it leaves the machine and decrypted on
 * the way back, so the server only ever stores ciphertext. change detection
 * uses an hmac of the plaintext keyed by the user's key, so the stored hash
 * is meaningless to the server too.
 */
class SupabaseSyncClient {
  constructor(supabase, userId, encryptionKey) {
    if (!encryptionKey || encryptionKey.length !== 32) {
      throw new Error("a valid encryption key is required.");
    }
    this.supabase = supabase;
    this.userId = userId;
    this._key = encryptionKey;
    this._lastHashes = new Map(); // relativePath -> content hash
  }

  /**
   * on startup: any document that exists in supabase but not locally gets
   * decrypted and written into `rootDir`. legacy plaintext rows (written
   * before encryption existed) are re-encrypted here so the server stops
   * holding readable content.
   * @returns {Promise<{pulled: number, migrated: number}>}
   */
  async pullMissingFiles(rootDir) {
    const { data, error } = await this.supabase
      .from("documents")
      .select("path, content, hash")
      .eq("user_id", this.userId);

    if (error)
      throw new Error(`failed to list remote documents: ${error.message}`);

    // phase 1: decrypt every remote row up front. if the key is wrong we find
    // out here, before anything is written — a wrong key must never write to
    // the cloud or overwrite local files.
    const rows = [];
    for (const doc of data ?? []) {
      if (enc.isEncrypted(doc.content)) {
        try {
          rows.push({
            doc,
            plaintext: enc.decrypt(this._key, doc.content),
            isLegacy: false,
          });
        } catch (err) {
          throw new Error(
            `failed to decrypt ${doc.path} — the saved encryption key is wrong. ` +
              `changes won't sync until the correct key is set in the encryption section.`,
          );
        }
      } else {
        // written before encryption existed — pull it as-is and re-encrypt
        // below so the server no longer stores it readable.
        rows.push({ doc, plaintext: doc.content, isLegacy: true });
      }
    }

    // phase 2: the key is proven correct, so pull/migrate.
    let pulled = 0;
    let migrated = 0;
    for (const { doc, plaintext, isLegacy } of rows) {
      const absPath = path.join(rootDir, doc.path);
      const contentHash = enc.hash(this._key, plaintext);

      if (!fs.existsSync(absPath)) {
        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await fs.promises.writeFile(absPath, plaintext, "utf8");
        pulled += 1;
      }

      this._lastHashes.set(doc.path, contentHash);

      if (isLegacy) {
        await this._upsert(doc.path, plaintext, contentHash);
        migrated += 1;
      }
    }
    return { pulled, migrated };
  }

  /** @returns {Promise<"synced"|"unchanged">} */
  async sync(relativePath, content) {
    const contentHash = enc.hash(this._key, content);
    if (this._lastHashes.get(relativePath) === contentHash) {
      return "unchanged";
    }

    await this._upsert(relativePath, content, contentHash);
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

  async _upsert(relativePath, plaintext, contentHash) {
    const encrypted = enc.encrypt(this._key, plaintext);
    await this._withRetry(() =>
      this.supabase.from("documents").upsert(
        {
          user_id: this.userId,
          path: relativePath,
          content: encrypted,
          hash: contentHash,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,path" },
      ),
    );
    this._lastHashes.set(relativePath, contentHash);
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
