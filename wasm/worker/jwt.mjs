// Standard RFC 7519 HS256 JWT sign & verify using Web Crypto (zero dependencies).
// Runs identically in Cloudflare Workers and Node >= 20.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64url_encode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64url_decode(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]+$/.test(str)) {
    throw new Error("Invalid base64url string");
  }
  let padded = str.replace(/-/g, "+").replace(/_/g, "/");
  while (padded.length % 4 !== 0) padded += "=";
  let binary = atob(padded);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function import_hmac_key(secret, usages) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("JWT secret must be a string of at least 16 characters.");
  }
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {name: "HMAC", hash: "SHA-256"},
    false,
    usages
  );
}

/**
 * Signs a payload object as an HS256 JWT.
 * Adds `iat` and `exp` (if `ttl_seconds` is provided and `exp` is not already set).
 */
export async function sign_jwt(payload, secret, {ttl_seconds = 3600, now_seconds = Math.floor(Date.now() / 1000)} = {}) {
  let header = {alg: "HS256", typ: "JWT"};
  let claims = {
    ...payload,
    iat: typeof payload.iat === "number" ? payload.iat : now_seconds,
  };
  if (typeof claims.exp !== "number" && typeof ttl_seconds === "number") {
    claims.exp = claims.iat + ttl_seconds;
  }

  let encoded_header = base64url_encode(encoder.encode(JSON.stringify(header)));
  let encoded_payload = base64url_encode(encoder.encode(JSON.stringify(claims)));
  let signing_input = `${encoded_header}.${encoded_payload}`;

  let key = await import_hmac_key(secret, ["sign"]);
  let sig_buf = await crypto.subtle.sign("HMAC", key, encoder.encode(signing_input));
  let encoded_sig = base64url_encode(new Uint8Array(sig_buf));
  return `${signing_input}.${encoded_sig}`;
}

/**
 * Verifies an HS256 JWT and returns its decoded payload, or null if invalid/expired.
 */
export async function verify_jwt(token, secret, {now_seconds = Math.floor(Date.now() / 1000)} = {}) {
  if (typeof token !== "string") return null;
  let parts = token.split(".");
  if (parts.length !== 3) return null;

  let [encoded_header, encoded_payload, encoded_sig] = parts;
  let header;
  let payload;
  let sig_bytes;
  try {
    header = JSON.parse(decoder.decode(base64url_decode(encoded_header)));
    payload = JSON.parse(decoder.decode(base64url_decode(encoded_payload)));
    sig_bytes = base64url_decode(encoded_sig);
  }
  catch {
    return null;
  }

  if (!header || header.alg !== "HS256" || header.typ !== "JWT") {
    return null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }

  let key;
  try {
    key = await import_hmac_key(secret, ["verify"]);
  }
  catch {
    return null;
  }

  let signing_input = `${encoded_header}.${encoded_payload}`;
  let valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sig_bytes,
    encoder.encode(signing_input)
  );
  if (!valid) return null;

  if (typeof payload.exp === "number" && now_seconds >= payload.exp) {
    return null;
  }
  if (typeof payload.nbf === "number" && now_seconds < payload.nbf) {
    return null;
  }

  return payload;
}
