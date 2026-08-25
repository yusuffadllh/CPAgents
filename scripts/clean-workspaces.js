// Hapus folder workspace yang sudah tidak punya Session di DB (orphan).
//   node scripts/clean-workspaces.js          -> dry run (hanya melapor)
//   node scripts/clean-workspaces.js --delete -> benar-benar menghapus
//   node scripts/clean-workspaces.js --all --delete -> hapus SEMUA workspace
//   tambahkan --cache untuk ikut menghapus .agent-cache (cache npm/pip bersama)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DO_DELETE = process.argv.includes('--delete');
const ALL = process.argv.includes('--all');
const DROP_CACHE = process.argv.includes('--cache');
const ROOTS = ['workspaces', 'chat-workspaces'];
const SHARED_CACHE = '.agent-cache';

// A live session owns two possible folder names: its slug and its raw id.
function liveSessionIds() {
  const file = (process.env.DATABASE_URL || 'file:./dev.db').replace(/^file:/, '');
  const db = new Database(path.resolve(process.cwd(), file), { readonly: true });
  const rows = db.prepare('SELECT id, slug FROM Session').all();
  db.close();
  const names = new Set();
  for (const r of rows) {
    names.add(r.id);
    if (r.slug) names.add(r.slug);
  }
  return names;
}

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

const ids = ALL ? new Set() : liveSessionIds();
let freed = 0;

for (const root of ROOTS) {
  const base = path.resolve(process.cwd(), root);
  if (!fs.existsSync(base)) continue;
  for (const name of fs.readdirSync(base)) {
    const dir = path.join(base, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    // Shared npm/pip cache: not owned by any session, only dropped on --cache.
    if (name === SHARED_CACHE && !DROP_CACHE) {
      console.log(`KEEP   ${root}/${name} (cache bersama, pakai --cache untuk hapus)`);
      continue;
    }
    // .opencode-home-<sessionId> belongs to the session named in its suffix.
    const owner = name.startsWith('.opencode-home-')
      ? name.slice('.opencode-home-'.length)
      : name;
    if (ids.has(owner)) {
      console.log(`KEEP   ${root}/${name}`);
      continue;
    }
    const size = dirSize(dir);
    freed += size;
    const mb = (size / 1048576).toFixed(1);
    if (DO_DELETE) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`DELETED ${root}/${name} (${mb} MB)`);
    } else {
      console.log(`ORPHAN  ${root}/${name} (${mb} MB)`);
    }
  }
}

console.log(
  `\n${DO_DELETE ? 'Freed' : 'Would free'}: ${(freed / 1048576).toFixed(1)} MB` +
    (DO_DELETE ? '' : '\nJalankan ulang dengan --delete untuk menghapus.')
);
