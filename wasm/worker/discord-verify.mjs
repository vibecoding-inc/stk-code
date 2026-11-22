// Discord Interactions Ed25519 request signature verification using Web Crypto.
// Required by Discord for all HTTP Interactions Endpoint webhooks.

const encoder = new TextEncoder();

function hex_to_bytes(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
    return null;
  }
  let bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verifies Discord's `X-Signature-Ed25519` and `X-Signature-Timestamp` headers
 * against the raw request body using the application's hex public key.
 */
export async function verify_discord_signature({public_key_hex, signature_hex, timestamp, raw_body}) {
  if (!public_key_hex || !signature_hex || !timestamp || typeof raw_body !== "string") {
    return false;
  }
  let public_key_bytes = hex_to_bytes(public_key_hex);
  let signature_bytes = hex_to_bytes(signature_hex);
  if (!public_key_bytes || !signature_bytes || public_key_bytes.length !== 32 || signature_bytes.length !== 64) {
    return false;
  }

  try {
    let key = await crypto.subtle.importKey(
      "raw",
      public_key_bytes,
      {name: "Ed25519"},
      false,
      ["verify"]
    );
    let message = encoder.encode(timestamp + raw_body);
    return await crypto.subtle.verify("Ed25519", key, signature_bytes, message);
  }
  catch {
    return false;
  }
}
