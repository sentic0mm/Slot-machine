// Firebase-REST-Zugriff mit dem Service-Account (Admin-Rechte, DB-Regeln
// gelten hier nicht). Gleiches Vorgehen wie im leaderboard-worker.

let cachedGoogleToken = null; // { token, exp }

function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlFromBuffer(buf) {
  let bin = "";
  new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importPrivateKey(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", raw.buffer, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

async function getGoogleAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleToken && cachedGoogleToken.exp > now + 60) return cachedGoogleToken.token;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_KEY);
  const claim = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600
  };
  const input = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" })) + "." + b64url(JSON.stringify(claim));
  const key = await importPrivateKey(sa.private_key);
  const sig = await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, new TextEncoder().encode(input));
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + input + "." + b64urlFromBuffer(sig)
  });
  const data = await resp.json();
  if (!resp.ok || !data.access_token) throw new Error("Google-OAuth fehlgeschlagen");
  cachedGoogleToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return cachedGoogleToken.token;
}

export function makeFirebase(env) {
  const base = env.FIREBASE_DB_URL;
  async function headers(extra) {
    return Object.assign({ Authorization: "Bearer " + await getGoogleAccessToken(env) }, extra || {});
  }
  return {
    async get(path) {
      const resp = await fetch(base + "/" + path, { headers: await headers() });
      if (!resp.ok) throw new Error("Firebase GET " + path + ": " + resp.status);
      return resp.json();
    },
    async getEtag(path) {
      const resp = await fetch(base + "/" + path, { headers: await headers({ "X-Firebase-ETag": "true" }) });
      if (!resp.ok) throw new Error("Firebase GET " + path + ": " + resp.status);
      return { value: await resp.json(), etag: resp.headers.get("ETag") };
    },
    // false = ETag-Bedingung verfehlt (jemand hat gleichzeitig geschrieben)
    async put(path, data, etag) {
      const h = await headers({ "Content-Type": "application/json" });
      if (etag) h["if-match"] = etag;
      const resp = await fetch(base + "/" + path, { method: "PUT", headers: h, body: JSON.stringify(data) });
      if (resp.status === 412) return false;
      if (!resp.ok) throw new Error("Firebase PUT " + path + ": " + resp.status);
      return true;
    },
    async patch(path, data) {
      const resp = await fetch(base + "/" + path, {
        method: "PATCH", headers: await headers({ "Content-Type": "application/json" }), body: JSON.stringify(data)
      });
      if (!resp.ok) throw new Error("Firebase PATCH " + path + ": " + resp.status);
      return resp.json();
    }
  };
}
