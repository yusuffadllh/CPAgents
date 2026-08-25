import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolveWorkspaceName } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// Max size we'll return for a file preview (bytes).
const MAX_FILE_BYTES = 500 * 1024;

// Folders we never want to show — internal/system noise.
const HIDDEN_DIRS = new Set(['.git', '.next', 'node_modules', '.opencode', '.cache']);

function safeResolve(workspaceName, relPath) {
  const base = path.join(process.cwd(), 'workspaces', workspaceName);
  // Normalize and block path traversal outside the workspace.
  const target = path.resolve(base, relPath || '.');
  if (target !== base && !target.startsWith(base + path.sep)) {
    return null;
  }
  return { base, target };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const relPath = searchParams.get('path') || '';
    const mode = searchParams.get('mode') || 'list'; // 'list' | 'read'

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    const workspaceName = await resolveWorkspaceName(sessionId);
    if (!workspaceName) {
      return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
    }

    const resolved = safeResolve(workspaceName, relPath);
    if (!resolved) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
    }
    const { base, target } = resolved;

    // If the workspace doesn't exist yet, return an empty listing.
    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      return NextResponse.json({ type: 'dir', path: relPath, entries: [] });
    }

    if (mode === 'read' || stat.isFile()) {
      if (stat.size > MAX_FILE_BYTES) {
        return NextResponse.json({
          type: 'file',
          path: relPath,
          size: stat.size,
          tooLarge: true,
          content: `(File terlalu besar untuk dipreview: ${(stat.size / 1024).toFixed(0)} KB)`,
        });
      }
      // Detect binary-ish content and avoid dumping garbage.
      const buf = await fs.readFile(target);
      const isBinary = buf.slice(0, 8000).includes(0);
      if (isBinary) {
        return NextResponse.json({
          type: 'file',
          path: relPath,
          size: stat.size,
          binary: true,
          content: '(File biner — tidak bisa dipreview sebagai teks)',
        });
      }
      return NextResponse.json({
        type: 'file',
        path: relPath,
        size: stat.size,
        content: buf.toString('utf8'),
      });
    }

    const dirents = await fs.readdir(target, { withFileTypes: true });
    const entries = [];
    for (const d of dirents) {
      if (d.isDirectory() && HIDDEN_DIRS.has(d.name)) continue;
      const entryPath = path.posix.join(relPath.split(path.sep).join('/'), d.name);
      let size = 0;
      if (d.isFile()) {
        try {
          size = (await fs.stat(path.join(target, d.name))).size;
        } catch {}
      }
      entries.push({
        name: d.name,
        type: d.isDirectory() ? 'dir' : 'file',
        path: entryPath,
        size,
      });
    }
    // Folders first, then files, alphabetically.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return NextResponse.json({ type: 'dir', path: relPath, entries });
  } catch (error) {
    console.error('Files API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
