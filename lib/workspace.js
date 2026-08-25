import path from 'path';

// Imported lazily: the generated Prisma client is TypeScript, so a top-level
// import would stop plain-node scripts from using slugifyGoal().
const getPrisma = async () => (await import('./prisma.js')).prisma;

const STOP_WORDS = new Set([
  'buat', 'buatkan', 'bikin', 'bikinkan', 'tolong', 'saya', 'aku', 'sebuah',
  'yang', 'untuk', 'dengan', 'dan', 'atau', 'agar', 'pakai', 'pake', 'gunakan',
  'a', 'an', 'the', 'please', 'make', 'create', 'build', 'me', 'my', 'with',
  'and', 'or', 'for', 'to', 'of', 'using', 'use', 'app', 'aplikasi',
]);

// Folder names must stay predictable: only these chars survive, so a goal can
// never inject a path separator or a shell-hostile character.
export function slugifyGoal(goal, fallback = '') {
  const words = String(goal || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  const kept = words.filter((w) => !STOP_WORDS.has(w));
  const chosen = (kept.length ? kept : words).slice(0, 5);
  const slug = chosen.join('-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48);

  if (slug) return slug;
  // Goal was punctuation/CJK only: fall back to a short id fragment.
  return `projek-${String(fallback).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'baru'}`;
}

// Reserve a unique slug, appending -2, -3, ... on collision.
export async function createSessionSlug(goal, sessionId) {
  const prisma = await getPrisma();
  const base = slugifyGoal(goal, sessionId);
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const taken = await prisma.session.findFirst({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!taken) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function isSafeDirName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Resolve the on-disk workspace directory for a session. Sessions created
 * before slugs existed have none, so they keep using their id.
 */
export async function resolveWorkspaceName(sessionId) {
  if (!isSafeDirName(sessionId)) return null;
  const prisma = await getPrisma();
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { slug: true },
  });
  const name = session?.slug || sessionId;
  return isSafeDirName(name) ? name : sessionId;
}

export async function resolveWorkspaceDir(sessionId, root = 'workspaces') {
  const name = await resolveWorkspaceName(sessionId);
  return name ? path.join(process.cwd(), root, name) : null;
}
