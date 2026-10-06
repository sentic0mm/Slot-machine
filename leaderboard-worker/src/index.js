// Vertrauenswürdiger Schreib-Endpunkt für die "Weltweite Rangliste" von
// "gamblen ist toll". Grund: die Firebase-DB-Regeln allein können keine
// echte Prüfung durchführen (keine Krypto-Funktionen, kein Passwort-Check) -
// das kann nur Code, der ein Geheimnis besitzt. Dieser Worker ist dieser Code.
//
// Ablauf:
//   0) POST /register, /login, /reset, /recovery -> Accounts, siehe auth.js.
//      Login gibt ein signiertes Session-Token (HMAC, Geheimnis kennt nur der
//      Worker) für die Routen unten zurück, plus ein Firebase-Custom-Token,
//      mit dem sich die Seite bei Firebase Auth anmeldet.
//   2) POST /leaderboard  { token, name, handle, playtimeIncrement?, money? }
//      -> prüft das Token, prüft die Werte (playtime nur steigend + max.
//      +120 pro Schreibvorgang, money >= 0 und darf pro Schreibvorgang
//      höchstens das 1000-fache des bisherigen Werts sein - siehe
//      MONEY_GROWTH_FACTOR, blockt "Konsole auf, Fantasiezahl eintippen"),
//      und schreibt danach MIT ADMIN-RECHTEN nach leaderboard/<uid> - an den
//      (jetzt für Clients gesperrten) DB-Regeln vorbei. Das ist nur der
//      Rangliste-REKORD (höchster je erreichter Stand), nicht der aktuell
//      einsetzbare Kontostand - siehe walletSync unten.
//   3) POST /wallet  { token, mode, amount } -> der ECHTE, aktuell
//      einsetzbare Online-Kontostand (getrennt pro Modus: classic/mega/
//      ultra), damit derselbe Account auf einem zweiten Gerät denselben
//      Stand sieht statt bei 10$ neu zu starten. Verluste (amount sinkt)
//      immer erlaubt, Zuwächse mit derselben Zuwachsrate-Grenze wie money
//      oben. Landet in walletSync/<uid> - komplett gesperrt für Clients
//      (auch Lesen), nur über /login (liefert den Stand mit) und /wallet
//      erreichbar, da es (anders als die öffentliche Rangliste) niemand
//      sonst etwas angeht.
//
// Passwörter liegen nur noch als PBKDF2-Hash unter creds/<uid> (für Clients
// gesperrt). Der alte, öffentlich lesbare users/<uid>/passHash wird beim
// ersten Login automatisch umgezogen und gelöscht (siehe auth.js).

const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // Session-Token 30 Tage gültig - war
                                          // erst 12h, das lief bei längeren
                                          // Sessions einfach still ab (Client
                                          // prüfte nur "Token vorhanden?",
                                          // nicht "noch gültig?") und Sync
                                          // brach unbemerkt ab. Jetzt lang
                                          // genug, dass das praktisch nicht
                                          // mehr vorkommt - Client-seitig
                                          // trotzdem der Vollständigkeit
                                          // halber ergänzt (siehe index.html).
const LB_PLAYTIME_MAX_DELTA = 120;       // wie zuvor in database.rules.json
const NAME_MAX = 40;
const HANDLE_MAX = 20;
// Höchster Multiplikator im Spiel ist der Grid-Jackpot mit x500 (JACKPOT_MULT
// in index.html), Einsatz selbst ist unbegrenzt. x1000 lässt jedem echten
// Gewinn (auch mehrere Spins auf einmal) reichlich Luft, blockt aber
// "Konsole auf -> Fantasiezahl eintippen". MONEY_MIN_JUMP ist der Boden für
// kleine Kontostände, damit ein Sprung von z.B. 10$ auf einen ordentlichen
// vierstelligen Gewinn nicht am *1000 von quasi-Null scheitert.
const MONEY_GROWTH_FACTOR = 1000;
const MONEY_MIN_JUMP = 10000;
const WALLET_MODES = ["classic", "mega", "ultra"];
// Zeitfenster für die Zuwachs-Grenze: innerhalb von MONEY_WINDOW_SEC darf der
// Wert höchstens auf das MONEY_GROWTH_FACTOR-fache des Werts zu Fensterbeginn
// steigen. Vorher galt die Grenze PRO ANFRAGE - mit vier Anfragen in einer
// Schleife kam man so von 10$ auf 10^13$.
const MONEY_WINDOW_SEC = 60;
// Allererster Eintrag eines Accounts (noch kein Vorwert in der DB): vorher
// komplett unbegrenzt, jetzt höchstens das hier.
const FIRST_MONEY_MAX = 10000;
// Etwas Luft für Uhren-/Netzwerk-Schwankungen bei der Spielzeit.
const PLAYTIME_SLACK_SEC = 5;

// Prüft, ob ein Zuwachs von cur -> v plausibel ist (siehe MONEY_GROWTH_FACTOR
// oben). Verluste (v <= cur) sind hier immer erlaubt, nur Zuwächse werden
// begrenzt - genutzt sowohl für den Rangliste-Rekord als auch für den
// echten Kontostand-Sync.
function isMoneyJumpOk(base, v) {
  const maxAllowed = Math.max(base * MONEY_GROWTH_FACTOR, base + MONEY_MIN_JUMP);
  return v <= maxAllowed;
}

// Prüft einen neuen Geldwert gegen das Zeitfenster in guard[key] und
// aktualisiert das Fenster. cur = aktueller Wert in der DB (null = noch keiner).
// Gibt true zurück, wenn der Wert erlaubt ist.
function checkMoneyWindow(guard, key, cur, v, now) {
  if (cur === null) {
    if (v > FIRST_MONEY_MAX) return false;
    guard[key] = { start: now, base: v };
    return true;
  }
  if (v <= cur) return true; // Verluste immer ok, Fenster bleibt
  let win = guard[key];
  if (!win || typeof win.start !== "number" || now - win.start >= MONEY_WINDOW_SEC) {
    win = { start: now, base: cur };
  }
  if (!isMoneyJumpOk(win.base, v)) return false;
  guard[key] = win;
  return true;
}

import { makeAuthHandlers } from "./auth.js";

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
        resp = await auth.handleLogin(request, env);
      } else if (request.method === "POST" && url.pathname === "/register") {
        resp = await auth.handleRegister(request, env);
      } else if (request.method === "POST" && url.pathname === "/reset") {
        resp = await auth.handleReset(request, env);
      } else if (request.method === "POST" && url.pathname === "/recovery") {
        resp = await auth.handleRecovery(request, env);
      } else if (request.method === "POST" && url.pathname === "/leaderboard") {
        resp = await handleLeaderboardWrite(request, env);
      } else if (request.method === "POST" && url.pathname === "/wallet") {
        resp = await handleWalletSync(request, env);
      } else {
        resp = jsonResponse({ ok: false, error: "not_found" }, 404);
      }
      return corsResponse(resp, origin, allowed);
    } catch (err) {
      console.error("Unerwarteter Fehler: " + String(err && err.message || err));
      return corsResponse(
        jsonResponse({ ok: false, error: "server_error" }, 500),
        origin, allowed
      );
    }
  }
};

// ---------- Routen ----------

async function handleLeaderboardWrite(request, env) {
  const body = await readJson(request);
  const payload = await verifyToken(body.token, env.WORKER_SECRET);
  if (!payload) {
    console.log("leaderboard: Token ungueltig oder abgelaufen abgelehnt");
    return jsonResponse({ ok: false, error: "invalid_token" }, 401);
  }
  const uid = payload.uid;
  const now = Math.floor(Date.now() / 1000);
  const { guard, etag: guardEtag } = await loadGuard(env, uid);

  const update = {};

  if (typeof body.name === "string") {
    if (body.name.length > NAME_MAX) {
      console.log("leaderboard " + uid + ": name zu lang abgelehnt (" + body.name.length + " Zeichen)");
      return jsonResponse({ ok: false, error: "name_too_long" }, 400);
    }
    update.name = body.name;
  }
  if (typeof body.handle === "string") {
    if (body.handle.length > HANDLE_MAX) {
      console.log("leaderboard " + uid + ": handle zu lang abgelehnt (" + body.handle.length + " Zeichen)");
      return jsonResponse({ ok: false, error: "handle_too_long" }, 400);
    }
    update.handle = body.handle;
  }

  if (body.playtimeIncrement !== undefined) {
    // Inkrement statt absolutem Wert - so zählen mehrere gleichzeitig
    // aktive Geräte korrekt zusammen (wie vorher ServerValue.increment()).
    const inc = Number(body.playtimeIncrement);
    if (!Number.isFinite(inc) || inc < 0 || inc > LB_PLAYTIME_MAX_DELTA) {
      console.log("leaderboard " + uid + ": playtimeIncrement abgelehnt (Wert: " + body.playtimeIncrement + ", erlaubt 0-" + LB_PLAYTIME_MAX_DELTA + ")");
      return jsonResponse({ ok: false, error: "bad_playtime_delta" }, 400);
    }
    // Tempolimit: nie mehr Spielzeit gutschreiben als seit dem letzten
    // Schreibvorgang wirklich vergangen ist (vorher: beliebig viele
    // Anfragen à 120s hintereinander = unbegrenzte Spielzeit).
    const allowed = typeof guard.pt === "number"
      ? Math.max(0, Math.min(LB_PLAYTIME_MAX_DELTA, now - guard.pt + PLAYTIME_SLACK_SEC))
      : LB_PLAYTIME_MAX_DELTA;
    const credited = Math.min(inc, allowed);
    guard.pt = now;
    const current = await fbGet(env, "leaderboard/" + encodeURIComponent(uid) + "/playtime.json");
    update.playtime = (Number(current) || 0) + credited;
    console.log("leaderboard " + uid + ": playtime " + (Number(current) || 0) + " + " + credited + " (angefragt " + inc + ") = " + update.playtime);
  }

  if (body.money !== undefined) {
    const v = Number(body.money);
    if (!Number.isFinite(v) || v < 0) {
      console.log("leaderboard " + uid + ": money abgelehnt (Wert: " + body.money + ", muss >= 0 sein)");
      return jsonResponse({ ok: false, error: "bad_money" }, 400);
    }
    // Zuwachsrate pro Zeitfenster begrenzen, siehe checkMoneyWindow.
    const currentRaw = await fbGet(env, "leaderboard/" + encodeURIComponent(uid) + "/money.json");
    const cur = currentRaw === null ? null : (Number(currentRaw) || 0);
    if (!checkMoneyWindow(guard, "lb", cur, v, now)) {
      console.log("leaderboard " + uid + ": money-Sprung abgelehnt (" + cur + " -> " + v + ")");
      return jsonResponse({ ok: false, error: "bad_money_jump" }, 400);
    }
    update.money = v;
    console.log("leaderboard " + uid + ": money = " + v);
  }

  if (Object.keys(update).length === 0) {
    console.log("leaderboard " + uid + ": Anfrage ohne verwertbare Felder abgelehnt");
    return jsonResponse({ ok: false, error: "nothing_to_write" }, 400);
  }

  update.updatedAt = { ".sv": "timestamp" };

  // Guard zuerst atomar speichern - parallele Anfragen (um das Limit mit
  // vielen gleichzeitigen Requests zu umgehen) scheitern hier am ETag.
  if (!await saveGuard(env, uid, guard, guardEtag)) {
    console.log("leaderboard " + uid + ": parallele Anfrage abgelehnt");
    return jsonResponse({ ok: false, error: "busy" }, 429);
  }
  await fbPatch(env, "leaderboard/" + encodeURIComponent(uid) + ".json", update);
  console.log("leaderboard " + uid + ": erfolgreich geschrieben (" + Object.keys(update).filter(k => k !== "updatedAt").join(", ") + ")");
  return jsonResponse({ ok: true });
}

// Echter, aktuell einsetzbarer Kontostand pro Modus - nicht der öffentliche
// Rangliste-Rekord. Verluste immer erlaubt, Zuwächse mit derselben
// Zuwachsrate-Grenze wie beim Rangliste-Geld.
async function handleWalletSync(request, env) {
  const body = await readJson(request);
  const payload = await verifyToken(body.token, env.WORKER_SECRET);
  if (!payload) {
    console.log("wallet: Token ungueltig oder abgelaufen abgelehnt");
    return jsonResponse({ ok: false, error: "invalid_token" }, 401);
  }
  const uid = payload.uid;

  const mode = body.mode;
  if (!WALLET_MODES.includes(mode)) {
    console.log("wallet " + uid + ": unbekannter Modus abgelehnt (" + body.mode + ")");
    return jsonResponse({ ok: false, error: "bad_mode" }, 400);
  }

  const v = Number(body.amount);
  if (!Number.isFinite(v) || v < 0) {
    console.log("wallet " + uid + "/" + mode + ": Betrag abgelehnt (Wert: " + body.amount + ", muss >= 0 sein)");
    return jsonResponse({ ok: false, error: "bad_amount" }, 400);
  }

  const now = Math.floor(Date.now() / 1000);
  const { guard, etag: guardEtag } = await loadGuard(env, uid);
  const currentRaw = await fbGet(env, "walletSync/" + encodeURIComponent(uid) + "/" + mode + ".json");
  const cur = currentRaw === null ? null : (Number(currentRaw) || 0);
  if (!checkMoneyWindow(guard, "w_" + mode, cur, v, now)) {
    console.log("wallet " + uid + "/" + mode + ": Sprung abgelehnt (" + cur + " -> " + v + ")");
    return jsonResponse({ ok: false, error: "bad_wallet_jump" }, 400);
  }
  if (!await saveGuard(env, uid, guard, guardEtag)) {
    console.log("wallet " + uid + "/" + mode + ": parallele Anfrage abgelehnt");
    return jsonResponse({ ok: false, error: "busy" }, 429);
  }

  const update = {};
  update[mode] = v;
  update.updatedAt = { ".sv": "timestamp" };
  await fbPatch(env, "walletSync/" + encodeURIComponent(uid) + ".json", update);
  console.log("wallet " + uid + "/" + mode + ": erfolgreich gespeichert (" + v + ")");
  return jsonResponse({ ok: true });
}

// ---------- Firebase REST (mit Service-Account-Admin-Zugriff) ----------

let cachedGoogleToken = null; // { token, exp } - lebt so lange der Worker-Isolate lebt

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.exp > now + 60) return cachedGoogleToken.token;

  const sa = getServiceAccount(env);
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

// ---------- Guard (Limit-Zustand pro Account) ----------
// Liegt unter lbGuard/<uid> - muss in den DB-Regeln für Clients komplett
// gesperrt sein (Lesen + Schreiben), nur der Worker (Admin) greift darauf zu.
// Gespeichert wird per ETag-Bedingung (if-match), damit zwei gleichzeitige
// Anfragen nicht beide denselben alten Stand sehen und das Limit umgehen.

async function loadGuard(env, uid) {
  const token = await getGoogleAccessToken(env);
  const resp = await fetch(env.FIREBASE_DB_URL + "/lbGuard/" + encodeURIComponent(uid) + ".json", {
    headers: { Authorization: "Bearer " + token, "X-Firebase-ETag": "true" }
  });
  if (!resp.ok) throw new Error("Firebase GET lbGuard fehlgeschlagen: " + resp.status);
  const data = await resp.json();
  return { guard: (data && typeof data === "object") ? data : {}, etag: resp.headers.get("ETag") };
}

async function saveGuard(env, uid, guard, etag) {
  const token = await getGoogleAccessToken(env);
  const resp = await fetch(env.FIREBASE_DB_URL + "/lbGuard/" + encodeURIComponent(uid) + ".json", {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", "if-match": etag || "" },
    body: JSON.stringify(guard)
  });
  if (resp.status === 412) return false;
  if (!resp.ok) throw new Error("Firebase PUT lbGuard fehlgeschlagen: " + resp.status);
  return true;
}

async function fbGet(env, path) {
  const token = await getGoogleAccessToken(env);
  const resp = await fetch(env.FIREBASE_DB_URL + "/" + path, {
    headers: { Authorization: "Bearer " + token }
  });
  if (!resp.ok) throw new Error("Firebase GET " + path + " fehlgeschlagen: " + resp.status);
  return resp.json();
}

function getServiceAccount(env) {
  return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY);
}

// GET mit ETag (für atomare Schreibvorgänge per if-match)
async function fbGetEtag(env, path) {
  const token = await getGoogleAccessToken(env);
  const resp = await fetch(env.FIREBASE_DB_URL + "/" + path, {
    headers: { Authorization: "Bearer " + token, "X-Firebase-ETag": "true" }
  });
  if (!resp.ok) throw new Error("Firebase GET " + path + " fehlgeschlagen: " + resp.status);
  return { value: await resp.json(), etag: resp.headers.get("ETag") };
}

// PUT; mit etag nur, wenn sich der Wert seitdem nicht geändert hat
// ("null_etag" = nur wenn noch nichts da ist). false = Bedingung verfehlt.
async function fbPut(env, path, data, etag) {
  const token = await getGoogleAccessToken(env);
  const headers = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  if (etag) headers["if-match"] = etag;
  const resp = await fetch(env.FIREBASE_DB_URL + "/" + path, { method: "PUT", headers, body: JSON.stringify(data) });
  if (resp.status === 412) return false;
  if (!resp.ok) throw new Error("Firebase PUT " + path + " fehlgeschlagen: " + resp.status);
  return true;
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

const auth = makeAuthHandlers({
  fbGet, fbGetEtag, fbPut, fbPatch, jsonResponse, readJson, signToken, verifyToken,
  sha256, getServiceAccount, b64url, b64urlFromBuffer, importPrivateKey, TOKEN_TTL_SEC
});
