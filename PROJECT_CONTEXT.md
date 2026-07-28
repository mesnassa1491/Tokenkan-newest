# Tokenkan — Project Context & Handoff

**Read this before changing anything.** It reflects the actual code as of this
handoff, not the original design spec — several things below have already
been adjusted, corrected, or reinterpreted from where the project started.

---

## 1. Purpose & objectives

Tokenkan is an interactive **prototype** (not a production app) of a
Malaysian retail investing app for **fractional sukuk and bonds** — think
"buy RM100 slices of a corporate/quasi-sovereign bond, get paid a coupon
twice a year, sell your slice back to the platform if you need to exit
early." It was built from a Claude Design export (`Tokenkan.dc.html`, no
longer in this repo — the whole app has since been hand-implemented directly
in `index.html`).

**Hard product constraint, explicitly requested by the user:** the UI must
never use the words **"token"** or **"wallet address"**, and must avoid any
crypto/blockchain framing. This is a fractional-ownership investing product,
not a crypto product. Concretely: "tokens" → **"units"**, "Wallet" (tab/
screen name) → **"Balance"**. This was a deliberate rebrand partway through
development — if you see "unit" instead of "token" anywhere, that's
intentional, not a naming inconsistency to "fix."

The product is also deliberately honest/downside-forward: every screen that
could paint a rosy picture also states the risk plainly (no PIDM protection,
credit risk, the KPI step-down that reduces principal for one sukuk, "not
investment advice" disclaimers). Preserve this tone in any new copy.

---

## 2. Tech stack & architecture

- **Frontend:** a single `index.html` file. **No framework, no build step,
  no bundler.** Vanilla JS (ES5-ish style — `var`, function expressions —
  matching the original Claude Design export's conventions). All markup is
  generated via string concatenation and injected with `innerHTML`.
- **Backend:** `server.mjs` — plain Node.js (`node:http`, ESM). Zero required
  npm dependencies. One **optional** dependency, `@anthropic-ai/sdk`, used
  only if you run the Anthropic-protocol chat provider (see §9).
- **No database.** All app state lives in the browser's `localStorage`
  (key `tokenkan.v1`) as one JSON blob. There is no server-side persistence
  and no multi-user support — one hardcoded demo user ("Nur Aisyah Rahim").
- **Package manager:** npm. `package.json` has `"type": "module"`.

### Rendering model (important before you touch UI code)

There's no virtual DOM. The pattern is:

- A single mutable `state` object (session/UI state — current screen, form
  inputs, chat messages — **not persisted**).
- A single mutable `book` object (persisted business state — balance,
  holdings, activity log — **saved to localStorage on every mutation**).
- `ASSETS` — a static array of the 6 hardcoded bond/sukuk offerings
  (reference data, never mutated at runtime except via `book.payoutDates`
  overrides — see §9).
- `render()` rebuilds the *entire* `#app` innerHTML from `view()` on every
  state change, then does a few **manual DOM patches** afterward for things
  that would otherwise glitch on a full re-render: the sell-quantity slider
  drag (`onSellInput`), the streaming AI chat text (`patchStream`), and
  scroll-position/input-focus preservation. If you add a new live-updating
  control, check whether it needs the same manual-patch treatment.
- All click handling is one delegated listener on `#app` matching
  `[data-act]` / `data-arg` attributes against the `actions` object at the
  bottom of the script. To wire up a new button: give it
  `data-act="yourActionName"` (+ optional `data-arg`), add a matching key to
  `actions`.

### Backend architecture

`server.mjs` does three things:
1. Serves static files from the project directory (path-traversal-guarded).
2. `POST /api/ask` — proxies the AI chat as a streaming SSE response, to
   either Gemini (direct `fetch` against the REST API) or Anthropic-protocol
   (via the SDK, which also covers Anthropic-compatible gateways like
   DeepSeek). Provider is auto-detected from whichever credential env var is
   set; see §9 and the README for the full list.
3. `GET /api/health` and `GET /api/models` — diagnostics (the latter lists
   what model names your Gemini key can actually reach).

---

## 3. Folder structure

Flat, single-directory Node project — no `src/`, no subfolders for app code:

```
tokenkan/
├── index.html          # the entire app — UI, state, business logic
├── server.mjs           # static server + LLM chat proxy
├── prospectus.txt        # real prospectus text (pages 1-70/223), grounds the AI explainer + is the real download
├── package.json
├── package-lock.json
├── README.md             # quick-start / run instructions
├── PROJECT_CONTEXT.md     # this file
├── node_modules/          # gitignored
├── server.log / server.err  # gitignored runtime logs from prior dev sessions
```

There is no `.gitignore` prior to this handoff commit — one was added (see
§13) to exclude `node_modules/` and the log files.

---

## 4. Features completed

All of the below are implemented, wired up, and were manually verified in a
live browser session (there are no automated tests — see §11).

**Navigation & shell:** iOS-style device frame chrome (status bar, dynamic
island, home indicator), 5-tab bottom nav (Portfolio / Market / Balance /
Activity / Profile) + a screen stack for push/back navigation.

**Portfolio dashboard (home):** hero card cycling between Total value /
Projected income / Next payout; quick actions (Invest, Top up, Payouts); a
tappable "Total coupon income" card (dual entry point into the withdraw-
income flow — see below); holdings list; a "closing soon" featured-offering
card.

**Market:** browse all 6 offerings, filter by Shariah/Sukuk/Bonds/SRI-Green/
AAA-only, sorted by yield.

**Balance screen** (formerly "Wallet" — renamed, see §2): available cash,
top-up/withdraw (generic cash movement), linked accounts (Maybank Islamic +
CIMB, both fake/static), an income-received bar chart.

**Asset detail:** key terms, distribution schedule, risks, buy/sell entry
points, KPI callout banner (for the one sukuk with a step-down clause), and
the prospectus/term-sheet download (see below).

**Buy flow:** 2-step (amount entry with keypad → review + risk
acknowledgment checkbox → confirm), debits balance, creates/grows a holding.

**Sell flow — "Sell your fraction"** (this was a full spec rebuild, not the
original simple version): shows units held, amount invested, coupon income
received *for that specific asset* (summed live from the activity log, not a
separately-tracked number), days to maturity; quantity slider defaulting to
**the full holding** with a "Sell all" shortcut; an "indicative price" panel
(current best bid, indicative sale value, explicit "price can move, confirmed
at matching" disclaimer); a small deterministic 4-row "live bids" depth
ladder (visual only — does not affect the actual quote math, which is
`sellQuote()`); a reassurance line above the confirm button ("selling early
is optional — holding to maturity returns the full nominal value").

**Withdraw Coupon Income** (new screen, not in the original design): splits
coupon income received (withdrawable) from capital still invested (locked),
visually distinct; amount entry defaults to the full withdrawable balance
with a "Withdraw all" shortcut; destination picker (Maybank / DuitNow, no
add-account option); success screen offers "Reinvest instead" (routes the
withdrawn amount back into the Market tab rather than sending it out).

**Automatic coupon distribution** (new — see §9 for the mechanism): coupon
payments credit to the balance **automatically** with no manual "claim" step,
and trigger a toast notification. Because this is a static frontend prototype
with no real backend clock, a **demo-only** virtual clock lets a Profile
control ("Simulate next distribution") fast-forward to the next payout date
— the crediting itself is unconditional once the date arrives, real elapsed
time between sessions is credited too.

**Prospectus / term-sheet download:** the one asset with a real prospectus
(Amanah Ihsan Education) downloads the actual extracted prospectus text; the
other five (fictional) offerings generate a plaintext "INDICATIVE TERM
SHEET — NOT A PROSPECTUS" client-side (`Blob` + temporary `<a download>`, no
server round-trip) — deliberately not disguised as a real legal document.

**AI Bond Explainer** (full rebuild from a 6-stat summary card to a complete
fact sheet): Identity, Core terms, Pricing & Return, Risk indicators,
Context, an auto-generated plain-language summary sentence, and a footer
with a data timestamp + "not investment advice" disclaimer. New derived bond
metrics (current yield, approximate YTM, approximate duration, approximate
price-sensitivity-per-1%-rate-move) computed in `bondMetrics()` — explicitly
labeled "approx." in the UI since these are simplified illustrative formulas,
not real fixed-income analytics (see §11). The live chat (`/api/ask`) is fed
**the exact same fact data** the screen renders (`explainerFacts(a)`), so the
model can't answer inconsistently with what's on screen.

**Multi-provider AI chat:** the server auto-detects Gemini vs. Anthropic-
protocol (including Anthropic-compatible gateways like DeepSeek) from
whichever credential env var is present. Falls back gracefully to canned
answers for the 7 suggested questions when no key is configured, or when a
live call fails for any reason — **the fallback message never mentions which
provider or key is missing** (this was an explicit user request partway
through — earlier versions of the error message did mention it and were
removed).

---

## 5. Features in progress

**None.** All work tracked in the last session was completed and verified.
The AI chat currently runs in offline/fallback mode because **no provider API
key is configured** (confirmed directly by the user at the end of the last
session — do not assume one exists; check `curl localhost:3000/api/health`
→ `hasKey` before assuming otherwise).

---

## 6. Features pending / not built

These were explicitly deferred, not forgotten:

- **Deployment / public hosting.** Everything currently only runs on
  `localhost:3000`. The user asked twice about "the link" / pushing to a
  repo — a public deployment (Render/Railway/Vercel/etc.) has **not** been
  set up. If asked for a shareable link, that's new work, not a lookup.
- **Real backend / database.** All state is `localStorage`. No server-side
  persistence, no real accounts, no auth.
- **Real payment rails.** Top-up, withdraw, DuitNow, Maybank linking are all
  simulated — no FPX/DuitNow/bank integration exists or was intended to at
  this stage.
- **Live market data.** Asset prices are static hardcoded numbers; nothing
  moves them.
- **Automated tests.** None exist. All verification during development was
  done by driving `actions.*` calls live in a browser JS console.
- **Multi-user / auth.** Single hardcoded demo persona.

---

## 7. Important technical decisions

- **Why no framework:** matches the simplicity of the original Claude Design
  export and keeps the prototype a single file anyone can open and read
  top-to-bottom. Don't introduce React/Vue/a bundler without discussing it
  first — it would be a significant scope change, not a small refactor.
- **State separation is deliberate and should be preserved:** `ASSETS`
  (static reference data) vs. `book` (persisted, mutable, real money/holdings
  state) vs. `state` (ephemeral UI/session state). When adding a feature,
  work out which bucket new data belongs in before writing code — mixing
  these up is the most likely way to introduce a persistence bug.
- **`explainerFacts(a)` is the single source of truth** for both the on-
  screen fact sheet and the AI prompt payload. If you add a new bond
  attribute, add it here (and to the `ASSETS` entries), not by hand-editing
  both the UI markup and the server prompt separately — `server.mjs`'s
  `factsToText()` generically flattens whatever `facts` object it receives.
- **The real prospectus PDF (~3.6MB) could not be fetched** from the design
  project — the file reader available during development caps at 256KB, and
  serving a truncated PDF would just be a corrupted file. The extracted
  *text* (pages 1–70 of 223, ~260KB) was used instead for both AI grounding
  and the download feature. If a next session has access to the full PDF, it
  could replace `prospectus.txt` as the grounding source and be added as a
  proper binary download — but treat this as a nice-to-have, not a bug fix.
- **Automatic coupon distribution needed a virtual clock** since there's no
  real backend or scheduler. `book.clockOffsetMs` + `book.payoutDates`
  (per-asset override of the static `ASSETS[].nextPayout`) let `today()`
  (used everywhere for date math) be advanced without touching system time.
  `checkAndCreditDistributions()` runs on every app boot (catches real
  elapsed time) and after the demo "simulate" action (catches fast-forwarded
  time) — same code path either way, so there's exactly one place coupon
  crediting happens.
- **Whole-ringgit keypad vs. fractional coupon income:** the amount keypad
  only enters whole RM, but coupon income accrues in cents. `withdraw all`
  would otherwise permanently strand the odd sen. Fixed via
  `effectiveWithdrawAmount()` — typing the whole-ringgit floor of the full
  balance snaps to withdrawing the exact full amount instead.
- **AI provider is abstracted, not hardcoded to one vendor.** The user
  changed direction mid-project from "Anthropic only" to "I use other LLM
  providers, specifically Gemini, and separately I have a DeepSeek-via-
  Anthropic-protocol shell alias." `server.mjs` was restructured around a
  `PROVIDERS` map keyed by provider name, auto-selected by which credential
  env var is present, with `TOKENKAN_PROVIDER` as an explicit override. If
  adding a third provider, follow this same shape (a `*Stream()` async
  function matching the `{asset, facts, messages, onDelta, signal} → {model,
  usage}` interface).
- **No raw error/technical messaging surfaces in the chat UI**, by explicit
  user request — every failure path (missing key, network error, refusal,
  rate limit) resolves to either a saved canned answer (silently) or one
  generic sentence with zero mention of providers, keys, or setup steps.

---

## 8. UI/UX decisions & design guidelines

- **Visual language:** iOS device frame; IBM Plex Sans (body) / IBM Plex Mono
  (numbers, codes, monospaced data) from Google Fonts; card-based layout
  (`.card` class — white bg, 1px `var(--line)` border, 16px radius).
- **Color tokens** (CSS custom properties defined in `:root`):
  `--ink` (#0C2A22, primary text), `--green` (#0E3D2F, brand/primary
  action), `--gold` / `--gold-ink` (#B0872F / #8A6A22, secondary/warning
  accents — used for KPI callouts, "closing soon"), `--muted` / `--faint`
  (secondary/tertiary text), `--pos` / `--neg` (#157A56 / #C0392B, gains/
  losses), `--bg` (#F4F2ED, screen background), `--hair` (hairline
  dividers).
- **Press-state classes** `.t95` through `.t99` — scale-down transform on
  `:active`, applied to nearly every tappable element for a native-feeling
  press response. Use the existing scale (`.t97`/`.t98` are most common) for
  new tappable elements rather than inventing new values.
- **Modals:** two patterns — bottom sheets that slide up over a dimmed
  backdrop (`tkUp` animation) for lightweight actions (cash top-up/withdraw,
  the AI explainer), vs. full pushed screens (via `push()`/`state.stack`) for
  anything with its own back button and more content (buy, sell, income,
  detail).
- **Tone, non-negotiable per explicit user direction:** never hide or soften
  downside risk. Every offering detail screen and the AI explainer must
  state credit risk, lack of PIDM protection, and (where applicable) the KPI
  principal step-down plainly. Never use crypto/blockchain framing or the
  words "token"/"wallet address" anywhere user-facing.

---

## 9. "Database" / API details

**No real database** — see §2. The persisted `book` object shape:

```js
{
  wallet: number,              // available balance, RM
  holdings: { [assetId]: unitsHeld },
  distributions: number,        // lifetime coupon income earned (never decreases)
  incomeAvailable: number,      // currently-withdrawable coupon income (decreases on withdrawal)
  activity: [ {glyph, kind, title, sub, amount, date}, ... ],  // most-recent-first, capped at 40
  clockOffsetMs: number,        // demo virtual-clock offset, see §9
  payoutDates: { [assetId]: 'YYYY-MM-DD' }  // per-asset next-payout override once a coupon has been credited
}
```
Saved to `localStorage['tokenkan.v1']` via `saveBook()` after every mutating
action. `loadBook()` + a migration guard at boot backfill any of the newer
fields (`incomeAvailable`, `clockOffsetMs`, `payoutDates`) into saves from
before those fields existed, so old localStorage data won't crash the app.

**API surface** (`server.mjs`):

| Endpoint | Method | Purpose |
|---|---|---|
| `/` and any static path | GET | Serves files from the project dir (path-traversal guarded) |
| `/api/ask` | POST | Body `{asset, facts, messages}` → streams SSE `{type:'delta'|'done'|'error', ...}` |
| `/api/health` | GET | `{ok, provider, model, baseUrl, hasKey, prospectusChars}` |
| `/api/models` | GET | Gemini only — lists models the configured key can reach |

No auth on any endpoint (fine for a localhost-only prototype; **would need
addressing before any real deployment**).

---

## 10. Known bugs, limitations, and things to flag

- **No API key is currently configured** (any provider). Confirmed directly
  by the user, not inferred. The chat works fine in fallback mode but has
  never been end-to-end tested against a real live model response in this
  environment — only against local mock HTTP servers standing in for
  Gemini/Anthropic-shaped responses. If continuing this work, a first good
  step is setting a real key and confirming a live round-trip.
- **Bond risk metrics are simplified approximations**, not real fixed-income
  math: `duration = years * 0.88` (a flat illustrative multiplier), YTM uses
  the classic approximate-yield formula (not a true IRR solve), price-per-
  1%-move is `duration * price / 100`. These are explicitly labeled
  "approx." in the UI. Fine for a demo; would need a real model before any
  claim of accuracy.
- **"Simulate next distribution" (Profile screen) is a demo-only affordance**
  — it exists purely because there's no real passage of time in a static
  prototype. Don't mistake it for a feature to refine; it should likely be
  removed (or hidden behind a dev flag) before anything resembling a real
  launch.
- **No automated tests.** All verification was manual, live-browser,
  JS-console-driven (calling `actions.*` and inspecting `state`/`book`
  afterward). If you add tests, there's no existing harness/framework choice
  to match — pick whatever's appropriate for a vanilla-JS single-file app
  (or consider whether the app should be modularized first).
- **Prices never move.** Every asset's `price` field is a static number set
  in `ASSETS`. Anything that looks like "market movement" (the bid depth
  ladder in the sell screen) is deterministic decoration, not simulation.
- **The 5 non-grounded assets' ISINs, issue dates, sector/country/issue-size
  figures are fabricated for demo completeness** (added when the AI
  Explainer fact sheet was expanded) — clearly not real securities, but
  worth knowing they're invented rather than sourced, in case that matters
  for how this prototype gets used/shown.
- **This was not a git repository until this handoff.** There is no commit
  history capturing the incremental build — everything before this commit
  happened in an untracked working directory.

---

## 11. Instructions for the next session

1. **Read this file and `README.md` first.** Don't re-derive architecture
   from scratch — it's all documented above.
2. **Get it running:**
   ```bash
   cd path/to/tokenkan
   npm install
   npm start
   ```
   then open `http://localhost:3000`. Check `curl localhost:3000/api/health`
   to see current provider/key status before assuming the AI chat works.
3. **If you need the live AI chat working,** set a provider key per the
   README (§ "The Bond Explainer chat") — none is currently configured.
4. **Before adding a new bond/asset attribute,** update it in both the
   `ASSETS` array *and* `explainerFacts()` — that function is the single
   source of truth feeding both the UI card and the AI prompt (§7).
5. **Before adding a new persisted field to `book`,** add a migration guard
   next to the existing ones (near `var book = loadBook();`) so old
   localStorage saves don't break.
6. **Before adding user-facing copy,** re-read §8's tone requirements — no
   soft-pedaling risk, no crypto framing, no "token"/"wallet address."
7. **Likely next priorities**, roughly in order of what the user has asked
   about but not yet had built: (a) decide on and set up a real deployment
   target if a shareable link is wanted; (b) confirm live AI chat works
   end-to-end with a real provider key; (c) decide whether "Simulate next
   distribution" should be removed/hidden or kept as a permanent demo
   feature; (d) consider whether this stays a client-only prototype or needs
   a real backend/database — that's a scope decision to raise with the user
   explicitly, not to assume.
