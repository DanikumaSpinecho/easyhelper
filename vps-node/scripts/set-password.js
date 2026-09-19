// Définit le mot de passe technicien (haché scrypt) dans config.json.
// Usage : npm run set-password -- <mot-de-passe>
//         ou node scripts/set-password.js   (saisie interactive)
// Le mot de passe en clair n'est jamais stocké.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(dir, '..', 'config.json');

function loadConfig() {
  if (fs.existsSync(configPath)) {
    try {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      console.error('config.json est illisible.');
      process.exit(1);
    }
  }
  return {};
}

function setPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const config = loadConfig();
  config.techPasswordHash = `${salt.toString('hex')}:${hash}`;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log('Mot de passe technicien enregistré (haché scrypt) dans config.json.');
  console.log('Redémarrez le serveur pour prise en compte.');
}

const arg = process.argv[2];

if (arg) {
  if (arg.length < 8) {
    console.error('Le mot de passe doit contenir au moins 8 caractères.');
    process.exit(1);
  }
  setPassword(arg);
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Nouveau mot de passe technicien (min. 8 caractères) : ', (answer) => {
  rl.close();
  if (answer.length < 8) {
    console.error('Le mot de passe doit contenir au moins 8 caractères.');
    process.exit(1);
  }
  setPassword(answer);
});
