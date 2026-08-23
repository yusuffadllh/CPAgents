// Shared helpers for cleaning user input and keeping the context we send to the
// gateway within a token budget. The gateway rejects/parses poorly on very
// large payloads, so we (1) strip junk pasted from web pages out of the goal
// and (2) cap the total prompt to a token budget, building it up in stages so
// the payload is never suddenly huge.

// Rough token estimate: ~4 chars per token for English/code. Good enough for a
// safety budget without pulling in a tokenizer dependency.
const CHARS_PER_TOKEN = 4;

// POST to an OpenAI-compatible chat endpoint with automatic retry on transient
// gateway errors (429 "busy"/rate-limit and 5xx). Honors Retry-After when the
// gateway sends it, otherwise uses exponential backoff. Returns the final
// Response (successful or the last failed one) so callers handle it as usual.
export async function fetchChatWithRetry(url, options, { maxRetries = 5, baseDelayMs = 1500 } = {}) {
  // Force non-streaming: some gateways (e.g. Anthropic-backed models) stream by
  // default, which breaks callers that JSON.parse the whole body. Inject
  // stream:false into the request body when it's a JSON chat request.
  const opts = ensureNonStreaming(options);

  let lastRes;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    lastRes = await fetch(url, opts);
    // Success or a non-retryable error → return immediately.
    if (lastRes.ok || (lastRes.status !== 429 && lastRes.status < 500)) {
      return lastRes;
    }
    if (attempt === maxRetries) break;

    // Prefer the server's Retry-After (seconds) if present.
    const retryAfter = Number(lastRes.headers.get('retry-after'));
    const backoff = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : baseDelayMs * Math.pow(2, attempt);
    // Add jitter so concurrent loops don't retry in lockstep.
    const delay = backoff + Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, delay));
  }
  return lastRes;
}

// Return a copy of fetch options with `stream:false` set in the JSON body, so
// the gateway returns one JSON object instead of an SSE stream. Leaves options
// untouched if the body isn't parseable JSON.
function ensureNonStreaming(options) {
  if (!options || typeof options.body !== 'string') return options;
  try {
    const body = JSON.parse(options.body);
    if (body && typeof body === 'object' && Array.isArray(body.messages)) {
      body.stream = false;
      return { ...options, body: JSON.stringify(body) };
    }
  } catch { /* not JSON — leave as-is */ }
  return options;
}

// Parse an OpenAI-compatible chat response body into a `{ choices: [...] }`
// object. Tolerates three shapes:
//   1. A single JSON object (normal non-streaming response).
//   2. An SSE stream ("data: {chunk}\n\n" lines) — chunks are concatenated so
//      the assembled `choices[0].message.content` is the full assistant text.
//   3. Trailing junk after the last JSON object (some gateways append noise).
// Returns null if nothing parseable is found.
export function parseChatCompletion(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  const text = rawText.trim();

  // Fast path: body starts as a single JSON object (possibly with trailing
  // junk like "data: [DONE]"). Try the substring up to the last brace.
  if (text.startsWith('{')) {
    try {
      const lastBrace = text.lastIndexOf('}');
      const slice = lastBrace !== -1 ? text.slice(0, lastBrace + 1) : text;
      const obj = JSON.parse(slice);
      if (obj && Array.isArray(obj.choices)) return obj;
    } catch { /* fall through to SSE handling */ }
  }

  // SSE path: collect every `data: {...}` line and merge streamed deltas.
  let content = '';
  let assembled = null;
  let sawChunk = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(payload); } catch { continue; }
    sawChunk = true;
    assembled = obj;
    const choice = obj?.choices?.[0];
    if (!choice) continue;
    // Streaming chunks use `delta`; a non-streaming object uses `message`.
    const piece = choice.delta?.content ?? choice.message?.content;
    if (typeof piece === 'string') content += piece;
  }

  if (!sawChunk) return null;
  return {
    ...assembled,
    choices: [{ index: 0, message: { role: 'assistant', content } }],
  };
}

// Default hard ceiling for the context we send to the model.
export const MAX_CONTEXT_TOKENS = 150000;

export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// Convert a token budget into a character budget.
export function tokensToChars(tokens) {
  return tokens * CHARS_PER_TOKEN;
}

// Clean a goal/prompt that a user may have pasted from a web page (e.g. a
// GitHub repo list), removing the boilerplate that adds noise without meaning.
export function cleanGoalInput(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw;

  // Remove GitHub repo-listing boilerplate like "Public", "Private",
  // "Updated 40 minutes ago", "MIT License", star/fork counts, language tags
  // that get dragged in when copy-pasting a repo list.
  text = text
    .replace(/\bUpdated\s+\w+\s+\w+\s+ago\b/gi, '')
    .replace(/\b(Public|Private|Archived|Forked from[^\n]*)\b/gi, '')
    .replace(/\b[\w.-]+\s+License\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?k?\s+(stars?|forks?)\b/gi, '');

  // Collapse excessive whitespace/newlines left behind by the removals.
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return text;
}

// Build a prompt from ordered sections while staying under a token budget.
// Sections are added one at a time (staged), and lower-priority sections are
// truncated or dropped first so the payload grows gradually and never blows
// past the budget in one shot.
//
// sections: Array<{ text: string, priority?: number, truncatable?: boolean }>
//   - priority: higher = more important (kept first). Default 0.
//   - truncatable: if true, may be cut down to fit. Default true.
export function buildBudgetedPrompt(sections, maxTokens = MAX_CONTEXT_TOKENS) {
  const budgetChars = tokensToChars(maxTokens);
  // Sort by priority desc so essential parts are placed first.
  const ordered = [...sections]
    .map((s, i) => ({ ...s, _i: i }))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a._i - b._i);

  let used = 0;
  const kept = [];
  for (const s of ordered) {
    const text = (s.text || '').trim();
    if (!text) continue;
    const remaining = budgetChars - used;
    if (remaining <= 0) break;
    if (text.length <= remaining) {
      kept.push({ ...s, text });
      used += text.length;
    } else if (s.truncatable !== false) {
      // Truncate this section to what fits, marking it clearly.
      const slice = text.slice(0, Math.max(0, remaining - 20));
      kept.push({ ...s, text: `${slice}\n... (dipotong)` });
      used = budgetChars;
      break;
    }
    // If not truncatable and it doesn't fit, skip it entirely.
  }

  // Restore original order for the final prompt.
  kept.sort((a, b) => a._i - b._i);
  return kept.map((s) => s.text).join('\n\n');
}
