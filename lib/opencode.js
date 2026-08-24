import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Provider id we register for the user's custom OpenAI-compatible gateway.
const PROVIDER_ID = 'custom';

// Query the gateway's OpenAI-compatible `/models` endpoint and return all model
// ids it advertises. Returns [] on any failure so callers can fall back to the
// manually configured model. Uses a short timeout so a slow/missing endpoint
// never stalls the run.
export async function fetchGatewayModels(baseURL, apiKey, timeoutMs = 8000) {
  if (!baseURL) return [];
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const json = await res.json();
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    return list
      .map((m) => (typeof m === 'string' ? m : m?.id))
      .filter((id) => typeof id === 'string' && id.length);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Build the inline OpenCode config. The user's endpoint is an OpenAI-compatible
// gateway, so we register a custom provider. We register EVERY model the gateway
// advertises (fetched ahead of time) plus the manually selected one, so any
// model available at the baseURL can be used — not just a hardcoded one.
export function buildOpencodeConfig(settings, availableModels = []) {
  const modelName = settings?.modelName || 'gpt-4o';
  const baseURL = settings?.baseUrl || 'https://openrouter.ai/api/v1';

  // Always include the selected model, then merge in whatever the gateway lists.
  const ids = new Set([modelName, ...availableModels]);
  const models = {};
  for (const id of ids) {
    if (id) models[id] = { name: id };
  }

  return {
    $schema: 'https://opencode.ai/config.json',
    model: `${PROVIDER_ID}/${modelName}`,
    provider: {
      [PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Custom Gateway',
        options: {
          baseURL,
          apiKey: '{env:OPENCODE_API_KEY}',
        },
        models,
      },
    },
    // Non-interactive runs: auto-approve so it never blocks on a prompt.
    permission: { edit: 'allow', bash: 'allow', webfetch: 'allow' },
    share: 'disabled',
    autoupdate: false,
  };
}

// Resolve the opencode binary. Allow override via env for servers where it's
// not on PATH for the PM2 process.
function opencodeBin() {
  return process.env.OPENCODE_BIN || 'opencode';
}

/**
 * Run `opencode run` non-interactively in a working directory, streaming
 * stdout/stderr lines to onOutput. Resolves with the exit code.
 *
 * @param {object} params
 * @param {string} params.prompt   The task prompt.
 * @param {string} params.cwd      Working directory (isolated per session).
 * @param {object} params.settings Settings row (baseUrl, apiKey, modelName).
 * @param {AbortSignal} [params.signal]
 * @param {(line: string) => void} params.onOutput
 */
export async function runOpencode({ prompt, cwd, settings, signal, onOutput, idleTimeoutMs = 1200000, maxTimeoutMs = 3300000 }) {
  // Discover all models the gateway offers so any of them can be used, and so
  // OpenCode never has to fetch the catalog itself (which can hang after init).
  const availableModels = await fetchGatewayModels(settings?.baseUrl, settings?.apiKey);
  if (availableModels.length) {
    onOutput(`🔎 ${availableModels.length} model tersedia di gateway.`);
  } else {
    onOutput('⚠️ Tidak bisa mengambil daftar model dari gateway — memakai model yang dipilih manual saja.');
  }
  const config = buildOpencodeConfig(settings, availableModels);
  const model = `${PROVIDER_ID}/${settings?.modelName || 'gpt-4o'}`;

  // Isolate OpenCode's global config/state from the host's ~/.config/opencode
  // and ~/.opencode, which would otherwise override our inline config (a common
  // cause of the process stalling right after "init").
  //
  // IMPORTANT: keep this OUTSIDE the workspace (cwd). If it lives inside cwd the
  // model sees `.opencode-home/` as the only content of an otherwise-empty
  // project and wastes the whole run recursively `ls`-ing OpenCode's internal
  // node_modules instead of doing the task. We place it next to the workspace.
  //
  // Per-session HOME, because global installs (`npm i -g`, `pip install`) land
  // in $HOME and MUST NOT leak between sessions — one session pinning an old
  // vercel CLI can't break another. Caches are the exception: see sharedCache.
  const sessionDirName = path.basename(cwd);
  const isolatedHome = path.join(cwd, '..', `.opencode-home-${sessionDirName}`);

  // Caches are content-addressed (npm keys by integrity hash, pip by URL), so
  // sharing them across sessions cannot cause version conflicts — react@18 and
  // react@19 are distinct entries. Sharing avoids re-downloading hundreds of MB
  // per session, which is what made each isolated HOME grow past 1 GB.
  const sharedCache = path.join(cwd, '..', '.agent-cache');
  const env = {
    ...process.env,
    HOME: isolatedHome,
    XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
    XDG_DATA_HOME: path.join(isolatedHome, '.local', 'share'),
    XDG_CACHE_HOME: path.join(sharedCache, 'xdg'),
    npm_config_cache: path.join(sharedCache, 'npm'),
    YARN_CACHE_FOLDER: path.join(sharedCache, 'yarn'),
    PNPM_HOME: path.join(isolatedHome, '.local', 'share', 'pnpm'),
    npm_config_store_dir: path.join(sharedCache, 'pnpm-store'),
    PIP_CACHE_DIR: path.join(sharedCache, 'pip'),
    OPENCODE_API_KEY: settings?.apiKey || '',
    // Kredensial deploy (opsional) supaya bash agent bisa deploy sendiri.
    VERCEL_TOKEN: settings?.vercelToken || '',
    NETLIFY_AUTH_TOKEN: settings?.netlifyToken || '',
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    // Cegah hang saat first-run: jangan fetch model list & jangan prune.
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PRUNE: 'true',
    // Non-interactive.
    CI: 'true',
  };

  // --auto: auto-approve semua permission (tidak nunggu prompt).
  // --print-logs --log-level INFO: tampilkan progress ke stderr supaya
  // eksekusi tidak terlihat "diam" padahal model sedang bekerja.
  const args = [
    'run',
    prompt,
    '--model',
    model,
    '--auto',
    '--print-logs',
    '--log-level',
    'INFO',
  ];

  // Ensure the isolated home dir exists so OpenCode doesn't fall back to the
  // host's global config.
  try { fs.mkdirSync(isolatedHome, { recursive: true }); } catch {}
  try { fs.mkdirSync(sharedCache, { recursive: true }); } catch {}

  const bin = opencodeBin();

  return new Promise((resolve, reject) => {
    let child;
    let killedByTimeout = false;
    let idleTimer;
    let settled = false;

    // Idle watchdog: kill if OpenCode produces no output for idleTimeoutMs so a
    // genuine hang can't stall the loop forever.
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        killedByTimeout = true;
        onOutput(`⏱️ Tidak ada aktivitas selama ${Math.round(idleTimeoutMs / 1000)}s — menghentikan OpenCode (kemungkinan hang / gateway tidak merespons).`);
        try { child.kill('SIGKILL'); } catch {}
      }, idleTimeoutMs);
    };

    // Hard cap on total wall-clock time so the process can never run forever.
    const maxTimer = setTimeout(() => {
      killedByTimeout = true;
      onOutput(`⏱️ Melebihi batas waktu total ${Math.round(maxTimeoutMs / 1000)}s — menghentikan OpenCode.`);
      try { child.kill('SIGKILL'); } catch {}
    }, maxTimeoutMs);

    // OpenCode can be silent while the model is "thinking"; emit a heartbeat so
    // the UI shows it's still working.
    const startedAt = Date.now();
    const heartbeat = setInterval(() => {
      const secs = Math.round((Date.now() - startedAt) / 1000);
      onOutput(`⏳ Model masih memproses... (${secs}s berlalu)`);
    }, 30000);

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      clearInterval(heartbeat);
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch {}
    };

    const pump = (chunk) => {
      resetIdle();
      const text = chunk.toString();
      for (const line of text.split('\n')) {
        if (line.trim().length) onOutput(line);
      }
    };

    // Attach all listeners to a spawned child. `allowStdbufFallback` lets us
    // retry with a direct spawn if `stdbuf` isn't installed.
    const wireChild = (allowStdbufFallback) => {
      child.on('error', (err) => {
        if (allowStdbufFallback && err && err.code === 'ENOENT') {
          // stdbuf missing — retry spawning opencode directly.
          try {
            child = spawn(bin, args, { cwd, env, shell: false });
            wireChild(false);
            return;
          } catch (e) {
            cleanup();
            if (!settled) { settled = true; reject(e); }
            return;
          }
        }
        cleanup();
        if (!settled) { settled = true; reject(err); }
      });

      child.stdout.on('data', pump);
      child.stderr.on('data', pump);

      child.on('close', (code) => {
        cleanup();
        if (settled) return;
        settled = true;
        if (killedByTimeout) {
          reject(new Error('OpenCode timed out (idle or max wall-clock exceeded)'));
          return;
        }
        resolve(code ?? 0);
      });

      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      }
    };

    // OpenCode detects that its output isn't a TTY (as under Node's
    // child_process) and buffers its logs until it exits — so nothing reaches
    // the UI and the idle watchdog wrongly kills it. Run it inside a real PTY
    // via util-linux `script`, which makes OpenCode believe it's on a terminal
    // and flush logs live. Falls back to a direct spawn if `script` is missing.
    //
    // `script -qec "<cmd>" /dev/null`: -q quiet, -e return child's exit code,
    // -c run command, /dev/null discard the typescript file.
    const shellCmd = [bin, ...args]
      .map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`)
      .join(' ');
    try {
      child = spawn('script', ['-qec', shellCmd, '/dev/null'], { cwd, env, shell: false });
    } catch {
      child = spawn(bin, args, { cwd, env, shell: false });
      wireChild(false);
      resetIdle();
      return;
    }
    wireChild(true);
    resetIdle();
  });
}
