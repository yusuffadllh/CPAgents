import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { cleanGoalInput, buildBudgetedPrompt, fetchChatWithRetry, parseChatCompletion } from '@/lib/context';

export const dynamic = 'force-dynamic';

const DEPLOY_TASK_RE = /deploy|publish|luncurkan|terbitkan|online|go.?live|hosting/i;

// Accepts the {tasks, obsolete} object, but still tolerates a bare array so a
// model that ignores the schema degrades to "revise, keep the backlog".
function parseRevision(content) {
  if (!content) return null;
  const trimmed = content.trim().replace(/```json/gi, '').replace(/```/g, '').trim();

  const shape = (value) => {
    if (Array.isArray(value)) return { tasks: value, obsolete: [] };
    if (value && Array.isArray(value.tasks)) {
      return {
        tasks: value.tasks,
        obsolete: Array.isArray(value.obsolete) ? value.obsolete : [],
      };
    }
    return null;
  };

  try {
    const parsed = shape(JSON.parse(trimmed));
    if (parsed) return parsed;
  } catch {}

  const objBlock = trimmed.match(/\{[\s\S]*\}/);
  if (objBlock) {
    try {
      const parsed = shape(JSON.parse(objBlock[0]));
      if (parsed) return parsed;
    } catch {}
  }

  const arrBlock = trimmed.match(/\[[\s\S]*\]/);
  if (arrBlock) {
    try {
      const parsed = shape(JSON.parse(arrBlock[0]));
      if (parsed) return parsed;
    } catch {}
  }

  const objects = [...trimmed.matchAll(/\{\s*"description"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g)];
  if (objects.length) {
    return { tasks: objects.map((m) => ({ description: JSON.parse(`"${m[1]}"`) })), obsolete: [] };
  }
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

    // The unfinished backlog is NOT blindly discarded: a revision can arrive
    // mid-build (user hit Stop at task 2 of 10), where the remaining tasks are
    // still the rest of the project. The planner decides which ones the
    // feedback actually invalidates. The deploy marker is excluded — it is
    // owned by the Deploy button.
    const backlog = session.tasks.filter(
      (t) =>
        !DEPLOY_TASK_RE.test(t.description || '') &&
        (t.status === 'PENDING' || t.status === 'RUNNING' || t.status === 'FAILED'),
    );
    const deployMarker = session.tasks.find((t) => DEPLOY_TASK_RE.test(t.description || ''));

    const doneSummary = session.tasks
      .filter((t) => t.status === 'COMPLETED' && !DEPLOY_TASK_RE.test(t.description || ''))
      .slice(-8)
      .map((t, i) => `${i + 1}. ${t.description}`)
      .join('\n');

    const backlogList = backlog
      .map((t, i) => `[${i}] (${t.status}) ${t.description}`)
      .join('\n');

    const systemPrompt = `You are an AI planner handling a REVISION request on an EXISTING project. The user has seen the current result and is telling you what to change.

You get two jobs:

1. "tasks" — turn the feedback into concrete, ordered revision tasks against the existing codebase.
2. "obsolete" — decide which items of the remaining backlog the feedback has invalidated.

Rules for "tasks":
- Only address what the feedback asks for, plus whatever is strictly required to make those changes work. Do NOT re-plan or rebuild the whole project.
- Each task must be a small, verifiable edit to existing files (e.g. "Update Hero section in src/components/Hero.tsx to use the real GitHub and LinkedIn links"). Prefer modifying files over recreating them.
- Carry the user's literal details (URLs, names, wording, colours) verbatim into the task descriptions so the executor uses the real values instead of inventing placeholders.
- If the feedback mentions responsiveness or visual quality, make that an explicit task naming the affected views/breakpoints.
- Never add a task requiring data the user did not provide.
- If a backlog item is still needed but must be done differently, mark it obsolete AND write a replacement task.

Rules for "obsolete":
- List ONLY the [index] numbers of backlog items that the feedback makes pointless or contradicts, or that your new tasks fully supersede.
- The backlog may simply be the unbuilt remainder of the project. Work that the feedback never mentions MUST be kept — do not drop it just because it has not run yet.
- If a backlog item is still valid, leave it out of "obsolete". Empty list is a valid answer.

Respond with ONLY valid JSON: {"tasks": [{"description": "..."}], "obsolete": [0, 2]}`;

    const userPrompt = [
      `Original goal:\n${session.goal}`,
      doneSummary ? `Already completed previously:\n${doneSummary}` : null,
      backlogList
        ? `Remaining backlog (not done yet, decide which are now obsolete):\n${backlogList}`
        : 'Remaining backlog: (empty)',
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
    const revision = parseRevision(content);

    if (!revision || revision.tasks.length === 0) {
      return NextResponse.json(
        { error: 'Model did not return revision tasks', details: (content || '').slice(0, 500) },
        { status: 502 },
      );
    }
    const parsed = revision.tasks;

    // Drop only what the planner flagged, and only after it answered — a failed
    // call must not leave the backlog already deleted. Indices are integer-
    // checked because Number(null) is 0, which would silently delete task 0.
    const obsoleteIds = [...new Set(revision.obsolete)]
      .map((i) => {
        if (typeof i === 'number') return i;
        if (typeof i === 'string' && i.trim() !== '') return Number(i);
        return NaN;
      })
      .filter((i) => Number.isInteger(i) && i >= 0 && i < backlog.length)
      .map((i) => backlog[i].id);
    if (obsoleteIds.length > 0) {
      await prisma.task.deleteMany({ where: { id: { in: obsoleteIds }, sessionId } });
    }
    const keptCount = backlog.length - obsoleteIds.length;

    await prisma.message.create({
      data: { sessionId, role: 'user', content: `**[Revisi]**\n\n${feedback}` },
    });

    // The loop picks tasks by ascending createdAt, so the revision must be
    // stamped BEFORE any surviving backlog item to run first. Anchor it just
    // under the earliest kept task instead of at "now".
    const keptTasks = backlog.filter((t) => !obsoleteIds.includes(t.id));
    const earliestKept = keptTasks.reduce(
      (min, t) => Math.min(min, new Date(t.createdAt).getTime()),
      Infinity,
    );
    const base = Number.isFinite(earliestKept)
      ? earliestKept - parsed.length - 1
      : Date.now();

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

    // Reopen the deploy marker and push it past everything still queued so the
    // revised build gets published once all remaining work is done.
    if (deployMarker) {
      const latest = session.tasks.reduce(
        (max, t) => Math.max(max, new Date(t.createdAt).getTime()),
        base + parsed.length,
      );
      await prisma.task.update({
        where: { id: deployMarker.id },
        data: { status: 'PENDING', result: null, createdAt: new Date(latest + 1000) },
      });
    }

    const tasks = await prisma.task.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json({
      success: true,
      removed: obsoleteIds.length,
      kept: keptCount,
      added: created.length,
      tasks,
    });
  } catch (error) {
    console.error('Revise route error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
