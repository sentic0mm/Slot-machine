// Drei Schlösser, ALLE müssen passen (sonst passiert gar nichts):
//
//  1) Cloudflare Access: Cloudflare lässt nur deine E-Mail durch (Einmal-
//     Code per Mail) und hängt ein signiertes JWT an jede Anfrage. Der Worker
//     prüft die Signatur selbst nach (falls Access mal aus Versehen
//     abgeschaltet wird, bleibt trotzdem alles zu).
//  2) Spielkonto: Login mit @Name + Passwort über den Spiel-Worker. Die UID
//     muss genau ADMIN_UID sein. Danach gibt es ein kurzes Admin-Token
//     (30 Min.), das an dieses Gerät gebunden ist.
//  3) Browser-Prüfung: Der Browser hat einen eigenen Schlüssel (ECDSA,
//     nicht exportierbar, liegt nur in diesem Browser) und signiert jede
//     Anfrage. Nur Schlüssel, die du per "wrangler secret put
//     ADMIN_DEVICE_KEYS" freigegeben hast, werden akzeptiert.

const ACCESS_CERT_TTL_MS = 10 * 60 * 1000;
const SIG_MAX_SKEW_MS = 60 * 1000;
export const ADMIN_TOKEN_TTL_SEC = 30 * 60;

const enc = new TextEncoder();

export function b64urlToBytes(str) {
  const b64 = String(str).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(str).length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export function bytesToB64url(buf) {
  let bin = "";
  new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function sha256Hex(text) {
  const h = await crypto.subtle.digest("SHA-256", typeof text === "string" ? enc.encode(text) : text);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- 1) Cloudflare Access ----------

let certCache = null; // { keys, at }

async function accessKeys(env, force) {
  if (!force && certCache && Date.now() - certCache.at < ACCESS_CERT_TTL_MS) return certCache.keys;
  const resp = await fetch("https://" + env.ACCESS_TEAM_DOMAIN + "/cdn-cgi/access/certs");
  if (!resp.ok) throw new Error("Access-Zertifikate nicht ladbar: " + resp.status);
  const data = await resp.json();
  certCache = { keys: data.keys || [], at: Date.now() };
  return certCache.keys;
}

// Gibt die E-Mail zurück, wenn das Access-JWT echt ist und dir gehört, sonst null
export async function verifyAccess(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch (e) { return null; }
  if (header.alg !== "RS256") return null;

  let keys = await accessKeys(env, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) { keys = await accessKeys(env, true); jwk = keys.find(k => k.kid === header.kid); }
  if (!jwk) return null;
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) return null;

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.iss !== "https://" + env.ACCESS_TEAM_DOMAIN) return null;
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) return null;
  const email = String(payload.email || "").toLowerCase();
  if (!email || email !== String(env.ADMIN_EMAIL).trim().toLowerCase()) return null;
  return email;
}

// ---------- 3) Browser-Schlüssel ----------

// Fingerabdruck eines öffentlichen Schlüssels (RFC 7638) = Geräte-ID
export async function jwkThumbprint(jwk) {
  const canon = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  return bytesToB64url(await crypto.subtle.digest("SHA-256", enc.encode(canon)));
}

async function allowedDevices(env) {
  let list;
  try { list = JSON.parse(env.ADMIN_DEVICE_KEYS || "[]"); } catch (e) { return []; }
  if (!Array.isArray(list)) list = [list];
  const out = [];
  for (const k of list) {
    if (k && k.kty === "EC" && k.crv === "P-256" && k.x && k.y) out.push({ id: await jwkThumbprint(k), jwk: k });
  }
  return out;
}

const seenNonces = new Map(); // nonce -> Ablaufzeit (pro Worker-Instanz, gegen Wiederholung)

function rememberNonce(nonce) {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp < now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, now + 2 * SIG_MAX_SKEW_MS);
  return true;
}

// Prüft die Geräte-Signatur. Ergebnis: { ok, device, known, reason }
export async function verifyDevice(request, path, bodyText, env) {
  const device = request.headers.get("X-Admin-Device") || "";
  const ts = Number(request.headers.get("X-Admin-Ts"));
  const nonce = request.headers.get("X-Admin-Nonce") || "";
  const sig = request.headers.get("X-Admin-Sig") || "";
  if (!device || !nonce || !sig || !Number.isFinite(ts)) return { ok: false, reason: "no_signature" };
  if (Math.abs(Date.now() - ts) > SIG_MAX_SKEW_MS) return { ok: false, reason: "clock_skew" };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return { ok: false, reason: "bad_nonce" };

  const entry = (await allowedDevices(env)).find(d => d.id === device);
  if (!entry) return { ok: false, device, known: false, reason: "unknown_device" };

  const key = await crypto.subtle.importKey("jwk", entry.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const msg = [request.method, path, ts, nonce, await sha256Hex(bodyText)].join("\n");
  let ok = false;
  try { ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64urlToBytes(sig), enc.encode(msg)); }
  catch (e) { ok = false; }
  if (!ok) return { ok: false, device, known: true, reason: "bad_signature" };
  if (!rememberNonce(nonce)) return { ok: false, device, known: true, reason: "replay" };
  return { ok: true, device, known: true };
}

// ---------- 2) Admin-Token (nach Spielkonto-Login) ----------

async function hmac(secret, usage) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

export async function signAdminToken(payload, env) {
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmac(env.ADMIN_SECRET, "sign"), enc.encode(body));
  return body + "." + bytesToB64url(sig);
}

// Gültig nur für deine UID, dieses Gerät und dieselbe Access-E-Mail
export async function verifyAdminToken(token, env, device, email) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const ok = await crypto.subtle.verify("HMAC", await hmac(env.ADMIN_SECRET, "verify"), b64urlToBytes(parts[1]), enc.encode(parts[0]));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    if (!p || p.exp < Math.floor(Date.now() / 1000)) return null;
    if (!timingSafeEqual(p.uid, env.ADMIN_UID) || p.dev !== device || p.email !== email) return null;
    return p;
  } catch (e) { return null; }
}

export function configMissing(env) {
  const need = ["FIREBASE_DB_URL", "FIREBASE_SERVICE_ACCOUNT_KEY", "ADMIN_SECRET", "ADMIN_UID",
                "ADMIN_EMAIL", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"];
  const missing = need.filter(k => !env[k]);
  if (!env.GAME) missing.push("GAME (Service Binding)");
  if (env.ADMIN_SECRET && String(env.ADMIN_SECRET).length < 32) missing.push("ADMIN_SECRET (zu kurz)");
  return missing;
}
