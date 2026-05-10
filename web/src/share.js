/**
 * End-to-end encrypted sharing.
 *
 * The server stores opaque ciphertext keyed by a random 12-character id;
 * the AES-256-GCM key never leaves the browser. A share link looks like:
 *
 *   https://zorto.example.org/#s=<id>&k=<base64url-key>
 *
 * The key lives in the URL fragment, which browsers do not transmit to
 * servers, so the server never observes plaintext or the key. Anyone with
 * the link can decrypt; that is the entire access-control model.
 *
 * Wire format inside the ciphertext blob (base64url-encoded as a single
 * string in the JSON body): `iv (12 bytes) || aes_gcm_ciphertext`.
 *
 * Exposes two operations:
 *   - createShare(payload):  encrypt + POST /api/shares
 *   - loadShare(id, keyB64): GET /api/shares/{id} + decrypt
 *
 * `payload` is an arbitrary string the caller is responsible for encoding
 * (zorto wraps it as JSON of the form `{ title, content }`).
 */

/** Encode raw bytes as base64url without padding. */
function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Decode an unpadded base64url string back to bytes. */
function b64urlDecode(s) {
  s = s.replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Encrypt `plaintext` under a freshly generated 256-bit AES-GCM key. The IV
 * is prepended to the ciphertext so the receiver doesn't need to manage it
 * separately. Both outputs are base64url-encoded.
 *
 * @param {string} plaintext
 * @returns {Promise<{ciphertextB64: string, keyB64: string}>}
 */
async function encryptPayload(plaintext) {
  const enc = new TextEncoder();
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext))
  );
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return { ciphertextB64: b64urlEncode(combined), keyB64: b64urlEncode(keyBytes) };
}

/**
 * Inverse of `encryptPayload`. Throws if the ciphertext was tampered with
 * (AES-GCM authentication failure) or if `keyB64` doesn't match.
 *
 * @param {string} keyB64
 * @param {string} ciphertextB64
 * @returns {Promise<string>} the original plaintext.
 */
async function decryptPayload(keyB64, ciphertextB64) {
  const dec = new TextDecoder();
  const keyBytes = b64urlDecode(keyB64);
  const combined = b64urlDecode(ciphertextB64);
  const iv = combined.slice(0, 12);
  const ct = combined.slice(12);
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return dec.decode(plaintext);
}

/**
 * Encrypt `payload`, upload the ciphertext, and return the (id, key) pair
 * that the caller should embed in the share URL fragment as `#s=<id>&k=<key>`.
 *
 * The session cookie is sent automatically (POST /api/shares requires the
 * user to be signed in; the server records `owner_sub`).
 *
 * @param {string} payload  arbitrary string (zorto encodes a JSON object).
 * @returns {Promise<{id: string, keyB64: string}>}
 * @throws if the upload fails.
 */
export async function createShare(payload) {
  const { ciphertextB64, keyB64 } = await encryptPayload(payload);
  const res = await fetch("./api/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ciphertext: ciphertextB64 }),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { id } = await res.json();
  return { id, keyB64 };
}

/**
 * Fetch a share by id and decrypt it under `keyB64`. No auth required —
 * the server happily serves any ciphertext to anyone with the id, since
 * confidentiality is enforced by the key (which the server never sees).
 *
 * @param {string} id     the share id from the URL fragment.
 * @param {string} keyB64 the base64url-encoded AES key from the fragment.
 * @returns {Promise<string>} the decrypted plaintext.
 * @throws if the fetch or decryption fails.
 */
export async function loadShare(id, keyB64) {
  const res = await fetch(`./api/shares/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const { ciphertext } = await res.json();
  return decryptPayload(keyB64, ciphertext);
}
