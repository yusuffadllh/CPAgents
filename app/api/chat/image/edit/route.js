import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizeModelName } from '@/lib/context';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

// Edit/modify an existing image (image-to-image). Tries the OpenAI-style
// /images/edits endpoint first; if the gateway doesn't support it, falls back
// to /images/generations with the prompt (best effort).
export async function POST(request) {
  try {
    const { prompt, sessionId, sourcePath, size } = await request.json();

    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }
    if (!sessionId || !sourcePath) {
      return NextResponse.json({ error: 'sessionId and sourcePath required' }, { status: 400 });
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Resolve the source image, path-traversal safe.
    const base = path.join(process.cwd(), 'chat-workspaces', sessionId);
    const srcAbs = path.resolve(base, sourcePath);
    if (srcAbs !== base && !srcAbs.startsWith(base + path.sep)) {
      return NextResponse.json({ error: 'Invalid source path' }, { status: 400 });
    }
    let srcBuffer;
    try {
      srcBuffer = await fs.readFile(srcAbs);
    } catch {
      return NextResponse.json({ error: 'Source image not found' }, { status: 404 });
    }

    const imageModel = normalizeModelName(settings.imageModelName, 'gpt-image-1');
    const apiBase = (settings.baseUrl || '').replace(/\/$/, '');

    await prisma.message.create({
      data: { sessionId, role: 'user', content: `✏️ Edit gambar: ${prompt}` },
    });

    // Attempt 1: /images/edits (multipart form).
    let resultBuffer = null;
    let mime = 'image/png';
    try {
      const form = new FormData();
      const srcName = path.basename(srcAbs);
      const blob = new Blob([srcBuffer], { type: 'image/png' });
      form.append('image', blob, srcName);
      form.append('prompt', prompt);
      form.append('model', imageModel);
      form.append('n', '1');
      form.append('size', size || '1024x1024');

      const editRes = await fetch(`${apiBase}/images/edits`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}` },
        body: form,
      });

      if (editRes.ok) {
        const data = await editRes.json();
        const item = data.data && data.data[0];
        if (item?.b64_json) {
          resultBuffer = Buffer.from(item.b64_json, 'base64');
        } else if (item?.url) {
          const r = await fetch(item.url);
          resultBuffer = Buffer.from(await r.arrayBuffer());
          mime = r.headers.get('content-type') || mime;
        }
      } else {
        console.warn('images/edits failed, will fallback:', editRes.status);
      }
    } catch (e) {
      console.warn('images/edits threw, will fallback:', e.message);
    }

    // Fallback: plain generation from the prompt.
    if (!resultBuffer) {
      const genRes = await fetch(`${apiBase}/images/generations`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${settings.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: imageModel, prompt, n: 1, size: size || '1024x1024' }),
      });
      if (!genRes.ok) {
        const errText = await genRes.text();
        await prisma.message.create({
          data: { sessionId, role: 'assistant', content: `❌ Gagal edit gambar (${genRes.status}). Gateway mungkin tidak mendukung edit gambar.` },
        });
        return NextResponse.json({ error: 'Image edit failed', details: errText }, { status: genRes.status });
      }
      const data = await genRes.json();
      const item = data.data && data.data[0];
      if (item?.b64_json) {
        resultBuffer = Buffer.from(item.b64_json, 'base64');
      } else if (item?.url) {
        const r = await fetch(item.url);
        resultBuffer = Buffer.from(await r.arrayBuffer());
        mime = r.headers.get('content-type') || mime;
      }
    }

    if (!resultBuffer) {
      return NextResponse.json({ error: 'No image returned' }, { status: 502 });
    }

    const dir = path.join(base, 'generated');
    await fs.mkdir(dir, { recursive: true });
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const fileName = `edit-${crypto.randomBytes(4).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(dir, fileName), resultBuffer);

    const dataUrl = `data:${mime};base64,${resultBuffer.toString('base64')}`;
    const attachment = {
      type: 'image',
      name: fileName,
      path: `generated/${fileName}`,
      mime,
      size: resultBuffer.length,
      dataUrl,
      generated: true,
    };

    const assistantMessage = await prisma.message.create({
      data: {
        sessionId,
        role: 'assistant',
        content: `Ini hasil edit gambarnya untuk: "${prompt}"`,
        attachments: [attachment],
      },
    });

    return NextResponse.json({ session, assistantMessage });
  } catch (error) {
    console.error('Image edit API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
