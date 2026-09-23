import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { normalizeModelName } from '@/lib/context';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

// Generate an image from a text prompt via the gateway's OpenAI-compatible
// images endpoint, store it in chat-workspaces/<sessionId>/generated, and save
// user + assistant messages so it renders inline in the chat.
export async function POST(request) {
  try {
    const { prompt, sessionId, size } = await request.json();

    if (!prompt || !prompt.trim()) {
      return NextResponse.json({ error: 'Prompt is required' }, { status: 400 });
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    // Get or create session.
    let session;
    if (sessionId) {
      session = await prisma.session.findUnique({ where: { id: sessionId } });
    }
    if (!session) {
      session = await prisma.session.create({ data: { goal: 'Chat session' } });
    }

    // Save user prompt message.
    const userMessage = await prisma.message.create({
      data: { sessionId: session.id, role: 'user', content: `🎨 Generate gambar: ${prompt}` },
    });

    const imageModel = normalizeModelName(settings.imageModelName, 'gpt-image-1');
    const base = (settings.baseUrl || '').replace(/\/$/, '');

    const response = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: imageModel,
        prompt,
        n: 1,
        size: size || '1024x1024',
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Image generation error:', response.status, errText);
      await prisma.message.create({
        data: {
          sessionId: session.id,
          role: 'assistant',
          content: `❌ Gagal generate gambar (${response.status}). ${errText.slice(0, 300)}`,
        },
      });
      return NextResponse.json({ error: 'Image generation failed', details: errText }, { status: response.status });
    }

    const data = await response.json();
    const item = data.data && data.data[0];
    if (!item) {
      return NextResponse.json({ error: 'No image returned from gateway' }, { status: 502 });
    }

    // Gateway may return base64 (b64_json) or a URL.
    let buffer;
    let mime = 'image/png';
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      const imgRes = await fetch(item.url);
      buffer = Buffer.from(await imgRes.arrayBuffer());
      mime = imgRes.headers.get('content-type') || mime;
    } else {
      return NextResponse.json({ error: 'Unexpected image response shape' }, { status: 502 });
    }

    // Persist to disk (isolated chat workspace).
    const dir = path.join(process.cwd(), 'chat-workspaces', session.id, 'generated');
    await fs.mkdir(dir, { recursive: true });
    const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
    const fileName = `${crypto.randomBytes(4).toString('hex')}.${ext}`;
    await fs.writeFile(path.join(dir, fileName), buffer);

    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`;
    const attachment = {
      type: 'image',
      name: fileName,
      path: `generated/${fileName}`,
      mime,
      size: buffer.length,
      dataUrl,
      generated: true,
    };

    const assistantMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: `Ini hasil gambarnya untuk: "${prompt}"`,
        attachments: [attachment],
      },
    });

    return NextResponse.json({ session, userMessage, assistantMessage });
  } catch (error) {
    console.error('Image API error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
