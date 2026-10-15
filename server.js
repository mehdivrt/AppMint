'use strict';

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const sharp = require('sharp');

// ---------- Configuration ----------
const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || '';           // vide = pas d'authentification
const DRY_RUN = process.env.DRY_RUN === '1';          // génère le projet sans lancer Gradle
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BUILDS_DIR = path.join(DATA_DIR, 'builds');
const GRADLE_HOME = path.join(DATA_DIR, 'gradle-home');
const KEYSTORE = path.join(DATA_DIR, 'release.keystore');
const KEYPASS_FILE = path.join(DATA_DIR, 'release.keystore.pass');
const TEMPLATE_DIR = path.join(__dirname, 'template');
const ANDROID_HOME = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || '';
const BUILD_TIMEOUT_MS = Number(process.env.BUILD_TIMEOUT_MS || 15 * 60 * 1000);
const MAX_QUEUE = Number(process.env.MAX_QUEUE || 20);
const RATE_LIMIT_PER_HOUR = Number(process.env.RATE_LIMIT_PER_HOUR || 10);
const KEEP_HOURS = Number(process.env.KEEP_HOURS || 24);

fs.mkdirSync(BUILDS_DIR, { recursive: true });

// ---------- Texte localisé de la page hors-ligne ----------
const I18N = {
  fr: { title: 'Pas de connexion', text: 'Vérifiez votre connexion Internet puis réessayez.', retry: 'Réessayer' },
  en: { title: 'No connection', text: 'Check your Internet connection and try again.', retry: 'Retry' },
  ar: { title: 'لا يوجد اتصال', text: 'تحقق من اتصالك بالإنترنت ثم حاول مرة أخرى.', retry: 'إعادة المحاولة' },
};

// ---------- Outils ----------
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PACKAGE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$/;
const VERSION_RE = /^[0-9A-Za-z.\-]{1,20}$/;

function newId() {
  return crypto.randomBytes(16).toString('hex');
}

// Échappement pour les ressources Android (strings.xml)
function androidStr(v) {
  return String(v)
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/^([@?])/, '\\$1');
}

function isLight(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.65;
}

function renderTemplate(text, vars) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error('Variable de modèle manquante : ' + k);
    return vars[k];
  });
}

function walk(dir, fn) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

// ---------- Validation de la demande ----------
function validate(body) {
  const errors = [];
  const out = {};

  // URL
  let url;
  try {
    url = new URL(String(body.url || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    if (url.href.length > 2000) throw new Error();
  } catch {
    errors.push('url : URL http(s) valide requise');
  }
  out.url = url ? url.href : '';

  // Nom
  const name = String(body.name || '').trim();
  if (name.length < 1 || name.length > 30) errors.push('name : 1 à 30 caractères');
  out.name = name;

  // Package
  if (body.packageName) {
    const pkg = String(body.packageName).trim();
    if (!PACKAGE_RE.test(pkg) || pkg.length > 80) errors.push('packageName : format invalide (ex. com.monsite.app)');
    out.packageName = pkg;
  } else if (url) {
    // Déterministe : le même site donne toujours le même package (mises à jour possibles)
    out.packageName = 'com.appmint.w' + crypto.createHash('sha1').update(url.hostname).digest('hex').slice(0, 10);
  }

  // Versions
  out.versionName = String(body.versionName || '1.0');
  if (!VERSION_RE.test(out.versionName)) errors.push('versionName : 1 à 20 caractères (lettres, chiffres, . -)');
  out.versionCode = body.versionCode === undefined ? 1 : Number(body.versionCode);
  if (!Number.isInteger(out.versionCode) || out.versionCode < 1 || out.versionCode > 2100000000) {
    errors.push('versionCode : entier entre 1 et 2100000000');
  }

  // Couleurs
  out.themeColor = String(body.themeColor || '#1E88E5');
  out.splashColor = String(body.splashColor || '#FFFFFF');
  for (const k of ['themeColor', 'splashColor']) {
    if (!HEX_COLOR.test(out[k])) errors.push(k + ' : couleur au format #RRGGBB');
  }

  // Options
  out.orientation = String(body.orientation || 'auto');
  if (!['auto', 'portrait', 'landscape'].includes(out.orientation)) errors.push('orientation : auto, portrait ou landscape');
  out.language = String(body.language || 'fr');
  if (!I18N[out.language]) errors.push('language : ' + Object.keys(I18N).join(', '));
  out.pullToRefresh = body.pullToRefresh !== false;
  out.externalLinksInBrowser = body.externalLinksInBrowser !== false;
  out.allowZoom = body.allowZoom === true;
  out.userAgentSuffix = String(body.userAgentSuffix || '').slice(0, 60);

  // Icône (PNG/JPG/WebP en base64, facultative)
  out.iconBase64 = body.icon ? String(body.icon).replace(/^data:[^;]+;base64,/, '') : '';
  if (out.iconBase64 && out.iconBase64.length > 3_000_000) errors.push('icon : image trop lourde (max ~2 Mo)');

  return { errors, config: out };
}

// ---------- Icônes ----------
const ICON_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };

async function makeIcons(projectDir, cfg) {
  let source;
  if (cfg.iconBase64) {
    source = Buffer.from(cfg.iconBase64, 'base64');
  } else {
    const initial = (cfg.name.trim()[0] || 'A').toUpperCase().replace(/[<>&]/g, '');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <rect width="512" height="512" rx="110" fill="${cfg.themeColor}"/>
      <text x="256" y="350" font-size="300" font-family="sans-serif" font-weight="bold"
            text-anchor="middle" fill="#ffffff">${initial}</text></svg>`;
    source = Buffer.from(svg);
  }
  for (const [density, size] of Object.entries(ICON_SIZES)) {
    const dir = path.join(projectDir, 'app/src/main/res', 'mipmap-' + density);
    fs.mkdirSync(dir, { recursive: true });
    await sharp(source)
      .resize(size, size, { fit: 'cover' })
      .png()
      .toFile(path.join(dir, 'ic_launcher.png'));
  }
}

// ---------- Génération du projet Android ----------
async function generateProject(projectDir, cfg) {
  fs.cpSync(TEMPLATE_DIR, projectDir, { recursive: true });

  const pkgPathDir = path.join(projectDir, 'app/src/main/java', cfg.packageName.split('.').join(path.sep));
  fs.mkdirSync(path.dirname(pkgPathDir), { recursive: true });
  fs.renameSync(path.join(projectDir, 'app/src/main/java/PKGPATH'), pkgPathDir);

  const t = I18N[cfg.language];
  const vars = {
    PACKAGE: cfg.packageName,
    VERSION_CODE: String(cfg.versionCode),
    VERSION_NAME: cfg.versionName,
    APP_NAME: androidStr(cfg.name),
    START_URL: androidStr(cfg.url),
    THEME_COLOR: cfg.themeColor.toUpperCase(),
    SPLASH_COLOR: cfg.splashColor.toUpperCase(),
    LIGHT_STATUS: String(isLight(cfg.themeColor)),
    ORIENTATION: cfg.orientation === 'auto' ? 'unspecified' : cfg.orientation,
    CLEARTEXT: String(cfg.url.startsWith('http:')),
    PULL_TO_REFRESH: String(cfg.pullToRefresh),
    EXTERNAL_LINKS: String(cfg.externalLinksInBrowser),
    ALLOW_ZOOM: String(cfg.allowZoom),
    UA_SUFFIX: androidStr(cfg.userAgentSuffix),
    OFFLINE_TITLE: androidStr(t.title),
    OFFLINE_TEXT: androidStr(t.text),
    OFFLINE_RETRY: androidStr(t.retry),
  };

  walk(projectDir, (file) => {
    if (/\.(gradle|xml|java|properties)$/.test(file)) {
      fs.writeFileSync(file, renderTemplate(fs.readFileSync(file, 'utf8'), vars));
    }
  });

  await makeIcons(projectDir, cfg);

  if (ANDROID_HOME) {
    fs.writeFileSync(path.join(projectDir, 'local.properties'), 'sdk.dir=' + ANDROID_HOME.replace(/\\/g, '/') + '\n');
  }
}

// ---------- Keystore de signature ----------
function ensureKeystore() {
  if (DRY_RUN) return;
  if (fs.existsSync(KEYSTORE) && fs.existsSync(KEYPASS_FILE)) return;
  const pass = crypto.randomBytes(18).toString('base64url');
  execFileSync('keytool', [
    '-genkeypair', '-v', '-keystore', KEYSTORE, '-alias', 'appmint',
    '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
    '-storepass', pass, '-keypass', pass,
    '-dname', 'CN=AppMint Server, O=AppMint, C=MA',
  ], { stdio: 'ignore' });
  fs.writeFileSync(KEYPASS_FILE, pass, { mode: 0o600 });
  console.log('Keystore créé dans', KEYSTORE, '— SAUVEGARDEZ-LE : sans lui, les mises à jour des apps seront impossibles.');
}

// ---------- Compilation ----------
function runGradle(projectDir, log) {
  return new Promise((resolve, reject) => {
    const pass = fs.readFileSync(KEYPASS_FILE, 'utf8').trim();
    const args = [
      '--no-daemon', '--console=plain', 'assembleRelease',
      '-PksPath=' + KEYSTORE, '-PksPass=' + pass,
    ];
    const child = spawn('gradle', args, {
      cwd: projectDir,
      env: { ...process.env, GRADLE_USER_HOME: GRADLE_HOME },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, BUILD_TIMEOUT_MS);
    const onData = (d) => log(d.toString().replaceAll(pass, '***'));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('Délai de compilation dépassé'));
      else if (code !== 0) reject(new Error('Gradle a échoué (code ' + code + ')'));
      else resolve();
    });
  });
}

// ---------- Suivi des builds + file d'attente ----------
const builds = new Map();
const queue = [];
let running = false;

function statusFile(id) { return path.join(BUILDS_DIR, id, 'status.json'); }

function saveStatus(b) {
  try { fs.writeFileSync(statusFile(b.id), JSON.stringify(b)); } catch { /* ignoré */ }
}

function loadBuild(id) {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  if (builds.has(id)) return builds.get(id);
  try {
    const b = JSON.parse(fs.readFileSync(statusFile(id), 'utf8'));
    if (b.status === 'queued' || b.status === 'building') {
      b.status = 'failed';
      b.error = 'Interrompu par un redémarrage du serveur';
    }
    builds.set(id, b);
    return b;
  } catch { return null; }
}

function publicView(b) {
  return {
    id: b.id, status: b.status, createdAt: b.createdAt, finishedAt: b.finishedAt || null,
    name: b.config.name, packageName: b.config.packageName, versionName: b.config.versionName,
    versionCode: b.config.versionCode, error: b.error || null,
    queuePosition: b.status === 'queued' ? queue.indexOf(b.id) + 1 : 0,
    log: b.status === 'failed' ? b.log.slice(-3000) : undefined,
    downloadUrl: b.status === 'done' && b.hasApk ? `/api/builds/${b.id}/download` : null,
  };
}

async function processNext() {
  if (running) return;
  const id = queue.shift();
  if (!id) return;
  running = true;
  const b = builds.get(id);
  const dir = path.join(BUILDS_DIR, id);
  const projectDir = path.join(dir, 'project');
  const log = (s) => { b.log = (b.log + s).slice(-20000); };

  try {
    b.status = 'building';
    saveStatus(b);
    await generateProject(projectDir, b.config);
    if (DRY_RUN) {
      log('Mode simulation : projet généré, Gradle non lancé.\n');
      b.hasApk = false;
    } else {
      await runGradle(projectDir, log);
      const apk = path.join(projectDir, 'app/build/outputs/apk/release/app-release.apk');
      if (!fs.existsSync(apk)) throw new Error('APK introuvable après la compilation');
      fs.copyFileSync(apk, path.join(dir, 'app.apk'));
      b.hasApk = true;
    }
    b.status = 'done';
  } catch (e) {
    b.status = 'failed';
    b.error = e.message;
  } finally {
    b.finishedAt = new Date().toISOString();
    // On garde le code source pour le débogage mais on supprime les artefacts Gradle lourds
    fs.rm(path.join(projectDir, 'app/build'), { recursive: true, force: true }, () => {});
    fs.rm(path.join(projectDir, '.gradle'), { recursive: true, force: true }, () => {});
    delete b.config.iconBase64;
    saveStatus(b);
    running = false;
    setImmediate(processNext);
  }
}

// Nettoyage des anciens builds
function cleanup() {
  const limit = Date.now() - KEEP_HOURS * 3600 * 1000;
  for (const name of fs.readdirSync(BUILDS_DIR)) {
    const dir = path.join(BUILDS_DIR, name);
    try {
      if (fs.statSync(dir).mtimeMs < limit && !queue.includes(name) && !(builds.get(name)?.status === 'building')) {
        fs.rmSync(dir, { recursive: true, force: true });
        builds.delete(name);
      }
    } catch { /* ignoré */ }
  }
}
setInterval(cleanup, 3600 * 1000).unref();

// ---------- Limitation de débit simple (par IP) ----------
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600 * 1000);
  if (arr.length >= RATE_LIMIT_PER_HOUR) { hits.set(ip, arr); return true; }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

// ---------- API HTTP ----------
const app = express();
app.set('trust proxy', process.env.TRUST_PROXY === '1');
app.use(express.json({ limit: '5mb' }));

function auth(req, res, next) {
  if (!API_KEY) return next();
  const given = req.get('x-api-key') || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Clé API invalide ou manquante' });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, dryRun: DRY_RUN, queue: queue.length, building: running });
});

app.post('/api/builds', auth, async (req, res) => {
  const { errors, config } = validate(req.body || {});
  if (errors.length) return res.status(400).json({ error: 'Paramètres invalides', details: errors });
  if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'File d\'attente pleine, réessayez plus tard' });
  if (rateLimited(req.ip)) return res.status(429).json({ error: 'Trop de demandes, réessayez dans une heure' });

  if (config.iconBase64) {
    try {
      const meta = await sharp(Buffer.from(config.iconBase64, 'base64')).metadata();
      if (!meta.width || meta.width < 96 || meta.height < 96) {
        return res.status(400).json({ error: 'Paramètres invalides', details: ['icon : image d\'au moins 96×96 px requise'] });
      }
    } catch {
      return res.status(400).json({ error: 'Paramètres invalides', details: ['icon : image illisible (PNG, JPG ou WebP)'] });
    }
  }

  const id = newId();
  fs.mkdirSync(path.join(BUILDS_DIR, id), { recursive: true });
  const b = { id, status: 'queued', createdAt: new Date().toISOString(), config, log: '', hasApk: false };
  builds.set(id, b);
  queue.push(id);
  saveStatus(b);
  setImmediate(processNext);
  res.status(202).json(publicView(b));
});

app.get('/api/builds/:id', (req, res) => {
  const b = loadBuild(req.params.id);
  if (!b) return res.status(404).json({ error: 'Build introuvable' });
  res.json(publicView(b));
});

app.get('/api/builds/:id/download', (req, res) => {
  const b = loadBuild(req.params.id);
  if (!b || b.status !== 'done' || !b.hasApk) return res.status(404).json({ error: 'APK indisponible' });
  const file = path.join(BUILDS_DIR, b.id, 'app.apk');
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'APK expiré' });
  const safeName = b.config.name.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'app';
  res.type('application/vnd.android.package-archive');
  res.download(file, `${safeName}-${b.config.versionName}.apk`);
});

// Interface web facultative (dossier public/)
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) app.use(express.static(PUBLIC_DIR));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse' });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON invalide' });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne' });
});

module.exports = { validate, generateProject, runGradle, ensureKeystore };

if (require.main === module) {
  ensureKeystore();
  app.listen(PORT, () => {
    console.log(`AppMint server sur le port ${PORT}${DRY_RUN ? ' (mode simulation)' : ''}`);
    if (!DRY_RUN && !ANDROID_HOME) console.warn('ATTENTION : ANDROID_HOME n\'est pas défini.');
    if (!API_KEY) console.warn('ATTENTION : API_KEY vide, l\'API est ouverte à tous.');
  });
}
