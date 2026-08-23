import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';
import { cleanGoalInput, buildBudgetedPrompt, fetchChatWithRetry, parseChatCompletion } from '@/lib/context';

export async function POST(request) {
  try {
    const { goal: rawGoal, sessionId } = await request.json();

    if (!rawGoal) {
      return NextResponse.json({ error: 'Goal is required' }, { status: 400 });
    }

    // Clean web-paste junk and cap the goal to a safe token budget so the
    // planner request to the gateway never starts out oversized.
    const goal = buildBudgetedPrompt(
      [{ text: cleanGoalInput(rawGoal), truncatable: true }],
      150000,
    );

    const settings = await prisma.settings.findUnique({ where: { id: 1 } });
    if (!settings || !settings.apiKey) {
      return NextResponse.json({ error: 'API Key not configured' }, { status: 400 });
    }

    // Create session
    let session;
    if (sessionId) {
      session = await prisma.session.findUnique({ where: { id: sessionId } });
    }
    
    if (!session) {
      // FIFO: enforce max 3 agent sessions
      const agentSessions = await prisma.session.findMany({
        where: { goal: { not: 'Chat session' } },
        orderBy: { createdAt: 'asc' }
      });
      
      if (agentSessions.length >= 3) {
        const sessionsToDelete = agentSessions.slice(0, agentSessions.length - 2);
        for (const s of sessionsToDelete) {
          await prisma.task.deleteMany({ where: { sessionId: s.id } });
          await prisma.message.deleteMany({ where: { sessionId: s.id } });
          await prisma.session.delete({ where: { id: s.id } });
        }
      }

      session = await prisma.session.create({
        data: { goal: goal }
      });
    }

    // Save user message
    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'user',
        content: goal,
      }
    });

    const systemPrompt = `You are an AI planner. The user will give you a goal. Break the goal down into the RIGHT number of high-level tasks based on its complexity — do NOT force a fixed count. A tiny task may need just 1-2 tasks; a normal feature 3-5; a large multi-part project 7-10 or more. Prefer splitting work into small, sequential, incremental steps rather than a few huge ones, because a reviewer loop will add follow-up tasks later as needed. You MUST respond with ONLY a valid JSON array of objects. Format: [{"description": "task 1"}, {"description": "task 2"}]`;

    // Call gateway for Planner, retrying on transient 429/5xx ("busy").
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
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: goal }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("OpenRouter Agent API Error:", response.status, errorText);
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
      : "";
    
    // Clean up potential markdown blocks if present
    assistantContent = assistantContent.replace(/```json/g, '').replace(/```/g, '').trim();

    let tasksData = [];
    try {
      tasksData = JSON.parse(assistantContent);
      // some models might wrap it in an object like { tasks: [...] }
      if (!Array.isArray(tasksData) && tasksData.tasks) {
        tasksData = tasksData.tasks;
      }
    } catch (e) {
      // Fallback if parsing fails
      tasksData = [
        { description: "Menganalisis permintaan pengguna" },
        { description: "Mengeksekusi rencana" },
        { description: "Menyelesaikan tugas" }
      ];
    }

    // Auto-append a deploy task when the goal asks to go online AND at least
    // one deploy credential is configured. This makes the agent publish the
    // result by itself instead of only building it locally.
    const wantsDeploy = /deploy|publish|online|go.?live|hosting|host it|ke internet|terbitkan|luncurkan/i.test(rawGoal || '');
    const hasDeployCreds = !!(settings.vercelToken || settings.netlifyToken);
    if (wantsDeploy && hasDeployCreds) {
      const alreadyHasDeployTask = tasksData.some(
        (t) => t && t.description && /deploy|publish|luncurkan|terbitkan|online/i.test(t.description)
      );
      if (!alreadyHasDeployTask) {
        const platform = settings.vercelToken ? 'Vercel' : 'Netlify';
        tasksData.push({
          description: `Deploy the finished project online using ${platform} and report the live production URL`,
        });
      }
    }

    // Save tasks
    const createdTasks = [];
    for (const t of tasksData) {
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

    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'planner',
        content: JSON.stringify(tasksData),
      }
    });

    return NextResponse.json({ 
      session: session,
      tasks: createdTasks
    });

  } catch (error) {
    console.error("Agent API Error:", error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    
    if (!sessionId) {
      return NextResponse.json({ session: null, tasks: [] });
    }

    const session = await prisma.session.findUnique({ where: { id: sessionId } });
    const tasks = await prisma.task.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
    
    return NextResponse.json({ session, tasks });
  } catch (error) {
    console.error("Fetch agent history error:", error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
