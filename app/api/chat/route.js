import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { fetchChatWithRetry, parseChatCompletion } from '@/lib/context';
import { parseDocBlocks, writeDocuments } from '@/lib/documents';
import { resolveWorkspaceName, isSafeDirName } from '@/lib/workspace';
import fs from 'fs/promises';
import path from 'path';

// Instructs the model that it can create real files by emitting a fenced block.
// The server parses these blocks, writes them to chat-workspaces/<id>, and
// exposes them in "File Chat" + as download links.
const SYSTEM_PROMPT = `Kamu adalah asisten AI serba bisa (mirip ChatGPT/Claude) yang bisa membaca file & gambar, serta MEMBUAT file baru.

Jika pengguna meminta dibuatkan file (kode, teks, konfigurasi, dsb), tulis file menggunakan format PERSIS berikut agar sistem menyimpannya otomatis:

<<<FILE: nama-file.ext>>>
(isi lengkap file di sini)
<<<END>>>

Aturan:
- Gunakan path relatif; boleh subfolder, mis. <<<FILE: src/index.js>>>.
- Boleh membuat beberapa file dalam satu balasan (ulang blok di atas).
- Tetap beri penjelasan singkat di luar blok bila perlu.
- Jangan gunakan format ini kalau pengguna tidak minta dibuatkan file.

DOKUMEN (PDF, Excel, Word, PowerPoint, CSV):
Untuk format dokumen JANGAN pakai blok <<<FILE>>>. Pakai blok <<<DOC>>> berisi JSON, dan sistem akan merendernya jadi file asli:

<<<DOC: pdf: laporan.pdf>>>
{"title":"Laporan Penjualan","blocks":[{"type":"heading","level":2,"text":"Ringkasan"},{"type":"paragraph","text":"Penjualan naik 12%."},{"type":"list","items":["Poin A","Poin B"]},{"type":"table","headers":["Produk","Jumlah"],"rows":[["Kopi",120],["Teh",80]]}]}
<<<END>>>

Skema per tipe:
- pdf / docx -> {"title":"...","blocks":[...]} dengan blok: heading (level 1-3), paragraph, list (items), table (headers, rows), pagebreak.
- xlsx -> {"sheets":[{"name":"Sheet1","headers":["A","B"],"rows":[[1,2]]}]}. Tulis angka sebagai number (tanpa kutip) agar bisa dijumlah di Excel.
- pptx -> {"slides":[{"title":"Judul","bullets":["poin 1"],"notes":"catatan","table":{"headers":[],"rows":[]}}]}
- csv -> {"headers":["A","B"],"rows":[[1,2]]}

Aturan dokumen:
- JSON harus VALID dan berada dalam satu blok (tanpa komentar, tanpa trailing comma).
- Isi dengan data nyata sesuai permintaan pengguna, jangan template kosong atau lorem ipsum.
- Nama file harus memakai ekstensi yang sesuai dengan tipe blok.
- Gambar tidak didukung di dokumen; sajikan sebagai tabel atau teks.
- Batas: maksimal 10 dokumen per jawaban, 20.000 baris per tabel, 64 kolom, dan 100 MB per file. Data di atas batas akan dipotong, jadi ringkas bila perlu.
Jawab dalam bahasa yang sama dengan pengguna.`;

// Extract <<<FILE: name>>> ... <<<END>>> blocks from an assistant reply.
function parseFileBlocks(text) {
  const blocks = [];
  const re = /<<<FILE:\s*(.+?)\s*>>>\r?\n([\s\S]*?)\r?\n?<<<END>>>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ name: m[1].trim(), content: m[2] });
  }
  return blocks;
}

// Keep writes inside chat-workspaces/<sessionId>; block path traversal.
async function writeChatFiles(sessionId, blocks) {
  const base = path.join(process.cwd(), 'chat-workspaces', sessionId, 'files');
  const saved = [];
  for (const b of blocks) {
    const rel = b.name.replace(/^[/\\]+/, '');
    const target = path.resolve(base, rel);
    if (target !== base && !target.startsWith(base + path.sep)) continue;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, b.content, 'utf8');
    const stat = await fs.stat(target);
    saved.push({
      type: 'file',
      name: path.basename(rel),
      path: `files/${rel.split(path.sep).join('/')}`,
      mime: 'text/plain',
      size: stat.size,
      created: true,
    });
  }
  return saved;
}

// Turn a stored message (with optional attachments) into an OpenAI-compatible
// message. When attachments exist we emit content-parts: text + image_url for
// images, and inline text for readable files.
function toGatewayMessage(msg) {
  const role = msg.role === 'user' ? 'user' : 'assistant';
  let attachments = [];
  try {
    attachments = Array.isArray(msg.attachments)
      ? msg.attachments
      : (msg.attachments ? JSON.parse(msg.attachments) : []);
  } catch { attachments = []; }

  if (!attachments || attachments.length === 0) {
    return { role, content: msg.content };
  }

  const parts = [];
  if (msg.content) parts.push({ type: 'text', text: msg.content });

  for (const att of attachments) {
    if (att.type === 'image' && att.dataUrl) {
      parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
    } else if (att.textPreview) {
      parts.push({ type: 'text', text: `\n\n[File: ${att.name}]\n\`\`\`\n${att.textPreview}\n\`\`\`` });
    } else {
      parts.push({ type: 'text', text: `\n\n[File terlampir: ${att.name} (${att.mime || 'unknown'})]` });
    }
  }
  return { role, content: parts };
}

export async function POST(request) {
  try {
    const { content, sessionId, attachments } = await request.json();

    // Allow attachment-only messages (e.g. "analyze this image" without text).
    const hasAttachments = Array.isArray(attachments) && attachments.length > 0;
    if (!content && !hasAttachments) {
      return NextResponse.json({ error: 'Message content is required' }, { status: 400 });
    }

    // Get settings
    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    // Get or create session
    let session;
    if (sessionId) {
      session = await prisma.session.findUnique({ where: { id: sessionId } });
    }
    
    if (!session) {
      session = await prisma.session.create({
        data: { goal: 'Chat session' }
      });
    }

    // Save user message (with attachments metadata).
    const userMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: content || '',
        attachments: hasAttachments ? attachments : undefined,
      }
    });

    // Get previous messages for context (last 10)
    const history = await prisma.message.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' },
      take: 10
    });

    const openRouterMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(toGatewayMessage),
    ];

    // Call gateway, retrying on transient 429/5xx ("busy").
    const response = await fetchChatWithRetry(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'http://localhost:3000', 
        'X-Title': 'AI Chat App',
      },
      body: JSON.stringify({
        model: settings.modelName || 'google/gemini-2.5-pro',
        messages: openRouterMessages,
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter API Error:", response.status, errorText);
      return NextResponse.json({ error: 'Failed to communicate with OpenRouter API', details: errorText }, { status: response.status });
    }

    const rawText = await response.text();
    const data = parseChatCompletion(rawText);
    if (!data) {
      console.error("Failed to parse JSON from AI provider. Raw response:", rawText);
      return NextResponse.json({ error: 'Invalid JSON from AI provider', details: rawText }, { status: 502 });
    }

    let assistantContent = data.choices && data.choices[0] && data.choices[0].message 
      ? data.choices[0].message.content 
      : JSON.stringify(data);

    // If the model emitted file blocks, write them to disk and expose as
    // downloadable attachments. Replace the raw blocks with a short note.
    let fileAttachments = [];
    const blocks = parseFileBlocks(assistantContent);
    if (blocks.length > 0) {
      fileAttachments = await writeChatFiles(session.id, blocks);
      assistantContent = assistantContent.replace(
        /<<<FILE:\s*(.+?)\s*>>>\r?\n[\s\S]*?\r?\n?<<<END>>>/g,
        (_match, name) => `📄 File dibuat: **${name.trim()}**`
      );
    }

    // Document blocks carry a JSON spec that the server turns into a real
    // PDF/xlsx/docx/pptx, so chat can produce binaries without running code.
    const docBlocks = parseDocBlocks(assistantContent);
    if (docBlocks.length > 0) {
      const rendered = await writeDocuments(session.id, docBlocks);
      fileAttachments = [...fileAttachments, ...rendered.filter((a) => a.type === 'file')];
      const failed = rendered.filter((a) => a.type === 'error');
      assistantContent = assistantContent.replace(
        /<<<DOC:\s*(?:pdf|xlsx|docx|pptx|csv)\s*:\s*(.+?)\s*>>>\r?\n[\s\S]*?\r?\n?<<<END>>>/gi,
        (_match, name) => `📄 Dokumen dibuat: **${name.trim()}**`
      );
      if (failed.length) {
        assistantContent += `\n\n⚠️ Gagal membuat: ${failed.map((f) => `${f.name} (${f.error})`).join(', ')}`;
      }
    }

    // Save assistant message
    const assistantMessage = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        content: assistantContent,
        attachments: fileAttachments.length > 0 ? fileAttachments : undefined,
      }
    });

    return NextResponse.json({ 
      session: session,
      userMessage,
      assistantMessage
    });

  } catch (error) {
    console.error("Chat API Error Caught at Outer Block:", error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    
    if (!sessionId) {
      const type = searchParams.get('type') || 'chat';
      const whereClause = type === 'chat' 
        ? { goal: 'Chat session' } 
        : { goal: { not: 'Chat session' } };

      const sessions = await prisma.session.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        include: {
          messages: {
            take: 1,
            orderBy: { createdAt: 'asc' }
          },
          // Agent sessions need task status so the sidebar can show progress
          // (how many tasks are done vs pending) for each project.
          ...(type === 'agent'
            ? { tasks: { select: { id: true, status: true } } }
            : {}),
        }
      });
      return NextResponse.json({ sessions });
    }

    const history = await prisma.message.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ messages: history });
  } catch (error) {
    console.error("Fetch history error:", error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// Remove the on-disk workspaces for a session. Rejects names that are not plain
// slug/uuid tokens so a crafted sessionId can never escape the project dir.
async function removeWorkspaces(sessionId, workspaceName) {
  if (!isSafeDirName(sessionId)) return [];
  const names = new Set([sessionId]);
  // Sessions created before slugs kept the uuid, so clear both spellings.
  if (isSafeDirName(workspaceName)) names.add(workspaceName);

  const targets = [];
  for (const name of names) {
    targets.push(
      path.join('workspaces', name),
      path.join('chat-workspaces', name),
      // OpenCode's isolated HOME lives NEXT TO the workspace (see lib/opencode.js)
      // and is usually far larger than the workspace itself.
      path.join('workspaces', `.opencode-home-${name}`),
    );
  }
  const removed = [];
  for (const rel of targets) {
    const dir = path.join(process.cwd(), rel);
    try {
      await fs.rm(dir, { recursive: true, force: true });
      removed.push(rel);
    } catch (e) {
      console.error(`Failed to remove ${dir}:`, e.message);
    }
  }
  return removed;
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const deleteFiles = searchParams.get('deleteFiles') === 'true';

    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
    }

    // Read the slug before the row disappears, or the folder becomes orphaned.
    const workspaceName = deleteFiles ? await resolveWorkspaceName(sessionId) : null;

    await prisma.message.deleteMany({ where: { sessionId } });
    await prisma.task.deleteMany({ where: { sessionId } });
    await prisma.session.delete({ where: { id: sessionId } });

    const removed = deleteFiles ? await removeWorkspaces(sessionId, workspaceName) : [];

    return NextResponse.json({ success: true, removed });
  } catch (error) {
    console.error("Delete session error:", error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
