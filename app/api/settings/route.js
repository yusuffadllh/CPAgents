import { prisma } from '@/lib/prisma';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    let settings = await prisma.settings.findUnique({
      where: { id: 1 },
    });

    if (!settings) {
      settings = await prisma.settings.create({
        data: {
          id: 1,
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "",
          modelName: "google/gemini-2.5-pro",
        },
      });
    }
    return NextResponse.json(settings);
  } catch (error) {
    console.error("GET Settings Error:", error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const {
      baseUrl, apiKey, modelName, imageModelName, vercelToken, netlifyToken,
      githubToken, githubUsername, githubEmail, deployMode,
    } = await request.json();

    const data = { baseUrl, apiKey, modelName };
    if (imageModelName !== undefined) data.imageModelName = imageModelName;
    // Only overwrite deploy tokens when provided, so saving other settings
    // doesn't wipe previously stored credentials.
    if (vercelToken !== undefined) data.vercelToken = vercelToken;
    if (netlifyToken !== undefined) data.netlifyToken = netlifyToken;
    if (githubToken !== undefined) data.githubToken = githubToken;
    if (githubUsername !== undefined) data.githubUsername = githubUsername;
    if (githubEmail !== undefined) data.githubEmail = githubEmail;
    if (deployMode !== undefined) data.deployMode = deployMode === 'git' ? 'git' : 'cli';

    const settings = await prisma.settings.upsert({
      where: { id: 1 },
      update: data,
      create: {
        id: 1, baseUrl, apiKey, modelName,
        vercelToken: vercelToken || '',
        netlifyToken: netlifyToken || '',
        githubToken: githubToken || '',
        githubUsername: githubUsername || '',
        githubEmail: githubEmail || '',
        deployMode: deployMode === 'git' ? 'git' : 'cli',
      },
    });

    return NextResponse.json(settings);
  } catch (error) {
    console.error("POST Settings Error:", error);
    return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 });
  }
}
