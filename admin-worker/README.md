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

## Einrichtung (einmalig) – nur im Browser, kein Terminal

Voraussetzung: Der Spiel-Worker `slotmachine-leaderboard` läuft schon im
selben Cloudflare-Konto (der Admin-Worker meldet dich intern darüber an).
Hochgeladen wird der Admin-Worker von GitHub selbst
(`.github/workflows/deploy-admin.yml`).

### 1. Cloudflare-Zugang für GitHub
1. https://dash.cloudflare.com → oben rechts Profil → **My Profile** →
   **API Tokens** → **Create Token** → Vorlage **„Edit Cloudflare Workers“**
   → **Use template**. Bei *Account Resources* dein Konto wählen, bei *Zone
   Resources* „All zones“ lassen → **Continue to summary** → **Create Token**.
   Token kopieren (wird nur einmal angezeigt).
2. **Account ID:** Dashboard → **Workers & Pages** → rechts in der Seitenleiste
   „Account ID“ → kopieren.

### 2. In GitHub eintragen
Repo → **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**, zweimal:
- `CLOUDFLARE_API_TOKEN` = der Token
- `CLOUDFLARE_ACCOUNT_ID` = die Account ID

### 3. Hochladen
PR mergen. Danach lädt GitHub den Worker automatisch hoch (Tab **Actions** →
„Admin-Panel deployen“, grüner Haken = fertig). Später neu starten:
**Actions** → „Admin-Panel deployen“ → **Run workflow**.

Danach gibt es im Dashboard unter **Workers & Pages** einen zweiten Worker
`slotmachine-admin`. `ADMIN_SECRET` hat GitHub schon automatisch gesetzt.

### 4. Geheimnisse im Cloudflare-Dashboard eintragen
**Workers & Pages** → `slotmachine-admin` → **Settings** → **Variables and
Secrets** → **Add** → Typ **Secret**, für jeden Eintrag:

| Name | Wert |
|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Inhalt der Firebase-Schlüsseldatei (JSON). Neue Datei: Firebase-Konsole → Projekteinstellungen → Dienstkonten → „Neuen privaten Schlüssel generieren“ |
| `ADMIN_UID` | deine Spieler-UID (steht im Spiel-Menü hinter deinem @Namen) |
| `ADMIN_EMAIL` | deine E-Mail für den Cloudflare-Login |

**Deploy** / **Save** drücken. Die Seite zeigt bis Schritt 6 nur „noch nicht
eingerichtet“ – das ist richtig so.

### 5. Cloudflare Access einschalten
1. `slotmachine-admin` → **Settings** → **Domains & Routes** → bei
   `workers.dev` **„Cloudflare Access“ aktivieren**. (Beim ersten Mal führt
   Cloudflare dich durch Zero Trust inkl. Team-Name; Free-Plan reicht.)
2. **„Manage Cloudflare Access“** → Policy: *Action* **Allow**, *Include* →
   **Emails** → nur deine Adresse. Alles andere entfernen.
3. Zwei Werte notieren (https://one.dash.cloudflare.com):
   - **AUD-Tag:** Access → Applications → die App → „Application Audience (AUD) Tag“
   - **Team-Domain:** Settings → „Team domain“, z. B. `deinname.cloudflareaccess.com`

### 6. Access-Werte eintragen
Wie in Schritt 4 als **Secret**:
- `ACCESS_TEAM_DOMAIN` = z. B. `deinname.cloudflareaccess.com` (ohne https://)
- `ACCESS_AUD` = der AUD-Tag

### 7. Deinen Browser freischalten
1. https://slotmachine-admin.sentic0mm.workers.dev öffnen → Cloudflare
   schickt dir einen Code per Mail.
2. Die Seite zeigt „Browser freischalten“ mit einem Schlüssel `[{"kty":"EC",…}]`
   → **Kopieren**.
3. Wie in Schritt 4 als **Secret** `ADMIN_DEVICE_KEYS` eintragen → speichern.
4. ~10 Sekunden warten, **„Neu prüfen“** → Login mit deinem Spielkonto.

**Weiteres Gerät** (z. B. Handy + PC): Schlüssel beider Geräte in eine Liste
packen, `[{…},{…}]`, und den Secret-Wert ersetzen.
**Gerät verloren:** Schlüssel aus der Liste nehmen, speichern, fertig.
Browserdaten gelöscht oder privater Modus = neuer Schlüssel, also neu freigeben.

### Mit Terminal (falls doch mal vorhanden)
Statt Schritt 1–4 geht auch: `cd admin-worker && npm install && npx wrangler
login && npx wrangler deploy`, Secrets per `npx wrangler secret put NAME`.

## Gut zu wissen
- **Spielseite:** Mit dem Mergen des PR bekommt auch die Spielseite (GitHub
  Pages) die Live-Hinweise. Vorher wird das Geld trotzdem gebucht, nur „still“.
- **Multiplayer:** Geld geht nur in Runden, die gerade **laufen** – beim
  Rundenstart setzt der Server das Geld sowieso auf das Startgeld.
- **Laufende Spin-Serie im Solo:** Das Geschenk wird auch auf die noch nicht
  freigegebenen Spins aufgeschlagen, es geht also nicht verloren.
- **Rangliste:** Geschenktes Geld zählt erst in die „meistes Geld“-Rangliste,
  wenn der Spieler danach spielt (der Rekord wird nur bei Spins eingetragen).
- **Abziehen:** Bei „Dazugeben“ einen negativen Betrag eingeben. Unter 0 geht's nicht.
- Datenbank-Regeln müssen nicht geändert werden (der Worker schreibt mit dem
  Service-Account; der Live-Hinweis liegt unter `users/<uid>/adminGift`).
