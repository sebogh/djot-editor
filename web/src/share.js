function b64urlEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

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

export async function createShare(payload) {
  const { ciphertextB64, keyB64 } = await encryptPayload(payload);
  const res = await fetch("/api/shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ciphertext: ciphertextB64 }),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { id } = await res.json();
  return { id, keyB64 };
}

export async function loadShare(id, keyB64) {
  const res = await fetch(`/api/shares/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const { ciphertext } = await res.json();
  return decryptPayload(keyB64, ciphertext);
}
