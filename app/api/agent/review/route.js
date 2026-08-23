import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { buildBudgetedPrompt, fetchChatWithRetry, parseChatCompletion } from '@/lib/context';

// Turn the model's reply into a task array, tolerating replies where the JSON
// is wrapped in prose (e.g. "Every single... [ {..} ]"). Returns [] if none.
function parseReviewTasks(text) {
  if (!text) return [];
  const tryParse = (s) => {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) return v;
      if (v && Array.isArray(v.tasks)) return v.tasks;
    } catch { /* ignore */ }
    return null;
  };

  // 1. Whole reply is valid JSON.
  let out = tryParse(text.trim());
  if (out) return out;

  // 2. Extract the first [...] block and parse that.
  const first = text.indexOf('[');
  const last = text.lastIndexOf(']');
  if (first !== -1 && last > first) {
    out = tryParse(text.slice(first, last + 1));
    if (out) return out;
  }

  // 3. Last resort: collect any {"description": "..."} objects in the text.
  const objs = [];
  const re = /\{\s*"description"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    objs.push({ description: m[1].replace(/\\"/g, '"') });
  }
  return objs;
}

export async function POST(request) {
  try {
    const { sessionId } = await request.json();
    if (!sessionId) {
      return NextResponse.json({ error: 'sessionId is required' }, { status: 400 });
    }

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    const session = await prisma.session.findUnique({
      where: { id: sessionId },
      include: {
        tasks: { orderBy: { createdAt: 'asc' } }
      }
    });

    if (!session) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    // Format previous tasks for context. Cap each result, then apply an overall
    // token budget (most recent tasks kept first) so the review prompt never
    // starts out as an oversized payload the gateway rejects.
    const taskContext = buildBudgetedPrompt(
      session.tasks
        .map((t, i) => ({
          text: `Task ${i + 1} [${t.status}]: ${t.description}\nResult: ${(t.result || 'No output').slice(0, 600)}`,
          // Newer tasks matter more for the review, so give them higher priority.
          priority: i,
          truncatable: true,
        }))
        .reverse(),
      120000,
    );

    const systemPrompt = `You are the Reviewer Agent in an autonomous AI loop.
The user's original goal is: "${session.goal}"

Here are all the tasks that have been executed so far and their results:
${taskContext}

Your job is to critically review the work done so far. Ask yourself:
1. Is the goal completely fully achieved?
2. Are there any security vulnerabilities in the proposed solutions?
3. Are there edge cases or missing components that were overlooked?
4. How can the code/solution be further optimized, refactored, or documented?

CRITICAL INSTRUCTION: You MUST NEVER respond with an empty array [].
The user wants continuous, never-ending improvements. If the current work seems perfect, you MUST find something else to improve (e.g., add advanced error handling, optimize performance, write comprehensive documentation, add security hardening, create unit tests).
ALWAYS generate NEW tasks (as many as genuinely needed — usually 1 to 5, more for big gaps) to continuously improve the project. Prefer small, incremental, sequential tasks over a few huge ones.
Respond ONLY with a valid JSON array of objects. Format: [{"description": "Refactor X to improve Y"}, {"description": "Add Z for security"}]`;

    const response = await fetchChatWithRetry(`${settings.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${settings.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: settings.modelName || 'google/gemini-2.5-pro',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Review the progress and output new tasks if necessary (empty array if perfect).' }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json({ error: 'Failed to communicate with API', details: errorText }, { status: response.status });
    }

    const rawText = await response.text();
    const data = parseChatCompletion(rawText);
    if (!data) {
      console.error('Failed to parse JSON from API. Raw response:', rawText);
      return NextResponse.json({ error: 'Invalid JSON from API', details: rawText }, { status: 502 });
    }

    let assistantContent = data.choices?.[0]?.message?.content || "[]";
    assistantContent = assistantContent.replace(/```json/g, '').replace(/```/g, '').trim();

    const newTasksData = parseReviewTasks(assistantContent);

    const createdTasks = [];
    for (const t of newTasksData) {
      if (t && t.description) {
        const task = await prisma.task.create({
          data: {
            sessionId: session.id,
            description: t.description,
            status: 'PENDING'
          }
        });
        createdTasks.push(task);
      }
    }

    if (createdTasks.length > 0) {
      await prisma.message.create({
        data: {
          sessionId: session.id,
          role: 'planner',
          content: `Reviewer identified missing items. Generated tasks:\n` + JSON.stringify(newTasksData)
        }
      });
    }

    const allUpdatedTasks = await prisma.task.findMany({
      where: { sessionId: session.id },
      orderBy: { createdAt: 'asc' }
    });

    return NextResponse.json({ tasks: allUpdatedTasks, newTasksAdded: createdTasks.length > 0 });

  } catch (error) {
    console.error("Review API Error:", error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
