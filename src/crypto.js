const crypto = require("node:crypto");

const PREFIX = "bs1:";

function generateKey() {
  return crypto.randomBytes(32).toString("base64url");
}

function normalizeKey(key) {
  if (typeof key !== "string") {
    throw new Error("key must be a string.");
  }
  const cleaned = key.trim();
  if (!cleaned) {
    throw new Error("key must not be empty.");
  }
  let buf = null;
  for (const encoding of ["base64url", "base64"]) {
    try {
      const candidate = Buffer.from(cleaned, encoding);
      if (candidate.length === 32) {
        buf = candidate;
        break;
      }
    } catch { }
  }
  if (!buf) {
    throw new Error(
      "invalid encryption key. it must be 32 bytes (use the generate button).",
    );
  }
  return buf;
}

function encrypt(key, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decrypt(key, encoded) {
  if (!isEncrypted(encoded)) {
    throw new Error("content is not in encrypted format.");
  }
  const raw = Buffer.from(encoded.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

function isEncrypted(content) {
  return typeof content === "string" && content.startsWith(PREFIX);
}

function hash(key, plaintext) {
  return crypto
    .createHmac("sha256", key)
    .update(plaintext, "utf8")
    .digest("hex");
}

// a device key "fingerprint" that can be stored on the server: it is derived
// from the key (hmac of a fixed message) so a wrong key can be detected before
// any document is decrypted, but it reveals nothing about the key itself and
// can't be used to decrypt anything.
function fingerprint(key) {
  return crypto
    .createHmac("sha256", key)
    .update("beatsync-key-check", "utf8")
    .digest("hex");
}

module.exports = {
  PREFIX,
  generateKey,
  normalizeKey,
  encrypt,
  decrypt,
  isEncrypted,
  hash,
  fingerprint,
};
