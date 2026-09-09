// One-shot: load the service-account JSON into Settings.googleServiceAccountJson.
// Uses better-sqlite3 directly (generated/prisma client is TS, not requirable here).
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const keyPath = process.argv[2];
if (!keyPath) {
  console.error('Usage: node scripts/set-google-sa.mjs <path-to-service-account.json>');
  process.exit(1);
}
const raw = fs.readFileSync(keyPath, 'utf8');
const parsed = JSON.parse(raw); // validate
if (parsed.type !== 'service_account' || !parsed.client_email) {
  console.error('Not a valid service account JSON (missing type/client_email).');
  process.exit(1);
}

const dbPath = path.join(process.cwd(), 'dev.db');
const db = new Database(dbPath);
db.pragma('busy_timeout = 15000');
const info = db
  .prepare('UPDATE Settings SET googleServiceAccountJson = ? WHERE id = 1')
  .run(raw);
if (info.changes === 0) {
  db.prepare(
    'INSERT INTO Settings (id, googleServiceAccountJson) VALUES (1, ?)',
  ).run(raw);
}
db.close();
console.log(`OK — key for ${parsed.client_email} saved to Settings.`);
