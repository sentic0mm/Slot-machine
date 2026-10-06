// Accounts: Registrierung, Login, Passwort-Reset und Wiederherstellungs-Code.
//
// Vorher lief das komplett im Browser: der Passwort-Hash lag öffentlich
// lesbar unter users/<uid>/passHash, und Firebase wusste nie, WER gerade
// schreibt - jeder konnte im Namen jedes Accounts Freunde, Blocks, Lobbys
// usw. ändern. Jetzt:
//   - Passwörter liegen als PBKDF2-Hash unter creds/<uid> (für Clients
//     komplett gesperrt, nur der Worker liest/schreibt dort).
//   - Nach erfolgreichem Login gibt der Worker ein Firebase-Custom-Token aus.
//     Die Seite meldet sich damit bei Firebase Auth an, und die DB-Regeln
//     können überall "auth.uid === $uid" prüfen.
//   - Falsche Passwörter werden gezählt: nach LOGIN_MAX_FAILS Fehlversuchen
//     ist der Account LOGIN_LOCK_SEC lang gesperrt.
//   - Alte Accounts (passHash noch in users/<uid>) werden beim ersten
//     erfolgreichen Login automatisch umgezogen, der öffentliche Hash wird
//     dabei gelöscht.
//
// DB-Struktur (nur Worker/Admin):
//   creds/<uid>     { hash | legacyHash, recoveryTrusted?, fails?, lockUntil? }
//   recovery/<uid>  Wiederherstellungs-Code im Klartext (wie bisher, damit der
//                   Support Beweise in Anfragen prüfen kann)
//   counters/users, handles/<name>  werden nur noch hier geschrieben
//   ipGuard/<hash>  Registrierungs-Limit pro IP
//   banned/<uid>    vom Betreiber gebannt (Admin-Panel): kein Login, kein Spin

const PBKDF2_ITERATIONS = 10000; // Cloudflare Free-Plan hat ~10 ms CPU pro
                                  // Anfrage; höher geht, falls Fehler 1102
                                  // ("CPU limit") nie auftaucht.
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_SEC = 15 * 60;
const REG_PER_IP_PER_HOUR = 5;
const PASS_MIN = 8;          // neue Passwörter; alte (ab 4) gehen beim Login weiter
const PASS_MAX = 64;
const HANDLE_RE = /^[A-Za-z0-9_]{3,16}$/;
const NICK_RE = /^[A-Za-z0-9_ ]{3,16}$/;
const RECOVERY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

import { effectiveBalances } from "./spin.js";

export function makeAuthHandlers(deps) {
  const { fbGet, fbGetEtag, fbPut, fbPatch, jsonResponse, readJson, signToken, verifyToken,
          sha256, getServiceAccount, b64url, b64urlFromBuffer, importPrivateKey, TOKEN_TTL_SEC } = deps;

  const enc = (s) => encodeURIComponent(s);
  const nowSec = () => Math.floor(Date.now() / 1000);

  // ---------- Passwort-Hash ----------
  async function pbkdf2(pass, saltBytes, iterations) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations }, key, 256);
    return new Uint8Array(bits);
  }
  async function hashPassword(pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const h = await pbkdf2(pass, salt, PBKDF2_ITERATIONS);
    return "pbkdf2$" + PBKDF2_ITERATIONS + "$" + b64urlFromBuffer(salt) + "$" + b64urlFromBuffer(h);
  }
  async function verifyPassword(pass, stored) {
    const parts = String(stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = Number(parts[1]);
    const salt = b64urlBytes(parts[2]);
    const h = await pbkdf2(pass, salt, iterations);
    return timingSafeEqual(b64urlFromBuffer(h), parts[3]);
  }
  function b64urlBytes(s) {
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  }
  function timingSafeEqual(a, b) {
    a = String(a); b = String(b);
    let diff = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    return diff === 0;
  }

  // ---------- Firebase Custom Token ----------
  async function firebaseCustomToken(env, uid) {
    const sa = getServiceAccount(env);
    const iat = nowSec();
    const header = { alg: "RS256", typ: "JWT" };
    const claim = {
      iss: sa.client_email, sub: sa.client_email,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit",
      iat, exp: iat + 3600, uid
    };
    const input = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(claim));
    const key = await importPrivateKey(sa.private_key);
    const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(input));
    return input + "." + b64urlFromBuffer(sig);
  }

  // Alles, was der Client nach Login/Registrierung/Reset braucht
  async function sessionResponse(env, uid, user, creds, extra) {
    const exp = nowSec() + TOKEN_TTL_SEC;
    const token = await signToken({ uid, exp }, env.WORKER_SECRET);
    let wallet = null;
    try { wallet = await fbGet(env, "walletSync/" + enc(uid) + ".json"); } catch (e) {}
    const w = effectiveBalances(wallet || {}, Date.now());
    return jsonResponse(Object.assign({
      ok: true, uid,
      handle: user.handle, nick: user.nick || null,
      hasRecovery: !!(creds && creds.recoveryTrusted), joinPref: user.joinPref || "ask",
      token, exp, wallet: w,
      firebaseToken: await firebaseCustomToken(env, uid)
    }, extra || {}));
  }

  function newRecoveryCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    let c = "";
    for (const b of bytes) c += RECOVERY_CHARS[b % RECOVERY_CHARS.length];
    return c.slice(0, 4) + "-" + c.slice(4, 8) + "-" + c.slice(8, 12);
  }
  const normCode = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  async function resolveUid(env, body) {
    if (typeof body.uid === "string" && body.uid) return body.uid; // ältere Clients
    const handle = typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "").toLowerCase() : "";
    if (!HANDLE_RE.test(handle)) return null;
    return await fbGet(env, "handles/" + enc(handle) + ".json");
  }

  // Sperre nach zu vielen Fehlversuchen
  function lockedFor(creds) {
    const until = Number(creds && creds.lockUntil) || 0;
    return until > nowSec() ? until - nowSec() : 0;
  }
  async function noteFail(env, uid, creds) {
    const fails = (Number(creds && creds.fails) || 0) + 1;
    const patch = { fails };
    if (fails >= LOGIN_MAX_FAILS) { patch.fails = 0; patch.lockUntil = nowSec() + LOGIN_LOCK_SEC; }
    await fbPatch(env, "creds/" + enc(uid) + ".json", patch);
  }

  async function clientIpKey(request) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    return (await sha256("ip:" + ip)).slice(0, 32);
  }

  // ---------- POST /register { handle, pass, nick? } ----------
  async function handleRegister(request, env) {
    const body = await readJson(request);
    const handle = typeof body.handle === "string" ? body.handle.trim().replace(/^@/, "") : "";
    const pass = typeof body.pass === "string" ? body.pass : "";
    let nick = typeof body.nick === "string" ? body.nick.trim() : "";
    if (!HANDLE_RE.test(handle)) return jsonResponse({ ok: false, error: "bad_handle" }, 400);
    if (pass.length < PASS_MIN || pass.length > PASS_MAX) return jsonResponse({ ok: false, error: "bad_password", min: PASS_MIN }, 400);
    if (nick && !NICK_RE.test(nick)) return jsonResponse({ ok: false, error: "bad_nick" }, 400);
    if (nick.toLowerCase() === handle.toLowerCase()) nick = "";
    const lower = handle.toLowerCase();

    // Registrierungs-Limit pro IP (gegen Account-Spam)
    const ipKey = await clientIpKey(request);
    const hour = Math.floor(nowSec() / 3600);
    const ipg = await fbGet(env, "ipGuard/" + ipKey + ".json") || {};
    const count = ipg.hour === hour ? (Number(ipg.reg) || 0) : 0;
    if (count >= REG_PER_IP_PER_HOUR) return jsonResponse({ ok: false, error: "too_many_registrations" }, 429);
    await fbPut(env, "ipGuard/" + ipKey + ".json", { hour, reg: count + 1 });

    if (await fbGet(env, "handles/" + enc(lower) + ".json") !== null) {
      return jsonResponse({ ok: false, error: "handle_taken" }, 409);
    }

    // Fortlaufende uid (atomar per ETag)
    let uid = null;
    for (let i = 0; i < 8 && !uid; i++) {
      const { value, etag } = await fbGetEtag(env, "counters/users.json");
      const next = (Number(value) || 0) + 1;
      if (await fbPut(env, "counters/users.json", next, etag)) uid = "u" + next;
    }
    if (!uid) return jsonResponse({ ok: false, error: "busy" }, 429);

    // Namen reservieren - nur wenn er noch nicht existiert (null_etag)
    if (!await fbPut(env, "handles/" + enc(lower) + ".json", uid, "null_etag")) {
      return jsonResponse({ ok: false, error: "handle_taken" }, 409);
    }

    const code = newRecoveryCode();
    const user = { handle, handleLower: lower, nick: nick || null, hasRecovery: true, createdAt: { ".sv": "timestamp" } };
    await fbPut(env, "creds/" + enc(uid) + ".json", { hash: await hashPassword(pass), recoveryTrusted: true });
    await fbPut(env, "recovery/" + enc(uid) + ".json", code);
    await fbPut(env, "users/" + enc(uid) + ".json", user);
    console.log("register " + uid + " (@" + handle + "): erfolgreich");
    return sessionResponse(env, uid, user, { recoveryTrusted: true }, { recoveryCode: code });
  }

  // ---------- POST /login { handle (oder uid), pass } ----------
  async function handleLogin(request, env) {
    const body = await readJson(request);
    const pass = typeof body.pass === "string" ? body.pass : "";
    if (!pass) return jsonResponse({ ok: false, error: "missing_fields" }, 400);
    const uid = await resolveUid(env, body);
    if (!uid) return jsonResponse({ ok: false, error: "unknown_handle" }, 404);

    const user = await fbGet(env, "users/" + enc(uid) + ".json");
    if (!user) return jsonResponse({ ok: false, error: "invalid_login" }, 401);
    if (await fbGet(env, "banned/" + enc(uid) + ".json")) return jsonResponse({ ok: false, error: "banned" }, 403);
    const creds = await fbGet(env, "creds/" + enc(uid) + ".json") || {};

    const wait = lockedFor(creds);
    if (wait) {
      console.log("login " + uid + ": gesperrt (noch " + wait + "s)");
      return jsonResponse({ ok: false, error: "locked", retryAfter: wait }, 429);
    }

    let ok = false;
    if (creds.hash) {
      ok = await verifyPassword(pass, creds.hash);
    } else if (creds.legacyHash || user.passHash) {
      // Alter Account: einmal gegen den alten Hash prüfen und umziehen.
      // legacyHash = vom Migrations-Skript schon aus users/ verschoben.
      ok = timingSafeEqual(await sha256("slotm:" + uid + ":" + pass), creds.legacyHash || user.passHash);
      if (ok) {
        await fbPatch(env, "creds/" + enc(uid) + ".json", { hash: await hashPassword(pass), legacyHash: null });
        await fbPatch(env, "users/" + enc(uid) + ".json", { passHash: null, hasPwEnc: null });
        console.log("login " + uid + ": alter Passwort-Hash umgezogen");
      }
    } else {
      // Kein Passwort hinterlegt (alter Support-Reset) -> nur noch per Code
      return jsonResponse({ ok: false, error: "reset_required" }, 409);
    }

    if (!ok) {
      await noteFail(env, uid, creds);
      console.log("login " + uid + ": falsches Passwort");
      return jsonResponse({ ok: false, error: "invalid_login" }, 401);
    }
    if (creds.fails || creds.lockUntil) await fbPatch(env, "creds/" + enc(uid) + ".json", { fails: null, lockUntil: null });
    console.log("login " + uid + ": erfolgreich");
    return sessionResponse(env, uid, user, creds);
  }

  // ---------- POST /reset { handle, code, newPass } ----------
  // Passwort vergessen: mit dem Wiederherstellungs-Code selbst zurücksetzen.
  // Nur Codes, die der Worker selbst erzeugt hat (recoveryTrusted), oder die
  // der Support nach Prüfung freigegeben hat (creds/<uid>/recoveryTrusted =
  // true von Hand setzen). Alte Codes konnte früher jeder für fremde
  // Accounts anlegen - die gelten deshalb nicht automatisch.
  async function handleReset(request, env) {
    const body = await readJson(request);
    const newPass = typeof body.newPass === "string" ? body.newPass : "";
    if (newPass.length < PASS_MIN || newPass.length > PASS_MAX) return jsonResponse({ ok: false, error: "bad_password", min: PASS_MIN }, 400);
    const uid = await resolveUid(env, body);
    if (!uid) return jsonResponse({ ok: false, error: "unknown_handle" }, 404);
    const user = await fbGet(env, "users/" + enc(uid) + ".json");
    if (!user) return jsonResponse({ ok: false, error: "invalid_code" }, 401);
    if (await fbGet(env, "banned/" + enc(uid) + ".json")) return jsonResponse({ ok: false, error: "banned" }, 403);
    const creds = await fbGet(env, "creds/" + enc(uid) + ".json") || {};

    const wait = lockedFor(creds);
    if (wait) return jsonResponse({ ok: false, error: "locked", retryAfter: wait }, 429);
    if (!creds.recoveryTrusted) return jsonResponse({ ok: false, error: "code_not_trusted" }, 403);

    const stored = await fbGet(env, "recovery/" + enc(uid) + ".json");
    if (!stored || !timingSafeEqual(normCode(stored), normCode(body.code))) {
      await noteFail(env, uid, creds);
      return jsonResponse({ ok: false, error: "invalid_code" }, 401);
    }
    await fbPatch(env, "creds/" + enc(uid) + ".json", { hash: await hashPassword(newPass), legacyHash: null, fails: null, lockUntil: null });
    if (user.passHash) await fbPatch(env, "users/" + enc(uid) + ".json", { passHash: null, hasPwEnc: null });
    console.log("reset " + uid + ": Passwort per Code neu gesetzt");
    return sessionResponse(env, uid, user, creds);
  }

  // ---------- POST /recovery { token } ----------
  // Neuen (vertrauenswürdigen) Code für einen eingeloggten Account erzeugen,
  // z.B. für alte Accounts. Ersetzt einen alten, nicht geprüften Code.
  async function handleRecovery(request, env) {
    const body = await readJson(request);
    const payload = await verifyToken(body.token, env.WORKER_SECRET);
    if (!payload) return jsonResponse({ ok: false, error: "invalid_token" }, 401);
    const uid = payload.uid;
    const creds = await fbGet(env, "creds/" + enc(uid) + ".json") || {};
    if (creds.recoveryTrusted) return jsonResponse({ ok: false, error: "already_has_code" }, 409);
    const code = newRecoveryCode();
    await fbPut(env, "recovery/" + enc(uid) + ".json", code);
    await fbPatch(env, "creds/" + enc(uid) + ".json", { recoveryTrusted: true });
    await fbPatch(env, "users/" + enc(uid) + ".json", { hasRecovery: true });
    console.log("recovery " + uid + ": neuer Code erstellt");
    return jsonResponse({ ok: true, recoveryCode: code });
  }

  return { handleRegister, handleLogin, handleReset, handleRecovery,
           _test: { hashPassword, verifyPassword } };
}
