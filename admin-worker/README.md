# Admin-Panel (nur für dich)

Eigener Cloudflare-Worker mit einer Admin-Seite: Spieler per **@Name,
Nickname oder UID** suchen und ihnen Geld geben (oder den Stand setzen) –
im **Solo-Online-Modus** (Klassisch / MultiGrid / UltraGrid) oder in einer
**laufenden Multiplayer-Runde**.

- **Live an:** Der Spieler sieht es sofort („🎁 Geschenk vom Admin …“),
  sein Kontostand springt um. Lobby-Geld sehen auch die Mitspieler live.
- **Live aus (still):** Das Geld ist trotzdem sofort gebucht, der Spieler
  merkt es erst beim nächsten Laden oder Spin.
- Die Detailansicht im Panel lädt alle 4 s neu (Kontostände, online/offline,
  Lobbys).

## Wer reinkommt – drei Schlösser, alle müssen passen

1. **Cloudflare Access:** Cloudflare lässt nur deine E-Mail-Adresse durch
   (Einmal-Code per Mail). Der Worker prüft das Access-Ticket zusätzlich
   selbst – ist Access aus Versehen aus, bleibt die Seite trotzdem zu.
2. **Browser-Prüfung:** Dein Browser erzeugt einen eigenen Schlüssel, der ihn
   nie verlässt (nicht exportierbar). Jede Anfrage wird damit signiert. Nur
   Browser, die du per `wrangler secret put` freigegeben hast, kommen weiter.
   Wer deinen Cloudflare-Login hätte, aber nicht deinen Browser, kommt nicht rein.
3. **Spielkonto:** Login mit deinem @Namen + Passwort. Die UID muss genau
   `ADMIN_UID` sein. Danach gilt die Anmeldung 30 Minuten, nur in diesem
   Browser. Nach 5 Fehlversuchen sperrt der Spiel-Worker das Konto 15 Min.

Jede Geld-Änderung steht in den Worker-Logs (Dashboard → slotmachine-admin →
Observability): wer, wem, wie viel, neuer Stand.

## Einrichtung (einmalig)

Voraussetzung: Der Spiel-Worker `slotmachine-leaderboard` läuft schon im
selben Cloudflare-Konto (der Admin-Worker meldet dich intern darüber an).

### 1. Installieren
```bash
cd admin-worker
npm install
npx wrangler login
```

### 2. Geheimnisse setzen
```bash
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT_KEY   # dieselbe JSON wie beim Spiel-Worker
npx wrangler secret put ADMIN_SECRET                   # neues Zufalls-Geheimnis, s.u.
npx wrangler secret put ADMIN_UID                      # deine Spieler-UID (steht im Spiel-Menü hinter deinem @Namen)
npx wrangler secret put ADMIN_EMAIL                    # deine E-Mail für den Cloudflare-Login
```
`ADMIN_SECRET` erzeugen (mind. 32 Zeichen, NICHT dasselbe wie WORKER_SECRET):
```bash
node -e "console.log(crypto.randomBytes(32).toString('hex'))"
```

### 3. Deployen
```bash
npx wrangler deploy
```
Ergibt z. B. `https://slotmachine-admin.sentic0mm.workers.dev`. Die Seite
zeigt bis Schritt 5 nur „noch nicht eingerichtet“ – das ist richtig so.

### 4. Cloudflare Access einschalten
1. Dashboard → **Workers & Pages** → `slotmachine-admin` → **Settings** →
   **Domains & Routes** → bei `workers.dev` **„Cloudflare Access“ aktivieren**.
   (Falls du Zero Trust noch nie benutzt hast, führt dich Cloudflare einmal
   durch die Einrichtung inkl. Team-Name; der Free-Plan reicht.)
2. Auf **„Manage Cloudflare Access“** → Policy bearbeiten:
   *Action* **Allow**, *Include* → **Emails** → nur deine Adresse.
   Alles andere entfernen.
3. Zwei Werte notieren:
   - **AUD-Tag:** Zero Trust → Access → Applications → die App → „Application
     Audience (AUD) Tag“
   - **Team-Domain:** Zero Trust → Settings → „Team domain“, z. B.
     `deinname.cloudflareaccess.com`

### 5. Access-Werte eintragen
```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # z. B. deinname.cloudflareaccess.com (ohne https://)
npx wrangler secret put ACCESS_AUD           # der AUD-Tag
```

### 6. Deinen Browser freischalten
1. Admin-URL öffnen → Cloudflare schickt dir einen Code per Mail.
2. Die Seite zeigt „Browser freischalten“ mit einem Schlüssel `[{"kty":"EC",…}]`
   → **Kopieren**.
3. `npx wrangler secret put ADMIN_DEVICE_KEYS` → einfügen → Enter.
4. ~10 Sekunden warten, **„Neu prüfen“** → Login mit deinem Spielkonto.

**Weiteres Gerät** (z. B. Handy + PC): Schlüssel beider Geräte in eine Liste
packen, `[{…},{…}]`, und neu setzen – der Befehl ersetzt die alte Liste.
**Gerät verloren:** Schlüssel aus der Liste nehmen und neu setzen, fertig.
Browserdaten gelöscht oder privater Modus = neuer Schlüssel, also neu freigeben.

### 7. Spielseite aktualisieren
Die neue `index.html` (Live-Hinweis für Spieler) über GitHub Pages
veröffentlichen. Ohne sie wird das Geld trotzdem gebucht, nur eben „still“.

## Gut zu wissen
- **Multiplayer:** Geld geht nur in Runden, die gerade **laufen** – beim
  Rundenstart setzt der Server das Geld sowieso auf das Startgeld.
- **Laufende Spin-Serie im Solo:** Das Geschenk wird auch auf die noch nicht
  freigegebenen Spins aufgeschlagen, es geht also nicht verloren.
- **Rangliste:** Geschenktes Geld zählt erst in die „meistes Geld“-Rangliste,
  wenn der Spieler danach spielt (der Rekord wird nur bei Spins eingetragen).
- **Abziehen:** Bei „Dazugeben“ einen negativen Betrag eingeben. Unter 0 geht's nicht.
- Datenbank-Regeln müssen nicht geändert werden (der Worker schreibt mit dem
  Service-Account; der Live-Hinweis liegt unter `users/<uid>/adminGift`).
