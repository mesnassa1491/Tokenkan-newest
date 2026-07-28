# Tokenkan

Prototype of a Malaysian retail app for fractional sukuk and bonds, implemented
from the `Tokenkan.dc.html` Claude Design project. No "token"/"wallet" wording
anywhere in the UI by design — see `PROJECT_CONTEXT.md` for why.

For a full project briefing (architecture, decisions, known limitations, what
to do next), read **`PROJECT_CONTEXT.md`**. This file is just the quick-start.

## Run it

```bash
cd C:\Users\User\Documents\tokenkan
npm install
npm start
```

Then open http://localhost:3000.

Node is installed at `C:\Program Files\nodejs` but may not be on your PATH in an
already-open terminal — open a new one, or call `node` by full path.

## The Bond Explainer chat

The in-app chat calls a real LLM through your own server — the key never
touches the browser. **No key is currently configured** (confirmed as of the
last session); without one, the chat falls back to saved answers for the
seven suggested questions and says so in plain language, with no mention of
providers or keys.

The server supports two provider families, auto-detected from whichever
credential is set:

**Gemini** (direct REST, no SDK):
```bash
setx GEMINI_API_KEY "your-key"
```

**Anthropic, or any Anthropic-protocol-compatible gateway** (needs
`npm i @anthropic-ai/sdk`, currently only an optional dependency):
```bash
setx ANTHROPIC_API_KEY "sk-ant-..."
```
or, for a compatible gateway like DeepSeek:
```bash
setx ANTHROPIC_BASE_URL "https://api.deepseek.com/anthropic"
setx ANTHROPIC_AUTH_TOKEN "your-deepseek-key"
setx ANTHROPIC_MODEL "deepseek-reasoner"
```

Open a **new** terminal after any `setx` (it doesn't affect the current one),
then `npm start`. Force a specific provider with `TOKENKAN_PROVIDER=gemini` or
`TOKENKAN_PROVIDER=anthropic` if both happen to be set.

Check the wiring any time:
```bash
curl http://localhost:3000/api/health
curl http://localhost:3000/api/models    # Gemini only — lists models your key can actually reach
```

### How it works

`POST /api/ask` streams Server-Sent Events back to the browser. The system
prompt is built from `explainerFacts(a)` in `index.html` — the exact same
structured data rendered in the on-screen "Bond fact sheet" card — so the
live chat can't drift out of sync with what the model, and what the user, are
both looking at.

- **Grounding** — `prospectus.txt` is the real Sukuk Ihsan prospectus (pages
  1–70 of 223 — the design-project file reader caps at 256KB), sent as a
  system block so answers quote actual sections. It is the source document
  for the **Amanah Ihsan Education** offering only; the other five
  (fictional) instruments get an honest "no prospectus on file" note instead.
- **Prompt caching** (Anthropic-first-party only) — the prospectus block
  carries `cache_control`, so its ~70k tokens are billed in full once per
  5-minute window rather than per question.
- **Resilience** — refusals, rate limits, auth failures, and network errors
  all surface as a plain-language fallback to a saved answer where one
  exists, or a generic "no saved answer for that" — never a raw error, never
  a mention of which provider or key is missing.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | — | Gemini provider |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` | — | Anthropic or compatible-gateway provider |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | Point at a compatible gateway (e.g. DeepSeek) |
| `ANTHROPIC_MODEL` | `claude-opus-5` (or unset if `ANTHROPIC_BASE_URL` is a non-Anthropic host) | Model name for the Anthropic-protocol path |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Model name for the Gemini path |
| `TOKENKAN_PROVIDER` | auto-detected | Force `gemini` or `anthropic` |
| `PORT` | `3000` | HTTP port |
| `TOKENKAN_MAX_PROSPECTUS_CHARS` | full | Trim the grounding document |

## Files

| File | |
|---|---|
| `index.html` | The whole app — all screens, state, and business logic. No build step. |
| `server.mjs` | Static file server + streaming LLM proxy (`/api/ask`, `/api/health`, `/api/models`) |
| `prospectus.txt` | Grounding corpus (pages 1–70 of 223) — also served as the real prospectus download |
| `PROJECT_CONTEXT.md` | Full handoff briefing — read this before making changes |

## Portfolio state

Wallet, holdings, and activity persist to `localStorage` (key `tokenkan.v1`).
Investing debits the balance and creates or grows a position; selling credits
it at the indicative quote and removes the position when it hits zero; top up
and withdraw move cash. Coupon distributions **credit automatically** when
their payout date arrives — no manual claim step (see `PROJECT_CONTEXT.md` for
the virtual-clock mechanism behind this in a backend-less demo). Every
screen — portfolio value, weighted yield, next distribution, coupon income —
recomputes live from that state.

**Profile → Reset demo data** restores the starting portfolio.
**Profile → Simulate next distribution** is a demo-only control that
fast-forwards the virtual clock so a coupon credit can be seen without
waiting months — see `PROJECT_CONTEXT.md` before mistaking it for a feature to
polish rather than remove before any real launch.

Prices are fixed per instrument — no live market simulation.
