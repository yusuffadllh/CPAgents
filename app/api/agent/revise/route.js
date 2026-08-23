import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { cleanGoalInput, buildBudgetedPrompt, fetchChatWithRetry, parseChatCompletion } from '@/lib/context';

export const dynamic = 'force-dynamic';

const DEPLOY_TASK_RE = /deploy|publish|luncurkan|terbitkan|online|go.?live|hosting/i;

function parseTasks(content) {
  if (!content) return null;
  const trimmed = content.trim();
  try {
    const whole = JSON.parse(trimmed);
    if (Array.isArray(whole)) return whole;
  } catch {}
  const block = trimmed.match(/\[[\s\S]*\]/);
  if (block) {
    try {
      const arr = JSON.parse(block[0]);
      if (Array.isArray(arr)) return arr;
    } catch {}
  }
  const objects = [...trimmed.matchAll(/\{\s*"description"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)];
  if (objects.length) return objects.map((m) => ({ description: JSON.parse(`"${m[1]}"`) }));
  return null;
}

export async function POST(request) {
  try {
    const { sessionId, feedback: rawFeedback } = await request.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }
    if (!rawFeedback || !rawFeedback.trim()) {
      return NextResponse.json({ error: 'feedback is required' }, { status: 400 });
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: { tasks: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const feedback = buildBudgetedPrompt(
      [{ text: cleanGoalInput(rawFeedback), truncatable: true }],
      60000,
    );

    // Clear the old backlog: unfinished work from the previous plan is obsolete
    // once the user has seen the deployed result and asked for changes. The
    // deploy marker is kept so the manual Deploy button still has its task.
    const stale = session.tasks.filter(
      (t) =>
        !DEPLOY_TASK_RE.test(t.description || '') &&
        (t.status === 'PENDING' || t.status === 'RUNNING' || t.status === 'FAILED'),
    );
    if (stale.length > 0) {
      await prisma.task.deleteMany({ where: { id: { in: stale.map((t) => t.id) } } });
    }
    const deployMarker = session.tasks.find((t) => DEPLOY_TASK_RE.test(t.description || ''));

    const doneSummary = session.tasks
      .filter((t) => t.status === 'COMPLETED' && !DEPLOY_TASK_RE.test(t.description || ''))
      .slice(-8)
      .map((t, i) => `${i + 1}. ${t.description}`)
      .join('\n');

    const systemPrompt = `You are an AI planner handling a REVISION request. The project already exists and is deployed; the user has seen it and is telling you what to change.

Turn the user's feedback into concrete, ordered revision tasks against the EXISTING codebase.

Rules:
- Only address what the feedback asks for, plus whatever is strictly required to make those changes work. Do NOT re-plan or rebuild the whole project.
- Each task must be a small, verifiable edit to existing files (e.g. "Update Hero section in src/components/Hero.tsx to use the real GitHub and LinkedIn links"). Prefer modifying files over recreating them.
- Carry the user's literal details (URLs, names, wording, colours) verbatim into the task descriptions so the executor uses the real values instead of inventing placeholders.
- If the feedback mentions responsiveness or visual quality, make that an explicit task naming the affected views/breakpoints.
- Never add a task requiring data the user did not provide.

Respond with ONLY a valid JSON array: [{"description": "..."}, {"description": "..."}]`;

    const userPrompt = [
      `Original goal:\n${session.goal}`,
      doneSummary ? `Already completed previously:\n${doneSummary}` : null,
      `User's revision feedback (this is what must be addressed now):\n${feedback}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    const response = await fetchChatWithRetry(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'AI Chat App',
      },
      body: JSON.stringify({
        model: settings.modelName || 'google/gemini-2.5-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Revise API error:', response.status, errorText);
      return NextResponse.json(
        { error: 'Failed to communicate with the model gateway', details: errorText },
        { status: response.status },
      );
    }

    const data = parseChatCompletion(await response.text());
    const content = data?.choices?.[0]?.message?.content;
    const parsed = parseTasks(content);

    if (!parsed || parsed.length === 0) {
      return NextResponse.json(
        { error: 'Model did not return revision tasks', details: (content || '').slice(0, 500) },
        { status: 502 },
      );
    }

    await prisma.message.create({
      data: { sessionId, role: 'user', content: `**[Revisi]**\n\n${feedback}` },
    });

    // Sequential createdAt keeps the loop running these in the intended order.
    const base = Date.now();
    const created = [];
    for (let i = 0; i < parsed.length; i++) {
      const description = String(parsed[i].description || '').trim();
      if (!description) continue;
      created.push(
        await prisma.task.create({
          data: { sessionId, description, createdAt: new Date(base + i) },
        }),
      );
    }

    // Reopen the deploy marker (and move it after the new work) so the revised
    // build gets published again instead of counting as already deployed.
    if (deployMarker) {
      await prisma.task.update({
        where: { id: deployMarker.id },
        data: { status: 'PENDING', result: null, createdAt: new Date(base + parsed.length + 1) },
      });
    }

    const tasks = await prisma.task.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({ success: true, removed: stale.length, added: created.length, tasks });
  } catch (error) {
    console.error('Revise route error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
