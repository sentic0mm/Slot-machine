// Vertrauenswürdiger Schreib-Endpunkt für die "Weltweite Rangliste" von
// "gamblen ist toll". Grund: die Firebase-DB-Regeln allein können keine
// echte Prüfung durchführen (keine Krypto-Funktionen, kein Passwort-Check) -
// das kann nur Code, der ein Geheimnis besitzt. Dieser Worker ist dieser Code.
//
// Ablauf:
//   1) POST /login   { uid, pass } -> prüft das Passwort GENAU EINMAL gegen
//      die Datenbank (wie der bisherige Login), gibt bei Erfolg ein
//      signiertes Session-Token zurück (HMAC, Geheimnis kennt nur der Worker).
//   2) POST /leaderboard  { token, name, handle, playtime?, money? } ->
//      prüft das Token, prüft die Werte (wie vorher die DB-Regeln: playtime
//      nur steigend + max. +120 pro Schreibvorgang, money >= 0, Längen),
//      und schreibt danach MIT ADMIN-RECHTEN nach leaderboard/<uid> - an den
//      (jetzt für Clients gesperrten) DB-Regeln vorbei.
//
// Warum nicht einfach den in der DB gespeicherten passHash vergleichen?
// users/<uid> (inkl. passHash) ist laut DB-Regeln öffentlich lesbar - jeder
// könnte den Hash direkt auslesen und als "Beweis" vorzeigen. Deshalb prüft
// dieser Worker das Passwort selbst und stellt ein eigenes, nur ihm bekanntes
// Token aus.

const TOKEN_TTL_SEC = 12 * 60 * 60;      // Session-Token 12h gültig
const LB_PLAYTIME_MAX_DELTA = 120;       // wie zuvor in database.rules.json
const NAME_MAX = 40;
const HANDLE_MAX = 20;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = isAllowedOrigin(origin, env);

    if (request.method === "OPTIONS") {
      return corsResponse(new Response(null, { status: 204 }), origin, allowed);
    }

    try {
      let resp;
      if (request.method === "POST" && url.pathname === "/login") {
        resp = await handleLogin(request, env);
      } else if (request.method === "POST" && url.pathname === "/leaderboard") {
        resp = await handleLeaderboardWrite(request, env);
      } else {
        resp = jsonResponse({ ok: false, error: "not_found" }, 404);
      }
      return corsResponse(resp, origin, allowed);
    } catch (err) {
      return corsResponse(
        jsonResponse({ ok: false, error: "server_error", detail: String(err && err.message || err) }, 500),
        origin, allowed
      );
    }
  }
};

// ---------- Routen ----------

async function handleLogin(request, env) {
  const body = await readJson(request);
  const uid = typeof body.uid === "string" ? body.uid : "";
  const pass = typeof body.pass === "string" ? body.pass : "";
  if (!uid || !pass) return jsonResponse({ ok: false, error: "missing_fields" }, 400);

  const user = await fbGet(env, "users/" + encodeURIComponent(uid) + ".json");
  if (!user) return jsonResponse({ ok: false, error: "invalid_login" }, 401);

  const expected = await sha256("slotm:" + uid + ":" + pass);
  if (expected !== user.passHash) return jsonResponse({ ok: false, error: "invalid_login" }, 401);

  const now = Math.floor(Date.now() / 1000);
  const token = await signToken({ uid, exp: now + TOKEN_TTL_SEC }, env.WORKER_SECRET);
  return jsonResponse({ ok: true, token, exp: now + TOKEN_TTL_SEC });
}

async function handleLeaderboardWrite(request, env) {
  const body = await readJson(request);
  const payload = await verifyToken(body.token, env.WORKER_SECRET);
  if (!payload) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
  const uid = payload.uid;

  const update = {};

  if (typeof body.name === "string") {
    if (body.name.length > NAME_MAX) return jsonResponse({ ok: false, error: "name_too_long" }, 400);
    update.name = body.name;
  }
  if (typeof body.handle === "string") {
    if (body.handle.length > HANDLE_MAX) return jsonResponse({ ok: false, error: "handle_too_long" }, 400);
    update.handle = body.handle;
  }

  if (body.playtimeIncrement !== undefined) {
    // Inkrement statt absolutem Wert - so zählen mehrere gleichzeitig
    // aktive Geräte korrekt zusammen (wie vorher ServerValue.increment()).
    const inc = Number(body.playtimeIncrement);
    if (!Number.isFinite(inc) || inc < 0 || inc > LB_PLAYTIME_MAX_DELTA) {
      return jsonResponse({ ok: false, error: "bad_playtime_delta" }, 400);
    }
    const current = await fbGet(env, "leaderboard/" + encodeURIComponent(uid) + "/playtime.json");
    update.playtime = (Number(current) || 0) + inc;
  }

  if (body.money !== undefined) {
    const v = Number(body.money);
    if (!Number.isFinite(v) || v < 0) return jsonResponse({ ok: false, error: "bad_money" }, 400);
    update.money = v;
  }

  if (Object.keys(update).length === 0) {
    return jsonResponse({ ok: false, error: "nothing_to_write" }, 400);
  }

  update.updatedAt = { ".sv": "timestamp" };

  await fbPatch(env, "leaderboard/" + encodeURIComponent(uid) + ".json", update);
  return jsonResponse({ ok: true });
}

// ---------- Firebase REST (mit Service-Account-Admin-Zugriff) ----------

let cachedGoogleToken = null; // { token, exp } - lebt so lange der Worker-Isolate lebt

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.exp > now + 60) return cachedGoogleToken.token;

  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: sa.client_email,
    // userinfo.email zusätzlich zu firebase.database nötig, sonst lehnt die
    // RTDB-REST-API den Token mit 401 ab (bekannte Firebase-Eigenheit).
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const signingInput = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claim));
  const key = await importPrivateKey(sa.private_key);
  const sigBuf = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(signingInput)
  );
  const jwt = signingInput + "." + b64urlFromBuffer(sigBuf);

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    throw new Error("Google-OAuth fehlgeschlagen: " + JSON.stringify(data));
  }
  cachedGoogleToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedGoogleToken.token;
}

async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", raw.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
}

async function fbGet(env, path) {
  const token = await getGoogleAccessToken(env);
  const resp = await fetch(env.FIREBASE_DB_URL + "/" + path, {
    headers: { Authorization: "Bearer " + token }
  });
  if (!resp.ok) throw new Error("Firebase GET " + path + " fehlgeschlagen: " + resp.status);
  return resp.json();
}

async function fbPatch(env, path, data) {
  const token = await getGoogleAccessToken(env);
  const resp = await fetch(env.FIREBASE_DB_URL + "/" + path, {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(data)
  });
  if (!resp.ok) throw new Error("Firebase PATCH " + path + " fehlgeschlagen: " + resp.status + " " + await resp.text());
  return resp.json();
}

// ---------- Eigenes Session-Token (HMAC-SHA256, WORKER_SECRET) ----------

async function signToken(payload, secret) {
  const encPayload = b64url(JSON.stringify(payload));
  const key = await hmacKey(secret, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encPayload));
  return encPayload + "." + b64urlFromBuffer(sig);
}

async function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encPayload, encSig] = parts;
  try {
    const key = await hmacKey(secret, ["verify"]);
    const sigBuf = b64urlToBuffer(encSig);
    const ok = await crypto.subtle.verify("HMAC", key, sigBuf, new TextEncoder().encode(encPayload));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBuffer(encPayload)));
    if (!payload || typeof payload.exp !== "number") return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function hmacKey(secret, usages) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages
  );
}

// ---------- Kleinkram ----------

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromBuffer(buf) {
  let bin = "";
  new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuffer(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

async function readJson(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

function isAllowedOrigin(origin, env) {
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(origin);
}

function corsResponse(resp, origin, allowed) {
  if (allowed) {
    resp.headers.set("Access-Control-Allow-Origin", origin);
    resp.headers.set("Vary", "Origin");
  }
  resp.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return resp;
}
