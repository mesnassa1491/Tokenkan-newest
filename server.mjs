// Tokenkan prototype server.
//
// Two jobs:
//   1. Serve index.html (and the rest of the static files).
//   2. Expose POST /api/ask — a streaming proxy to an LLM for the in-app
//      "Prospectus Explainer" chat.
//
// The API key lives here, in the server process, and is read from the
// environment. It is never sent to the browser.
//
// Provider is picked from whichever key is present; override with
// TOKENKAN_PROVIDER=gemini|anthropic.
//
//   gemini    → GEMINI_API_KEY (or GOOGLE_API_KEY).  No npm dependencies.
//
//   anthropic → the Anthropic *protocol*, which several providers speak.
//               Works against Anthropic itself, or any compatible gateway
//               (DeepSeek, Moonshot, z.ai, a local proxy) by pointing
//               ANTHROPIC_BASE_URL at it. Needs: npm i @anthropic-ai/sdk
//
//               e.g. DeepSeek:
//                 ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
//                 ANTHROPIC_AUTH_TOKEN=$DEEPSEEK_API_KEY
//                 ANTHROPIC_MODEL=deepseek-reasoner

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Optional local config: a gitignored .env file next to this script, loaded
// on top of whatever's already in the environment (real env vars still win —
// loadEnvFile does not overwrite existing keys).
try { process.loadEnvFile(path.join(HERE, '.env')); } catch {}

const PORT = Number(process.env.PORT || 3000);

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';

// The SDK accepts either an API key or a bearer auth token — compatible
// gateways such as DeepSeek use the latter.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || '';

// Anything not served by Anthropic itself: skip Anthropic-only request fields.
const ANTHROPIC_COMPAT = Boolean(ANTHROPIC_BASE) && !/(^|\/\/)([a-z0-9-]+\.)*anthropic\.com/i.test(ANTHROPIC_BASE);

const PROVIDER = (
  process.env.TOKENKAN_PROVIDER ||
  (ANTHROPIC_KEY ? 'anthropic' : GEMINI_KEY ? 'gemini' : 'gemini')
).toLowerCase();

const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

// ANTHROPIC_DEFAULT_OPUS_MODEL is picked up as a convenience: if you already
// export it to run Claude Code against a gateway, this server reuses it.
const ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL ||
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
  (ANTHROPIC_COMPAT ? '' : 'claude-opus-5');

const MAX_OUTPUT_TOKENS = 2000;

// The prospectus is ~65k tokens and is sent with every question. On a Flash-tier
// model that is cheap; set TOKENKAN_MAX_PROSPECTUS_CHARS to trim it anyway.
const MAX_PROSPECTUS_CHARS = Number(process.env.TOKENKAN_MAX_PROSPECTUS_CHARS || 0);

/* ── Grounding corpus ─────────────────────────────────────────────────── */

// Every offering has its own prospectus. The text is extracted from the PDF of
// the same name in /prospectus and loaded once at boot, keyed by asset id, so a
// question about one instrument is never answered from another's document.
const PROSPECTUS_BY_ASSET = {
  sw: 'tk1_sajian_warisan_sukuk_murabahah',
  li: 'tk2_lembah_impian_sukuk_murabahah',
  st: 'tk3_suria_teknik_green_sri_sukuk',
  pr: 'tk4_pekan_retail_medium_term_notes',
  mq: 'tk5_mediq_peranti_sukuk_murabahah',
  gl: 'tk6_gerak_logistik_sukuk_murabahah',
};

const PROSPECTUS = {};
for (const [id, base] of Object.entries(PROSPECTUS_BY_ASSET)) {
  const p = path.join(HERE, 'prospectus', base + '.txt');
  if (!existsSync(p)) continue;
  let text = readFileSync(p, 'utf8');
  if (MAX_PROSPECTUS_CHARS > 0 && text.length > MAX_PROSPECTUS_CHARS) {
    text = text.slice(0, MAX_PROSPECTUS_CHARS);
  }
  PROSPECTUS[id] = text;
}

const PROSPECTUS_CHARS = Object.values(PROSPECTUS).reduce((n, t) => n + t.length, 0);

const ROLE = `You are the Prospectus Explainer inside Tokenkan, a Malaysian retail app for fractional sukuk and bonds. You explain a fixed-income offering to an ordinary retail investor who is not a finance professional.

How to answer:
- Plain English. Short sentences. No jargon without immediately explaining it.
- Lead with the direct answer, then the detail that changes what the reader would do.
- Be concrete about money: name the rate, the dates, and the ringgit amounts where you can.
- Keep it to roughly 120 words unless the question genuinely needs more.
- Never invent a number, date, or term. If the source material does not answer the question, say plainly that it is not covered and say what the investor should check instead.
- Be straight about downside. This person is deciding whether to put money in. Do not soften credit risk, the absence of PIDM protection, the fact that two of the six offerings are unrated, or the limits on exiting before maturity.
- You are not a licensed financial adviser and must not tell the reader whether to buy. Explain the instrument; leave the decision to them.

Format:
- Answer in plain prose. Blank line between paragraphs. No markdown headers, no bullet characters, no bold.
- End with a final line starting exactly with "SOURCE:" naming the section(s) of the prospectus you used, or "SOURCE: Offering term sheet (no prospectus on file)" when you answered from the term sheet rather than the document.`;

// The client sends `facts` as grouped [label, value] sections — the exact
// same data rendered in the on-screen fact sheet — so this just flattens
// whatever it's given rather than hardcoding a field list. Keeps the prompt
// in sync with the UI by construction instead of by two people remembering.
const FACT_SECTION_LABELS = {
  identity: 'Identity',
  coreTerms: 'Core terms',
  pricing: 'Pricing & return',
  risk: 'Risk indicators',
  context: 'Context',
};
function factsToText(facts) {
  if (!facts) return '';
  const lines = [];
  for (const [key, label] of Object.entries(FACT_SECTION_LABELS)) {
    const pairs = facts[key];
    if (!Array.isArray(pairs)) continue;
    lines.push(label + ':');
    for (const [k, v] of pairs) lines.push(`- ${k}: ${v}`);
  }
  if (facts.summary) lines.push('', 'Plain-language summary already shown to the investor: ' + facts.summary);
  return lines.join('\n');
}

// Returned as parts so each provider can assemble them its own way — the
// Anthropic path marks the big one cacheable, Gemini just concatenates.
function systemParts(asset, facts) {
  const doc = PROSPECTUS[asset.id] || '';
  const grounded = doc.length > 0;
  const parts = [{ text: ROLE }];

  if (grounded) {
    parts.push({
      cacheable: true,
      text:
        'The following is the prospectus for the offering under discussion. Answer from it wherever it is relevant, and cite the section you used.\n\n' +
        '<prospectus>\n' + doc + '\n</prospectus>',
    });
  }

  parts.push({
    text:
      'The offering the investor is currently looking at — this is the exact fact sheet already shown on their screen, so answer consistently with it:\n\n' +
      factsToText(facts) + '\n' +
      '\nPlatform facts, current as at today and authoritative on how the Platform works: Tokenkan Capital Sdn Bhd operates the Platform as a Recognised Market Operator registered with the Securities Commission Malaysia, and acts as Registrar and Paying Agent. It does not issue or hold the instruments — issuance and custody are performed by Sentinel Digital Custody Sdn Bhd, a Digital Asset Custodian registered with the Securities Commission Malaysia. Secondary trading between investors is live: a holder exits before maturity by selling units to another investor on the Platform at a price set by demand on the day. There is no guaranteed buyer and no repurchase obligation on the issuer, so a holder may have to accept a lower price, wait, or be unable to sell. Investments are not protected by PIDM.\n' +
      (grounded
        ? '\nThe prospectus above is the complete offering document for this instrument and is the source you should answer from.\n' +
          'One exception. Each prospectus was written at issuance, when the Platform was not yet registered, and so describes exit before maturity as being available only through an Anchor Investor standing bid at a discount, with monthly caps, and peer-to-peer trading deferred to a later phase pending RMO registration. That arrangement has since been superseded: registration was granted and investor-to-investor trading is now live, as set out in the platform facts above. When a question touches on exiting early, liquidity, or the standing bid, answer from the platform facts and say plainly that the document describes the earlier arrangement. Do not present the standing bid, its discount, or its monthly cap as the way an investor exits today. Everything else in the prospectus — the issuer, the terms, the risks, the financials — remains current and authoritative.'
        : '\nThere is NO prospectus on file for this offering — only the fact sheet above. Answer structural and general questions from your own knowledge, but say clearly when something would need to be confirmed against a real offering document, and do not state issuer-specific facts beyond what the fact sheet gives you.'),
  });

  return parts;
}

/* ── SSE line parsing (shared by the Gemini reader) ───────────────────── */

async function* sseLines(webStream, signal) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        for (const line of part.split('\n')) {
          if (line.startsWith('data:')) yield line.slice(5).trim();
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/* ── Provider: Gemini ─────────────────────────────────────────────────── */

async function geminiStream({ asset, facts, messages, onDelta, signal }) {
  if (!GEMINI_KEY) {
    throw new ProviderError('GEMINI_API_KEY is not set on the server. Set it and restart with "npm start".');
  }

  const system = systemParts(asset, facts).map((p) => p.text).join('\n\n');

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    // Gemini uses "model" where most APIs say "assistant".
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    })),
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
  };

  const url = `${GEMINI_BASE}/models/${encodeURIComponent(GEMINI_MODEL)}:streamGenerateContent?alt=sse`;

  const res = await fetch(url, {
    method: 'POST',
    // Key goes in a header, never in the query string.
    headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    throw new ProviderError(await describeGeminiHttpError(res));
  }

  let usage = null;
  let finishReason = null;

  for await (const data of sseLines(res.body, signal)) {
    if (!data || data === '[DONE]') continue;

    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }

    if (chunk.error) throw new ProviderError(`Gemini error: ${chunk.error.message || 'unknown'}`);

    // The whole prompt was rejected before any output.
    const block = chunk.promptFeedback?.blockReason;
    if (block) throw new ProviderError(`Gemini blocked the request (${block}). Try rephrasing the question.`);

    const cand = chunk.candidates?.[0];
    if (cand) {
      if (cand.finishReason) finishReason = cand.finishReason;
      for (const part of cand.content?.parts || []) {
        if (typeof part.text === 'string' && part.text) onDelta(part.text);
      }
    }
    if (chunk.usageMetadata) usage = chunk.usageMetadata;
  }

  if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) {
    throw new ProviderError(`Gemini stopped early (${finishReason}). Try rephrasing the question.`);
  }

  return {
    model: GEMINI_MODEL,
    usage: {
      input: usage?.promptTokenCount ?? 0,
      output: usage?.candidatesTokenCount ?? 0,
      cacheRead: usage?.cachedContentTokenCount ?? 0,
      cacheWrite: 0,
    },
  };
}

async function describeGeminiHttpError(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || '';
  } catch {
    try { detail = await res.text(); } catch {}
  }

  if (res.status === 400 && /API[_ ]?key/i.test(detail)) {
    return 'The Gemini API key is invalid. Check GEMINI_API_KEY and restart the server.';
  }
  if (res.status === 403) {
    return `Gemini rejected the key (403). It may be restricted, or the API may not be enabled for this project. ${detail}`.trim();
  }
  if (res.status === 404) {
    return `Model "${GEMINI_MODEL}" was not found. List the models your key can use with: curl http://localhost:${PORT}/api/models — then set GEMINI_MODEL to one of them.`;
  }
  if (res.status === 429) {
    return 'Gemini rate limit or quota exceeded. Wait a moment and ask again.';
  }
  if (res.status >= 500) {
    return `Gemini service error (${res.status}). Try again shortly.`;
  }
  return `Gemini API error (${res.status}): ${detail || res.statusText}`;
}

/* ── Provider: Anthropic (optional) ───────────────────────────────────── */

let anthropicClient = null;

async function anthropicStream({ asset, facts, messages, onDelta, signal }) {
  if (!ANTHROPIC_KEY) {
    throw new ProviderError('No credential set on the server — set ANTHROPIC_API_KEY, or ANTHROPIC_AUTH_TOKEN for a compatible gateway, then restart with "npm start".');
  }
  if (!ANTHROPIC_MODEL) {
    throw new ProviderError(`ANTHROPIC_BASE_URL points at ${ANTHROPIC_BASE}, so there is no default model. Set ANTHROPIC_MODEL (e.g. deepseek-reasoner) and restart.`);
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    throw new ProviderError('The Anthropic provider needs the SDK. Run: npm i @anthropic-ai/sdk');
  }

  if (!anthropicClient) {
    const opts = {};
    if (ANTHROPIC_BASE) opts.baseURL = ANTHROPIC_BASE;
    // Send exactly one credential — the API rejects both at once.
    if (process.env.ANTHROPIC_API_KEY) opts.apiKey = process.env.ANTHROPIC_API_KEY;
    else opts.authToken = ANTHROPIC_KEY;
    anthropicClient = new Anthropic(opts);
  }

  const parts = systemParts(asset, facts);

  // Compatible gateways generally accept only a plain system string, and have
  // no prompt caching — send the simplest thing that works.
  const system = ANTHROPIC_COMPAT
    ? parts.map((p) => p.text).join('\n\n')
    : parts.map((p) => ({
        type: 'text',
        text: p.text,
        ...(p.cacheable ? { cache_control: { type: 'ephemeral' } } : {}),
      }));

  const stream = anthropicClient.messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system,
    messages: messages.map((m) => ({ role: m.role, content: m.text })),
  });

  signal?.addEventListener('abort', () => stream.abort(), { once: true });

  for await (const event of stream) {
    if (signal?.aborted) break;
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      onDelta(event.delta.text);
    }
  }

  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    throw new ProviderError('That question was declined by the model’s safety filters. Try rephrasing it.');
  }

  return {
    model: final.model,
    usage: {
      input: final.usage.input_tokens,
      output: final.usage.output_tokens,
      cacheRead: final.usage.cache_read_input_tokens ?? 0,
      cacheWrite: final.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/* ── Dispatch ─────────────────────────────────────────────────────────── */

class ProviderError extends Error {}

const PROVIDERS = { gemini: geminiStream, anthropic: anthropicStream };

function describeError(err) {
  if (err instanceof ProviderError) return err.message;
  if (err?.name === 'AbortError') return 'Request cancelled.';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err?.message || '')) {
    return 'Could not reach the model API. Check your network connection.';
  }
  return err?.message || 'Unexpected server error.';
}

/* ── /api/ask ─────────────────────────────────────────────────────────── */

function sse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function handleAsk(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) { res.writeHead(413).end('payload too large'); return; }
  }

  let payload;
  try { payload = JSON.parse(body); }
  catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const asset = payload.asset;
  const facts = payload.facts;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!asset || !asset.name || messages.length === 0) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'expected { asset, messages }' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  // If the browser navigates away mid-answer, stop paying for the rest of it.
  const ac = new AbortController();
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) { aborted = true; ac.abort(); }
  });

  const run = PROVIDERS[PROVIDER];
  if (!run) {
    sse(res, { type: 'error', message: `Unknown TOKENKAN_PROVIDER "${PROVIDER}". Use "gemini" or "anthropic".` });
    res.end();
    return;
  }

  try {
    const meta = await run({
      asset,
      facts,
      messages,
      signal: ac.signal,
      onDelta: (text) => { if (!aborted) sse(res, { type: 'delta', text }); },
    });
    if (!aborted) sse(res, { type: 'done', ...meta });
  } catch (err) {
    if (!aborted) sse(res, { type: 'error', message: describeError(err) });
  }

  if (!aborted) res.end();
}

/* ── /api/models — which model names this key can actually use ────────── */

async function handleModels(res) {
  res.writeHead(200, { 'content-type': 'application/json' });

  if (PROVIDER !== 'gemini') {
    res.end(JSON.stringify({ provider: PROVIDER, note: 'Model listing is implemented for the gemini provider only.' }));
    return;
  }
  if (!GEMINI_KEY) {
    res.end(JSON.stringify({ error: 'GEMINI_API_KEY is not set.' }));
    return;
  }

  try {
    const r = await fetch(`${GEMINI_BASE}/models?pageSize=200`, {
      headers: { 'x-goog-api-key': GEMINI_KEY },
    });
    const body = await r.json();
    if (!r.ok) {
      res.end(JSON.stringify({ error: body?.error?.message || `HTTP ${r.status}` }));
      return;
    }
    const names = (body.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''))
      .sort();
    res.end(JSON.stringify({
      configured: GEMINI_MODEL,
      configuredIsAvailable: names.includes(GEMINI_MODEL),
      available: names,
    }, null, 2));
  } catch (err) {
    res.end(JSON.stringify({ error: describeError(err) }));
  }
}

/* ── Static files ─────────────────────────────────────────────────────── */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);

  // Confine every read to this directory.
  const target = path.resolve(HERE, rel);
  if (target !== HERE && !target.startsWith(HERE + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const data = await readFile(target);
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/* ── Server ───────────────────────────────────────────────────────────── */

function activeModel() { return PROVIDER === 'gemini' ? GEMINI_MODEL : (ANTHROPIC_MODEL || '(unset)'); }
function activeBase() { return PROVIDER === 'gemini' ? GEMINI_BASE : (ANTHROPIC_BASE || 'https://api.anthropic.com'); }
function hasKey() { return PROVIDER === 'gemini' ? Boolean(GEMINI_KEY) : Boolean(ANTHROPIC_KEY); }

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/ask') {
    handleAsk(req, res).catch((err) => {
      if (!res.writableEnded) {
        try { sse(res, { type: 'error', message: describeError(err) }); } catch {}
        res.end();
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/models') { handleModels(res); return; }
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      provider: PROVIDER,
      model: activeModel(),
      baseUrl: activeBase(),
      compatMode: PROVIDER === 'anthropic' ? ANTHROPIC_COMPAT : undefined,
      hasKey: hasKey(),
      prospectusChars: PROSPECTUS_CHARS,
      prospectusesLoaded: Object.keys(PROSPECTUS),
    }));
    return;
  }
  if (req.method === 'GET') { serveStatic(req, res); return; }
  res.writeHead(405).end('method not allowed');
}).listen(PORT, () => {
  console.log(`\n  Tokenkan running at  http://localhost:${PORT}\n`);
  console.log(`  provider    ${PROVIDER}${PROVIDER === 'anthropic' && ANTHROPIC_COMPAT ? ' (compatible gateway)' : ''}`);
  console.log(`  endpoint    ${activeBase()}`);
  console.log(`  model       ${activeModel()}`);
  console.log(`  prospectus  ${Object.keys(PROSPECTUS).length} documents, ${PROSPECTUS_CHARS.toLocaleString()} chars total`);
  if (!hasKey()) {
    const v = PROVIDER === 'gemini' ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN';
    console.log(`\n  ⚠  ${v} is not set — the app runs, but the`);
    console.log('     Prospectus Explainer chat will fall back to canned answers.\n');
  } else if (PROVIDER === 'anthropic' && !ANTHROPIC_MODEL) {
    console.log('\n  ⚠  ANTHROPIC_MODEL is not set and the endpoint is not Anthropic,');
    console.log('     so there is no default. Set it (e.g. deepseek-reasoner).\n');
  } else {
    console.log('  credential  set\n');
  }
});
