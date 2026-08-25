import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { runOpencode } from '@/lib/opencode';
import { buildBudgetedPrompt } from '@/lib/context';
import { resolveWorkspaceName } from '@/lib/workspace';
import { deployRules, gitPushRules } from '@/lib/deploy-rules';

export const dynamic = 'force-dynamic';
// Executor runs long-lived agent processes; allow up to ~60 min (must stay >=
// OpenCode's own maxTimeoutMs so the run isn't cut off by the HTTP route).
export const maxDuration = 3600;

// Must stay in sync with the copies in app/page.js and the revise route.
const DEPLOY_TASK_RE = /deploy|publish|luncurkan|terbitkan|online|go.?live|hosting/i;
const PUSH_TASK_RE = /\bpush\b|\bgithub\b|\brepo(sitory)?\b/i;

// Count files under `dir` that were created/modified at or after `sinceMs`.
// Skips the isolated OpenCode home dir and node_modules/.git so we only measure
// real work the task produced. Used to catch "false completed" runs where the
// model exits 0 without actually building anything.
async function countChangedFiles(dir, sinceMs) {
  let changed = 0;
  const walk = async (d) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const name = e.name;
      if (name === 'node_modules' || name === '.git' || name.startsWith('.opencode')) continue;
      const full = path.join(d, name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs >= sinceMs - 1000) changed += 1;
        } catch { /* ignore */ }
      }
    }
  };
  await walk(dir);
  return changed;
}

export async function POST(request) {
  try {
    const { sessionId, taskId } = await request.json();
    if (!sessionId || !taskId) {
      return NextResponse.json({ error: 'sessionId and taskId are required' }, { status: 400 });
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    const existingTask = await prisma.task.findUnique({ where: { id: taskId } });
    if (!existingTask) {
      return NextResponse.json({ error: 'Task no longer exists' }, { status: 404 });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        tasks: { orderBy: { createdAt: 'asc' } },
        messages: { orderBy: { createdAt: 'asc' } }
      }
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const currentTask = session.tasks.find(t => t.id === taskId);
    if (!currentTask) {
      return NextResponse.json({ error: 'Task not found in session' }, { status: 404 });
    }

    // Build a compact prompt: overall goal + only the last 2 completed tasks
    // for continuity. Injecting every prior result bloats the prompt (and can
    // stall the gateway), so keep it short.
    const priorContext = session.tasks
      .filter((t) => t.id !== taskId && t.status === 'COMPLETED' && t.result)
      .slice(-2)
      .map((t, i) => `Previous task ${i + 1}: ${t.description}\nResult summary: ${(t.result || '').slice(0, 300)}`)
      .join('\n\n');

    const rules = [
      `IMPORTANT RULES:`,
      `- You are running fully autonomously with NO human to answer questions. NEVER ask for confirmation or reply with a question like "Would you like me to...". Just DO the work.`,
      `- The working directory may be EMPTY at the start — that is expected and normal. Do NOT go looking through the filesystem for existing files, and NEVER inspect, list, cd into, or read hidden/system folders (anything starting with a dot like .opencode-home, or node_modules). Just start creating the files this task needs.`,
      `- Do the task in AT MOST a few steps. If this is a planning/analysis/design task, do NOT browse the filesystem at all — just write your plan/output to a Markdown file (e.g. PLAN.md or an appropriately named .md file) and finish.`,
      `- Actually create and modify real files and run the commands needed to COMPLETE this task now. Do not merely describe or propose.`,
      `- KEEP EVERY OUTPUT SMALL AND INCREMENTAL FROM THE START. Do NOT emit one big response or one giant file write — the tool call fails ("exit code 1" / JSON parse error) when a single payload is too large. Always begin with a small first chunk, then build up gradually with several follow-up edits/appends. Never emit a single write bigger than ~150 lines.`,
      `- Work only inside the current directory and only with files relevant to the goal.`,
      `NEVER INVENT THE USER'S DATA:`,
      `- Real personal data (name, bio, links to GitHub/LinkedIn/email, project list, work history, photos) may ONLY come from what the user wrote in the goal, or from files already in the working directory.`,
      `- If a piece of that data was not given, do NOT make one up and do NOT write a fake placeholder like "John Doe", "lorem ipsum", "example.com", "https://github.com/username" or a stock avatar. Instead omit that element, or read the value from a single obvious content file (e.g. src/data/profile.json) so the user can fill it in later.`,
      `- Never fabricate project descriptions, achievements, testimonials, statistics, or client logos.`,
      `IF THIS TASK PRODUCES UI:`,
      `- Mobile-first and fully responsive is mandatory. Every layout must work at 360px width with no horizontal scroll, and scale up cleanly to desktop. Use responsive utilities/media queries on every grid, flex row, font size and spacing — never a fixed pixel width on a container.`,
      `- Do not ship a bare unstyled page. Apply a coherent visual design: a real colour palette, consistent spacing scale, readable typographic hierarchy, hover/focus states, and rounded/shadowed surfaces where appropriate. Aim for something a developer would be happy to show an employer.`,
      `- Implement EVERY section the goal asks for. Before finishing, re-read the goal and check each requested section actually exists and is wired up. A missing section counts as an incomplete task.`,
      `- Semantic HTML and basic a11y: real heading levels, alt text, labels on inputs, keyboard-focusable interactive elements.`,
      `IF THIS TASK ASKS FOR A DOCUMENT (PDF, Excel, Word, PowerPoint, CSV, chart):`,
      `- Produce the REAL binary file, not a description of it and not a Markdown stand-in. Node.js and npm are available; install what you need with \`npm install <pkg>\` inside the working directory, then run a small script with \`node\` to generate the file.`,
      `- Recommended libraries: PDF -> \`pdfkit\` (pure JS, always works — prefer this); Excel .xlsx -> \`exceljs\` (styling, formulas, multiple sheets) or \`xlsx\`; Word .docx -> \`docx\`; PowerPoint .pptx -> \`pptxgenjs\`; CSV -> write it directly; charts to embed -> \`chartjs-node-canvas\`.`,
      `- \`puppeteer\` gives the prettiest PDFs (renders styled HTML) but needs system Chrome libraries that may be missing on this server. You may try it, but if the browser fails to launch do NOT keep retrying or try to apt-get anything — switch to \`pdfkit\` immediately and finish the task.`,
      `- If Python is available and you prefer it, \`openpyxl\`, \`python-docx\`, \`reportlab\` and \`python-pptx\` are equally acceptable. Pick ONE toolchain and stick to it.`,
      `- Write the generator script to a file (e.g. \`generate-report.js\`), run it, then VERIFY the output exists and is non-empty with \`ls -l\`. A script that was written but never executed means the task FAILED.`,
      `- Save the document in the current directory (or a clear subfolder like \`output/\`) with a descriptive filename and the correct extension.`,
      `- Fill it with the real content the goal asks for. Never ship an empty template or lorem-ipsum rows.`,
      `- At the end, print the exact filename(s) you produced so the user knows what to download.`,
      `- When the task is fully done, end IMMEDIATELY with a short summary of the concrete files you created/changed. Do not keep exploring after the deliverable exists.`,
    ].join('\n');

    // Match on THIS task only. Matching the goal too meant that a goal like
    // "build a site and deploy it" put deploy instructions in every task, so
    // the agent could publish a half-finished project on step 1.
    const wantsDeploy = DEPLOY_TASK_RE.test(currentTask.description || '');
    const repoUrl = (`${currentTask.description}\n${session.goal}`.match(
      /https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?/,
    ) || [])[0];

    // Commit after every task so progress is recoverable; push and deploy only
    // when the task itself is about that.
    const taskRules = wantsDeploy
      ? deployRules(settings, { repoUrl, context: 'task' })
      : gitPushRules(settings, repoUrl, { allowPush: PUSH_TASK_RE.test(currentTask.description || '') });

    // Assemble the prompt within a token budget. Rules + current task are
    // essential (never truncated); the overall goal and prior-task context are
    // truncated first if we approach the limit — so the payload starts small
    // and stays under ~150k tokens.
    const prompt = buildBudgetedPrompt(
      [
        { text: `IMPORTANT RULES ARE BELOW — follow them strictly.`, priority: 10, truncatable: false },
        { text: `Your current task: ${currentTask.description}`, priority: 9, truncatable: false },
        taskRules ? { text: taskRules, priority: 9, truncatable: false } : null,
        { text: rules, priority: 8, truncatable: false },
        { text: `Overall goal: ${session.goal}`, priority: 5, truncatable: true },
        priorContext ? { text: `Context from earlier tasks:\n${priorContext}`, priority: 1, truncatable: true } : null,
      ].filter(Boolean),
      150000,
    );

    const encoder = new TextEncoder();
    const signal = request.signal;

    const stream = new ReadableStream({
      async start(controller) {
        const pingInterval = setInterval(() => {
          try { controller.enqueue(encoder.encode(`:\n\n`)); } catch {}
        }, 15000);

        const sendEvent = (type, payload) => {
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`));
          } catch {}
        };

        const finish = () => {
          clearInterval(pingInterval);
          try { controller.close(); } catch {}
        };

        try {
          await prisma.task.updateMany({ where: { id: taskId }, data: { status: 'RUNNING' } });

          // Isolated workspace directory for this session.
          const workspaceName = await resolveWorkspaceName(sessionId);
          const workspaceDir = path.join(process.cwd(), 'workspaces', workspaceName);
          await fs.mkdir(workspaceDir, { recursive: true });

          sendEvent('log', { message: `🚀 Menjalankan OpenCode untuk task: ${currentTask.description}` });
          sendEvent('log', { message: `📁 Workspace: workspaces/${workspaceName}` });

          const capturedLines = [];
          let exitCode = 0;
          const runStartedAt = Date.now();

          try {
            exitCode = await runOpencode({
              prompt,
              cwd: workspaceDir,
              settings,
              signal,
              allowDeploy: wantsDeploy,
              onOutput: (line) => {
                capturedLines.push(line);
                // Cap forwarded log volume to keep the UI responsive.
                if (capturedLines.length <= 2000) {
                  sendEvent('log', { message: line });
                }
              },
            });
          } catch (runErr) {
            const hint = /ENOENT/.test(runErr.message)
              ? ' — Pastikan "opencode" terinstall & ada di PATH (set OPENCODE_BIN bila perlu).'
              : '';
            sendEvent('log', { message: `❌ Gagal menjalankan OpenCode: ${runErr.message}${hint}` });
            await prisma.task.updateMany({ where: { id: taskId }, data: { status: 'PENDING' } });
            sendEvent('error', { error: 'OpenCode execution failed', details: runErr.message });
            finish();
            return;
          }

          if (signal && signal.aborted) {
            // Record what the run managed to do before the stop: the workspace
            // keeps those edits, so a blind re-run would redo them from scratch.
            const partial = capturedLines.join('\n').slice(-8000);
            let touched = 0;
            try { touched = await countChangedFiles(workspaceDir, runStartedAt); } catch {}
            await prisma.task.updateMany({
              where: { id: taskId },
              data: {
                status: 'PENDING',
                result: `⛔ Dihentikan oleh user (${touched} file sempat dibuat/diubah).\n\n**Output sebelum berhenti:**\n\`\`\`text\n${partial || '(belum ada output)'}\n\`\`\``,
              },
            });
            sendEvent('log', { message: `⛔ Eksekusi dihentikan. ${touched} file sempat berubah dan tetap tersimpan di workspace.` });
            const stoppedTasks = await prisma.task.findMany({
              where: { sessionId },
              orderBy: { createdAt: 'asc' },
            });
            sendEvent('done', { tasks: stoppedTasks });
            finish();
            return;
          }

          const rawOutput = capturedLines.join('\n');
          const truncated = rawOutput.length > 20000
            ? rawOutput.slice(-20000) + '\n... (log dipotong)'
            : rawOutput;

          // OpenCode can exit 0 even when the run never produced any work — e.g.
          // the gateway rejected auth (401) or the model stream errored. Treat
          // those as FAILED so the task isn't falsely marked COMPLETED.
          const failureSignals = [
            /\bAI_APICallError\b/i,
            /level=ERROR[^\n]*stream error/i,
            /\[401\]|\bAuthentication Error\b|Invalid proxy server token/i,
            /\bRateLimitError\b/i,
            /\b5\d\d\]:/, // 5xx from the gateway
          ];
          const outputLooksFailed = failureSignals.some((re) => re.test(rawOutput));
          const producedNoOutput = rawOutput.trim().length === 0;

          // Real work must touch the filesystem. If the run exits 0 with no
          // errors but created/modified NO files, the model almost certainly
          // gave up or only "described" the work — a false completion.
          let changedFiles = 0;
          try { changedFiles = await countChangedFiles(workspaceDir, runStartedAt); } catch {}
          // Planning/analysis tasks legitimately produce just a .md file, which
          // the file walk still counts — so "0 changed files" is a reliable
          // failure signal for any task type.
          const producedNoFiles = changedFiles === 0;

          const success =
            exitCode === 0 && !outputLooksFailed && !producedNoOutput && !producedNoFiles;

          let header;
          if (success) {
            header = `✅ OpenCode selesai (exit ${exitCode}, ${changedFiles} file dibuat/diubah).`;
          } else if (outputLooksFailed) {
            header = `❌ Task GAGAL — gateway/model menolak permintaan (cek API key & model di Settings). Silakan mulai ulang task ini.`;
          } else if (producedNoOutput) {
            header = `❌ Task GAGAL — OpenCode tidak menghasilkan output apa pun. Silakan mulai ulang task ini.`;
          } else if (producedNoFiles) {
            header = `❌ Task GAGAL — tidak ada file yang dibuat/diubah, jadi task ini belum benar-benar dikerjakan. Silakan mulai ulang task ini.`;
          } else {
            header = `❌ Task GAGAL — OpenCode keluar dengan exit code ${exitCode}. Silakan mulai ulang task ini.`;
          }

          const formattedOutput = `${header}\n\n**OpenCode Output:**\n\`\`\`text\n${truncated || '(tidak ada output)'}\n\`\`\``;

          // Mark FAILED on any real failure (non-zero exit, auth/stream error in
          // the output, or no output) so the UI shows a clear failure the user
          // can restart, instead of a misleading "completed".
          await prisma.task.updateMany({
            where: { id: taskId },
            data: { status: success ? 'COMPLETED' : 'FAILED', result: formattedOutput },
          });

          try {
            await prisma.message.create({
              data: {
                sessionId,
                role: 'executor',
                content: `**[Task: ${currentTask.description}]**\n\n${formattedOutput}`,
              },
            });
          } catch {}

          const updatedTasks = await prisma.task.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'asc' },
          });

          sendEvent('log', { message: '🏁 Task selesai.' });
          sendEvent('done', { tasks: updatedTasks });
          finish();
        } catch (error) {
          sendEvent('error', { error: 'Internal server error', details: error.message });
          finish();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error("Execute API Error:", error.message);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
