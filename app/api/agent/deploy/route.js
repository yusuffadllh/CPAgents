import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { runOpencode } from '@/lib/opencode';
import { buildBudgetedPrompt } from '@/lib/context';

export const dynamic = 'force-dynamic';
// Deploy can take a while (install + build + upload); allow up to ~30 min.
export const maxDuration = 3600;

// Vercel project names: lowercase, alphanumeric + dashes, <=100 chars.
function slugifyProjectName(raw) {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

export async function POST(request) {
  try {
    const { sessionId, projectName: rawProjectName } = await request.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    const projectName = slugifyProjectName(rawProjectName);

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    if (!settings.vercelToken && !settings.netlifyToken) {
      return NextResponse.json(
        { error: 'No deploy credentials configured. Set a Vercel or Netlify token in Settings.' },
        { status: 400 },
      );
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Build a deploy-only instruction listing only the platforms whose token
    // is configured. The tokens themselves are injected as env vars by
    // runOpencode, so the model never sees or prints them.
    const deployTargets = [];
    if (settings.vercelToken) {
      // `vercel link` first so a re-deploy overwrites the same project instead of
      // creating a new one (the old `--name` flag is deprecated and unreliable).
      const vercelSteps = projectName
        ? [
            `- Vercel (env VERCEL_TOKEN is set), run these two commands from the project root:`,
            `  1. \`npx --yes vercel link --yes --project "${projectName}" --token="$VERCEL_TOKEN"\` — links this directory to the project "${projectName}", creating it only if it does not exist yet. This is what makes a re-deploy overwrite the SAME project.`,
            `  2. \`npx --yes vercel deploy --prod --yes --token="$VERCEL_TOKEN"\` — do NOT pass --name, it is deprecated.`,
            `  The site will be reachable at https://${projectName}.vercel.app once live.`,
          ]
        : [
            `- Vercel (env VERCEL_TOKEN is set): run \`npx --yes vercel deploy --prod --yes --token="$VERCEL_TOKEN"\` from the project root. Vercel auto-detects the framework.`,
          ];
      deployTargets.push(...vercelSteps);
    }
    if (settings.netlifyToken) {
      deployTargets.push(
        `- Netlify (env NETLIFY_AUTH_TOKEN is set): build first if needed, then run \`npx --yes netlify deploy --prod --dir=<build-output-dir> --auth "$NETLIFY_AUTH_TOKEN"\` (use the correct output dir: dist/build/out/ or . for static).${projectName ? ` If Netlify asks for a site name, use "${projectName}".` : ''}`,
      );
    }

    const prompt = buildBudgetedPrompt(
      [
        {
          text: `You are deploying an already-built project that lives in the current working directory. Your ONLY job is to publish it live and report the URL.`,
          priority: 10,
          truncatable: false,
        },
        {
          text: [
            `DEPLOY INSTRUCTIONS:`,
            `- Prefer Vercel for Next.js/frontend apps, Netlify for static sites. Pick ONE platform below and deploy.`,
            ...deployTargets,
            `- The credentials are already provided via environment variables. Do NOT ask for tokens or logins, and NEVER print token values.`,
            projectName
              ? `- The desired project/site name is "${projectName}". On Vercel this is set by \`vercel link --project "${projectName}"\` (see above), NOT by --name and NOT by a "name" key in vercel.json. If a project with that name already exists it will be reused and this deploy overwrites its production — that is the intended behaviour.`
              : `- Let the platform pick the project name automatically.`,
            `- Install dependencies and build only if the platform needs it. Keep every command small.`,
            `- If a deploy command fails, read the error and try the correct fix once; do not loop forever.`,
            `VERCEL vercel.json RULES (read carefully, these cause silent 404s):`,
            `- If vercel.json uses a "services" object, every service is PRIVATE by default. You MUST add a TOP-LEVEL "rewrites" array that exposes it, e.g. {"rewrites":[{"source":"/(.*)","destination":{"service":"frontend"}}]}. A "rewrites" array placed INSIDE a service only runs after the request already entered that service, so without the top-level rewrite the whole site returns 404 even though the build succeeds.`,
            `- In "services" mode the keys buildCommand, installCommand, outputDirectory, framework, devCommand, ignoreCommand and functions are NOT allowed at the top level; move them inside the relevant service. "framework" must be a string (e.g. "vite", "nextjs"), never null.`,
            `- The "name" property in vercel.json is deprecated; do not add it.`,
            `- For a simple single-app project, prefer NO "services" key at all — just top-level buildCommand/outputDirectory/framework.`,
            `VERIFY BEFORE REPORTING SUCCESS:`,
            `- After the deploy reports Ready, run \`curl -s -o /dev/null -w "%{http_code}" <live-url>\` on the final URL.`,
            `- If the status is 404 or 5xx, the deploy is NOT done: diagnose (usually routing/output directory), fix the config, redeploy, and re-check. Only report success once the URL returns 200 (or 3xx to a working page).`,
            `- At the very end, print the final live URL on its own line prefixed with "LIVE URL: ".`,
            `- Do NOT explore hidden/system folders. Work only in the current directory.`,
          ].join('\n'),
          priority: 9,
          truncatable: false,
        },
        { text: `Project goal (for context): ${session.goal}`, priority: 3, truncatable: true },
      ],
      120000,
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
          const workspaceDir = path.join(process.cwd(), 'workspaces', sessionId);
          await fs.mkdir(workspaceDir, { recursive: true });

          sendEvent('log', { message: `🚀 Memulai deploy untuk project ini...` });
          sendEvent('log', { message: `📁 Workspace: workspaces/${sessionId}` });

          const capturedLines = [];
          let exitCode = 0;

          try {
            exitCode = await runOpencode({
              prompt,
              cwd: workspaceDir,
              settings,
              signal,
              onOutput: (line) => {
                capturedLines.push(line);
                if (capturedLines.length <= 2000) {
                  sendEvent('log', { message: line });
                }
              },
            });
          } catch (runErr) {
            sendEvent('log', { message: `❌ Gagal menjalankan deploy: ${runErr.message}` });
            sendEvent('error', { error: 'Deploy failed', details: runErr.message });
            finish();
            return;
          }

          if (signal && signal.aborted) {
            sendEvent('log', { message: '⛔ Deploy dibatalkan oleh user.' });
            sendEvent('done', {});
            finish();
            return;
          }

          const rawOutput = capturedLines.join('\n');
          const truncated = rawOutput.length > 20000
            ? rawOutput.slice(-20000) + '\n... (log dipotong)'
            : rawOutput;

          // Try to surface the live URL from the output.
          const urlMatch = rawOutput.match(/LIVE URL:\s*(\S+)/i)
            || rawOutput.match(/https?:\/\/[^\s"']+\.(?:vercel\.app|netlify\.app)[^\s"']*/i);
          const liveUrl = urlMatch ? (urlMatch[1] || urlMatch[0]) : null;

          // A green build does not mean a working site: a bad vercel.json routing
          // table still deploys fine but serves 404 on every path.
          let urlStatus = null;
          if (liveUrl && /^https?:\/\//i.test(liveUrl)) {
            try {
              const check = await fetch(liveUrl, { redirect: 'follow' });
              urlStatus = check.status;
              if (urlStatus >= 400) {
                sendEvent('log', {
                  message: `⚠️ URL merespons HTTP ${urlStatus} — deploy terbangun tapi situs belum bisa diakses (biasanya routing/output directory di vercel.json salah).`,
                });
              } else {
                sendEvent('log', { message: `✅ URL merespons HTTP ${urlStatus}.` });
              }
            } catch (e) {
              sendEvent('log', { message: `⚠️ Tidak bisa memverifikasi URL: ${e.message}` });
            }
          }

          const deployOk = exitCode === 0 && (urlStatus === null || urlStatus < 400);
          const header = deployOk
            ? `✅ Deploy selesai (exit ${exitCode}).`
            : `⚠️ Deploy selesai dengan exit code ${exitCode}${urlStatus >= 400 ? `, tapi URL mengembalikan HTTP ${urlStatus}` : ''}.`;

          const urlLine = liveUrl
            ? `\n\n🌐 **Live URL:** ${liveUrl}${urlStatus ? ` (HTTP ${urlStatus})` : ''}`
            : '';
          const formattedOutput = `${header}${urlLine}\n\n**Deploy Output:**\n\`\`\`text\n${truncated || '(tidak ada output)'}\n\`\`\``;

          try {
            await prisma.message.create({
              data: {
                sessionId,
                role: 'executor',
                content: `**[Deploy]**\n\n${formattedOutput}`,
              },
            });
          } catch {}

          if (liveUrl) sendEvent('log', { message: `🌐 Live URL: ${liveUrl}` });
          sendEvent('log', { message: '🏁 Deploy selesai.' });
          sendEvent('done', { liveUrl, urlStatus, ok: deployOk });
          finish();
        } catch (error) {
          sendEvent('error', { error: 'Internal server error', details: error.message });
          finish();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    console.error('Deploy API Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
