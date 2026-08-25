import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { resolveWorkspaceName } from '@/lib/workspace';

export const dynamic = 'force-dynamic';

// Binary deliverables (pdf/xlsx/docx/pptx) can't be previewed as text, so the
// file browser needs a way to hand them to the user as a real download.
const MIME = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const relPath = searchParams.get('path');

  if (!sessionId || !relPath) {
    return NextResponse.json({ error: 'sessionId and path required' }, { status: 400 });
  }

  const workspaceName = await resolveWorkspaceName(sessionId);
  if (!workspaceName) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  }

  const base = path.join(process.cwd(), 'workspaces', workspaceName);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      return NextResponse.json({ error: 'Not a file' }, { status: 400 });
    }
    const buf = await fs.readFile(target);
    const name = path.basename(target);
    const type = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    return new NextResponse(buf, {
      headers: {
        'Content-Type': type,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
        'Content-Length': String(stat.size),
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
