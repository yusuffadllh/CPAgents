// Shared deploy instructions so the executor loop and the manual Deploy button
// can never disagree about which platform runs — that mismatch is what causes
// two deployments for one build.

// GitHub repo URLs only. Rejects any other host so a token-bearing helper is
// never offered to an attacker-chosen server, and rejects embedded credentials.
export function isSafeRepoUrl(raw) {
  if (!raw) return false;
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'https:') return false;
    if (u.hostname !== 'github.com' && u.hostname !== 'www.github.com') return false;
    if (u.username || u.password) return false;
    return /^\/[\w.-]+\/[\w.-]+(\.git)?\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function gitPushRules(settings, repoUrl, { allowPush = true } = {}) {
  if (!settings?.githubToken) return null;
  const repo = isSafeRepoUrl(repoUrl) ? String(repoUrl).trim() : null;
  return [
    `GIT / GITHUB:`,
    `- git is already authenticated for github.com and the commit identity is set. Never run \`git config user.*\`, never ask for a login, and never put a token in a remote URL, a file, or a command.`,
    `- If this directory is not a repo yet: \`git init\`, then commit.`,
    `- Write a .gitignore BEFORE the first commit: node_modules, .env*, .vercel, .netlify, dist, build, .next, out.`,
    `- Never commit secrets. If a file holds a token or key, add it to .gitignore instead.`,
    `- When you finish this task, commit your work: \`git add -A && git commit -m "<what you did>"\`. Skip the commit only if nothing changed.`,
    allowPush
      ? (repo
          ? `- Then push: \`git remote add origin ${repo}\` (or \`git remote set-url origin ${repo}\` if it exists), \`git branch -M main\`, then \`git push -u origin main\`.`
          : `- If a remote named origin already exists, push with \`git push -u origin main\`. If there is no remote, commit locally only — do NOT invent a repository URL.`)
      : `- Do NOT push. Commit locally only; a later task handles pushing. Do not add a remote.`,
    allowPush
      ? `- If push is rejected as non-fast-forward, run \`git pull --rebase origin main\` once, resolve trivially, then push again. Never use --force.`
      : null,
  ].filter(Boolean).join('\n');
}

export function deployRules(settings, { projectName, repoUrl, context = 'task' } = {}) {
  const mode = settings?.deployMode === 'git' ? 'git' : 'cli';
  const hasVercel = !!settings?.vercelToken;
  const hasNetlify = !!settings?.netlifyToken;
  const git = gitPushRules(settings, repoUrl);

  // Git mode: the platform's GitHub integration builds on push, so running the
  // CLI too would publish the same commit twice.
  if (mode === 'git') {
    if (!settings?.githubToken) return null;
    return [
      `DEPLOYMENT (mode: via GitHub):`,
      git,
      `- Deploying means PUSHING. The hosting platform is already connected to this repository and builds automatically on push.`,
      `- Do NOT run \`vercel deploy\`, \`vercel link\`, \`netlify deploy\` or any deploy CLI. That would create a SECOND, duplicate deployment of the same commit.`,
      `- After the push succeeds, report the commit and state that the platform is building it. Print the repository URL prefixed with "REPO URL: ".`,
      `- If you know the production URL, print it on its own line prefixed with "LIVE URL: ". Do not guess one.`,
    ].filter(Boolean).join('\n');
  }

  if (!hasVercel && !hasNetlify) return null;

  const targets = [];
  if (hasVercel) {
    targets.push(
      projectName
        ? `- Vercel (VERCEL_TOKEN is set): run \`npx --yes vercel link --yes --project "${projectName}" --token="$VERCEL_TOKEN"\` first — this makes a re-deploy overwrite the SAME project instead of creating a new one — then \`npx --yes vercel deploy --prod --yes --token="$VERCEL_TOKEN"\`. Do NOT pass --name, it is deprecated.`
        : `- Vercel (VERCEL_TOKEN is set): run \`npx --yes vercel deploy --prod --yes --token="$VERCEL_TOKEN"\` from the project root. Vercel auto-detects the framework.`,
    );
  }
  if (hasNetlify) {
    targets.push(
      `- Netlify (NETLIFY_AUTH_TOKEN is set): build first if needed, then \`npx --yes netlify deploy --prod --dir=<build-output-dir> --auth "$NETLIFY_AUTH_TOKEN"\` (dist/build/out, or . for static).${projectName ? ` If asked for a site name, use "${projectName}".` : ''}`,
    );
  }

  return [
    `DEPLOYMENT INSTRUCTIONS${context === 'task' ? ' (this task involves publishing the project online)' : ''}:`,
    `- Deploy with exactly ONE platform. Prefer Vercel for Next.js/frontend apps, Netlify for static sites.`,
    ...targets,
    `- Deploy ONCE. If the deploy reports Ready, you are done — do not run a second deploy command "to be sure", and do not deploy on both platforms.`,
    settings?.githubToken
      ? `- If this project is also connected to the platform's GitHub integration, pushing AND running the CLI would publish it twice. In that case push only, and say so.`
      : null,
    git,
    `- Do NOT ask for tokens or logins — they are in environment variables. Never print token values.`,
    `- At the very end, print the final live URL on its own line prefixed with "LIVE URL: ".`,
  ].filter(Boolean).join('\n');
}
