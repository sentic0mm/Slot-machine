// Einmaliges Umzugs-Skript für das Sicherheits-Update.
//
// Verschiebt users/<uid>/passHash (öffentlich lesbar!) nach
// creds/<uid>/legacyHash (gesperrt) und löscht die alten Passwort-Kopien
// (pwenc, hasPwEnc). Danach liegt kein Passwort-Hash mehr öffentlich herum,
// auch nicht von Spielern, die sich nie wieder einloggen. Beim nächsten
// Login rechnet der Worker den alten Hash in PBKDF2 um.
//
// Ausführen (im Ordner leaderboard-worker):
//   node migrate.mjs pfad/zum/service-account.json          # nur anzeigen
//   node migrate.mjs pfad/zum/service-account.json --apply  # wirklich ändern
//
// Vorher ein Backup ziehen: Firebase-Konsole -> Realtime Database ->
// ⋮ -> "JSON exportieren".

import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const DB_URL = "https://slot-machine-multiplayer-default-rtdb.europe-west1.firebasedatabase.app";
const [, , saPath, flag] = process.argv;
if (!saPath) { console.error("Pfad zur Service-Account-JSON fehlt."); process.exit(1); }
const apply = flag === "--apply";
const sa = JSON.parse(readFileSync(saPath, "utf8"));

const b64url = (s) => Buffer.from(s).toString("base64url");
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const input = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify({
    iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email"
  }));
  const sig = createSign("RSA-SHA256").update(input).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + input + "." + sig
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("OAuth fehlgeschlagen: " + JSON.stringify(d));
  return d.access_token;
}

const token = await accessToken();
const db = async (path, method = "GET", body) => {
  const r = await fetch(DB_URL + "/" + path + ".json", {
    method, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!r.ok) throw new Error(method + " " + path + ": " + r.status + " " + await r.text());
  return r.json();
};

const users = await db("users") || {};
const creds = await db("creds") || {};
const multi = {};
let moved = 0;
for (const [uid, u] of Object.entries(users)) {
  if (u && u.passHash) {
    if (!(creds[uid] && creds[uid].hash)) multi["creds/" + uid + "/legacyHash"] = u.passHash;
    multi["users/" + uid + "/passHash"] = null;
    moved++;
  }
  if (u && u.hasPwEnc) multi["users/" + uid + "/hasPwEnc"] = null;
}
multi["pwenc"] = null;

console.log(users ? Object.keys(users).length : 0, "Accounts,", moved, "öffentliche Hashes zum Umziehen.");
console.log("Alte Passwort-Kopien (pwenc) werden gelöscht.");
if (!apply) { console.log("\nNur Vorschau. Mit --apply wirklich ausführen."); process.exit(0); }
await db("", "PATCH", multi);
console.log("Fertig.");
