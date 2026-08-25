import { NextResponse } from 'next/server';
import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import { resolveWorkspaceName } from '@/lib/workspace';

// Fungsi rekursif untuk menambahkan file ke JSZip
function addFilesToZip(zip, dirPath, basePath) {
  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const relativePath = path.relative(basePath, fullPath);
    
    if (fs.statSync(fullPath).isDirectory()) {
      addFilesToZip(zip, fullPath, basePath);
    } else {
      const fileData = fs.readFileSync(fullPath);
      zip.file(relativePath, fileData);
    }
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get('sessionId');

  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
  }

  const workspaceName = await resolveWorkspaceName(sessionId);
  if (!workspaceName) {
    return NextResponse.json({ error: 'Invalid sessionId' }, { status: 400 });
  }

  const workspaceDir = path.join(process.cwd(), 'workspaces', workspaceName);

  if (!fs.existsSync(workspaceDir)) {
    return NextResponse.json({ error: 'Workspace not found for this session. The agent has not created any files yet.' }, { status: 404 });
  }

  try {
    const zip = new JSZip();
    addFilesToZip(zip, workspaceDir, workspaceDir);

    // Generate zip as nodebuffer
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    return new NextResponse(zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${workspaceName}.zip"`,
      },
    });
  } catch (error) {
    console.error('ZIP generation error:', error);
    return NextResponse.json({ error: 'Failed to generate ZIP' }, { status: 500 });
  }
}
