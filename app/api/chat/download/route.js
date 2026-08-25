import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

const MIME = {
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// Stream a file from chat-workspaces/<sessionId> for download. Path-traversal
// safe: the resolved target must stay inside the session folder.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');
  const relPath = searchParams.get('path');

  if (!sessionId || !relPath) {
    return NextResponse.json({ error: 'sessionId and path required' }, { status: 400 });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  }

  const base = path.join(process.cwd(), 'chat-workspaces', sessionId);
  const target = path.resolve(base, relPath);
  if (target !== base && !target.startsWith(base + path.sep)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }

  try {
    const buf = await fs.readFile(target);
    const name = path.basename(target);
    const mime = MIME[path.extname(name).toLowerCase()] || 'application/octet-stream';
    return new NextResponse(buf, {
      headers: {
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }
}
