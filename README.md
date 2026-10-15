# AppMint Server

Serveur de compilation : tu envoies l'URL d'un site, il te rend un **APK Android signé** (WebView plein écran, pull-to-refresh, upload de fichiers, page hors-ligne, liens externes dans le navigateur).

## Lancer avec Docker (recommandé)

Il te faut un serveur Linux (VPS 2 Go de RAM minimum, 4 Go conseillés) avec Docker.

```bash
echo "API_KEY=$(openssl rand -hex 24)" > .env
docker compose up -d --build
```

Le premier build de l'image télécharge le SDK Android (~10 min). Le premier APK est lent (téléchargement des dépendances Gradle), les suivants prennent 1 à 2 minutes.

**Sauvegarde le volume `/data`** : il contient le keystore de signature. Si tu le perds, les utilisateurs ne pourront plus mettre à jour leurs apps.

## Tester sans SDK Android (mode simulation)

```bash
npm install
DRY_RUN=1 node server.js
```

Génère le projet Android sans lancer Gradle (utile pour vérifier l'API).

## API

### Créer un build
`POST /api/builds` (en-tête `x-api-key` si `API_KEY` est défini)

```json
{
  "url": "https://example.com",
  "name": "Mon App",
  "packageName": "com.example.monapp",
  "versionName": "1.0",
  "versionCode": 1,
  "themeColor": "#1E88E5",
  "splashColor": "#FFFFFF",
  "orientation": "auto",
  "language": "fr",
  "pullToRefresh": true,
  "externalLinksInBrowser": true,
  "allowZoom": false,
  "userAgentSuffix": "",
  "icon": "<PNG/JPG/WebP en base64, facultatif, min 96x96>"
}
```

Seuls `url` et `name` sont obligatoires. Sans `packageName`, il est dérivé du domaine (même site = même package). Pour publier une mise à jour, garde le même package et augmente `versionCode`.

Réponse `202` : `{ "id": "...", "status": "queued", ... }`

### Suivre / télécharger
- `GET /api/builds/:id` : `status` = `queued`, `building`, `done` ou `failed` (avec `log` en cas d'échec)
- `GET /api/builds/:id/download` : le fichier `.apk` quand `status` = `done`

L'identifiant de build (128 bits aléatoires) sert de lien privé de téléchargement.

### Exemple

```bash
curl -s -X POST http://localhost:3000/api/builds \
  -H "x-api-key: $API_KEY" -H "content-type: application/json" \
  -d '{"url":"https://example.com","name":"Mon App"}'
```

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `API_KEY` | vide | Clé requise pour créer un build (obligatoire en production) |
| `PORT` | 3000 | Port HTTP |
| `DATA_DIR` | `./data` | Builds, keystore, cache Gradle |
| `RATE_LIMIT_PER_HOUR` | 10 | Builds par IP et par heure |
| `MAX_QUEUE` | 20 | Taille max de la file |
| `KEEP_HOURS` | 24 | Durée de conservation des APK |
| `BUILD_TIMEOUT_MS` | 900000 | Délai max d'une compilation |
| `TRUST_PROXY` | 0 | Mettre 1 derrière nginx/Caddy |
| `DRY_RUN` | 0 | 1 = ne lance pas Gradle |

## À savoir

- Android uniquement pour l'instant. iOS demande un Mac et un compte Apple Developer payant.
- L'APK sert à l'installation directe. Pour le Play Store, il faudra un AAB et un compte développeur Google.
- Mets le serveur derrière HTTPS (Caddy ou nginx) avant de l'exposer.

## Sans serveur : compiler avec GitHub Actions (idéal depuis une tablette)

1. Crée un dépôt GitHub **privé** et mets-y tout le contenu de ce dossier (y compris `.github`). Depuis une tablette, le plus simple est de créer un Codespace sur le dépôt, de glisser le zip dans l'explorateur, puis dans le terminal : `unzip appmint-server.zip` et un commit.
2. Si tu veux une icône, ajoute une image (ex. `icon.png`) à la racine du dépôt.
3. Onglet **Actions** → **Créer un APK** → **Run workflow** : remplis l'adresse du site, le nom, le chemin de l'icône, etc.
4. Quand c'est vert, ouvre l'exécution et télécharge l'artefact **apk** (un zip contenant l'APK).

Pour pouvoir publier des mises à jour de la même app, crée une fois une clé de signature et enregistre-la dans les secrets du dépôt (`KEYSTORE_B64` et `KEYSTORE_PASS`). Sans ces secrets, une clé temporaire est utilisée à chaque build.
