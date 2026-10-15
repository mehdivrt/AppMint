'use strict';
// Compile un APK sans serveur HTTP (utilisé par GitHub Actions).
// Entrées via variables d'environnement : APP_URL, APP_NAME, ICON_PATH, THEME_COLOR, SPLASH_COLOR,
// PACKAGE_NAME, VERSION_NAME, VERSION_CODE, ORIENTATION, LANGUAGE. Sortie : dossier out/

const fs = require('fs');
const path = require('path');

process.env.DATA_DIR = process.env.DATA_DIR || path.resolve('data');
const { validate, generateProject, runGradle, ensureKeystore } = require('./server.js');

const env = process.env;
const opt = (k) => (env[k] && env[k].trim() ? env[k].trim() : undefined);

(async () => {
  const body = {
    url: opt('APP_URL'),
    name: opt('APP_NAME'),
    themeColor: opt('THEME_COLOR'),
    splashColor: opt('SPLASH_COLOR'),
    packageName: opt('PACKAGE_NAME'),
    versionName: opt('VERSION_NAME'),
    versionCode: opt('VERSION_CODE') ? Number(opt('VERSION_CODE')) : undefined,
    orientation: opt('ORIENTATION'),
    language: opt('LANGUAGE'),
  };

  const iconPath = opt('ICON_PATH');
  if (iconPath) {
    if (!fs.existsSync(iconPath)) {
      console.error('Icône introuvable dans le dépôt : ' + iconPath);
      process.exit(1);
    }
    body.icon = fs.readFileSync(iconPath).toString('base64');
  }

  const { errors, config } = validate(body);
  if (errors.length) {
    console.error('Paramètres invalides :\n - ' + errors.join('\n - '));
    process.exit(1);
  }

  const workDir = path.resolve('work');
  const projectDir = path.join(workDir, 'project');
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  await generateProject(projectDir, config);
  ensureKeystore();
  await runGradle(projectDir, (t) => process.stdout.write(t));

  const apk = path.join(projectDir, 'app/build/outputs/apk/release/app-release.apk');
  if (!fs.existsSync(apk)) throw new Error('APK introuvable après la compilation');

  const outDir = path.resolve('out');
  fs.mkdirSync(outDir, { recursive: true });
  const safe = config.name.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'app';
  const target = path.join(outDir, `${safe}-${config.versionName}.apk`);
  fs.copyFileSync(apk, target);
  console.log('\nAPK prêt : ' + target + '\nPackage : ' + config.packageName);
})().catch((e) => {
  console.error('\nÉchec : ' + e.message);
  process.exit(1);
});
