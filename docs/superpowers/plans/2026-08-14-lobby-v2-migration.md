# Lobby v2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the live DuelSeries lobby with the lobby-v2 design, moving from three fixed stake tiers to lobbies created on demand at any amount, shipped at a parallel route so the live lobby never breaks.

**Architecture:** The new lobby is served at `/v2` while `index.html` keeps working, and only becomes the default in the final phase. The play flow is already decoupled — `btn-play` dispatches a `duel:play` CustomEvent that the Privy wallet widget handles — so the new lobby re-fires the same events rather than reimplementing staking. The stake-model change is server-side and lands behind its own tested phase: a `LobbyRegistry` keys rooms on `(game, region, stake)` and creates them on demand, and the entry token binds to the amount actually transferred on-chain rather than to a tier name.

**Tech Stack:** Node + Express + Socket.io, Postgres via `pg`, `@solana/web3.js`, Privy embedded wallets, USDC SPL (`MONEY_MODE=usdc`), plain ES5-ish browser JS (no build step for the lobby), `node --test` for tests.

## Global Constraints

- **Never trust a client-supplied stake, worth, or `entrySol`.** Worth comes only from the server-minted one-time entry token via `consumePaidEntry`. This is the core anti-cheat invariant.
- **The server is authoritative.** The server simulates; clients render and predict. Do not move game logic to the client.
- **Cash-out pays the player 90%; the 10% house cut stays in escrow.** Unchanged by this migration.
- **A stake signature is claimed one-time** via `db.markStakeSig(sig)`, which closes the double-mint race. Preserve this.
- **Every snake colour must be a slither palette entry.** `server/Snake.js` `sanitizeColor` enforces it; do not add colours.
- **Pushing to `main` auto-deploys to AWS.** Every commit in this plan is a deploy.
- `node --check <file>` on every changed `.js` before commit. Inline lobby JS is extracted and checked the same way.
- **agar.io stays marked "In development"** for this migration (owner's decision, 2026-08-14). `agarRooms` remain live server-side; the new lobby simply does not link to them. Known consequence: agar.io is unreachable from `/v2` until a later phase restores it.
- **Desktop first.** Mobile is Phase 6, not a blocker for cutover (owner's decision, 2026-08-14).
- Money constants: `MIN_STAKE = 0.10`, `MAX_STAKE = 100.00` (USDC). Free play is stake `0`.

---

## File Structure

**New files**
- `public/v2.html` — the new lobby shell (from `public/lobby-v2.html`, minus mock data)
- `public/js/v2/board.js` — renders the live board from `/api/live`
- `public/js/v2/stake.js` — the amount control and quick-pick chips
- `public/js/v2/social.js` — leaderboard, search, profiles against real endpoints
- `public/js/v2/look.js` — the change-appearance screen
- `public/js/v2/play.js` — play/spectate, fires `duel:play`, hosts the game iframe
- `server/LobbyRegistry.js` — on-demand lobby lifecycle keyed `(game, region, stake)`
- `test/lobbyRegistry.test.js`
- `test/entryToken.test.js`

**Modified**
- `server/index.js` — `/api/live`, stake-quote and submit-stake for arbitrary amounts, `consumePaidEntry` binding, room lookup via the registry
- `server/money.js` — `stakeQuote(amount)` / `feeFor` accept an amount rather than a tier key
- `public/wallet/widget.js` — pass the chosen stake through `duel:play`

**Untouched (deliberately)**
- `server/GameRoom.js`, `server/AgarRoom.js` — only the key they are stored under changes
- `server/Wallet.js`, `server/Usdc.js` — cash-out path is not in scope
- `public/index.html`, `public/js/lobby.js` — the old lobby keeps working until Phase 5

---

## Phase 0 — Parallel route

### Task 1: Serve the new lobby at /v2

**Files:**
- Create: `public/v2.html`
- Modify: `server/index.js` (static route section)
- Test: `test/v2route.test.js`

**Interfaces:**
- Produces: a reachable `GET /v2` returning the new lobby shell.

- [ ] **Step 1: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

test('v2 lobby shell exists and is self-contained', () => {
  const html = fs.readFileSync('public/v2.html', 'utf8');
  assert.ok(html.includes('<title>DuelSeries</title>'), 'has a title');
  assert.ok(!html.includes('const LOBBIES=['), 'mock lobby data removed');
  assert.ok(!html.includes('const PLAYERS='), 'mock player data removed');
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/v2route.test.js`
Expected: FAIL, `ENOENT: no such file or directory, open 'public/v2.html'`

- [ ] **Step 3: Copy the prototype and strip the mock data**

```bash
cp public/lobby-v2.html public/v2.html
```

Then delete these arrays from `public/v2.html`, leaving the render functions
that consume them (they are filled from the API in Phase 1):
`const LOBBIES=[…]`, `const PNAMES=[…]`, `const PLAYERS=…`, `const SESSIONS=[…]`,
`const REAL_WINS=[]`, `const WINS=(()=>{…})()`.
Replace each with an empty seed the renderers already tolerate:

```js
let LOBBIES = [];
let PLAYERS = [];
let ROWS = [];
let WINS = [];
```

- [ ] **Step 4: Add the route**

In `server/index.js`, beside the existing static handlers:

```js
// The redesigned lobby, served in parallel with the live one so it can be
// exercised on the real server without replacing index.html.
app.get('/v2', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'v2.html')));
```

- [ ] **Step 5: Run the test and the syntax check**

Run: `node --test test/v2route.test.js && node --check server/index.js`
Expected: PASS, and no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add public/v2.html server/index.js test/v2route.test.js
git commit -m "feat: serve the redesigned lobby at /v2 alongside the live one"
```

---

## Phase 1 — Real data, read-only

No money is touched in this phase. Every endpoint below already exists.

### Task 2: Leaderboard and player search from real endpoints

**Files:**
- Create: `public/js/v2/social.js`
- Modify: `public/v2.html` (drop the inline social block, add the script tag)

**Interfaces:**
- Consumes: `GET /api/earningsboard`, `GET /api/players/search?q=`, `GET /api/profile/<wallet>`
- Produces: `window.V2Social = { load, drawBoard, openPlayer }`

- [ ] **Step 1: Confirm the real response shapes before writing against them**

Run:
```bash
curl -s localhost:3000/api/earningsboard | head -c 400
curl -s 'localhost:3000/api/players/search?q=a' | head -c 400
```
Write the observed field names into a comment at the top of `social.js`. Do
not guess them — the mock used `{name, net, n}` and the server will not.

- [ ] **Step 2: Write the failing test**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

test('social module talks to the real endpoints, not mock arrays', () => {
  const src = fs.readFileSync('public/js/v2/social.js', 'utf8');
  assert.ok(src.includes('/api/earningsboard'), 'uses the earnings board');
  assert.ok(src.includes('/api/players/search'), 'uses player search');
  assert.ok(!src.includes('mkPlayer'), 'no generated players');
  assert.ok(!src.includes('seeded('), 'no seeded RNG');
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node --test test/v2route.test.js`
Expected: FAIL, `ENOENT … public/js/v2/social.js`

- [ ] **Step 4: Implement against the shapes recorded in Step 1**

Search is debounced 250ms and aborts the previous request, so fast typing
cannot land results out of order:

```js
let _searchAbort = null, _searchTimer = null;
function search(q) {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(async () => {
    if (_searchAbort) _searchAbort.abort();
    _searchAbort = new AbortController();
    try {
      const r = await fetch('/api/players/search?q=' + encodeURIComponent(q),
                            { signal: _searchAbort.signal });
      drawBoard(await r.json());
    } catch (e) { if (e.name !== 'AbortError') showSearchError(); }
  }, 250);
}
```

- [ ] **Step 5: Run the tests**

Run: `node --test test/v2route.test.js && node --check public/js/v2/social.js`
Expected: PASS

- [ ] **Step 6: Verify in the browser against the real server**

Start the server, open `/v2`, click Social. Confirm the board lists real
wallets and that searching a known name returns them. An empty database must
show the empty state, not a spinner forever.

- [ ] **Step 7: Commit**

```bash
git add public/js/v2/social.js public/v2.html test/v2route.test.js
git commit -m "feat: wire the v2 social tab to the real leaderboard and search"
```

### Task 3: Wallet panel from the embedded wallet

**Files:**
- Modify: `public/v2.html`, `public/js/v2/social.js` (shared money formatting)

**Interfaces:**
- Consumes: `window.duelWallet` (`{ authenticated, address }`), `GET /wallet/info`, `GET /api/money-config`
- Produces: `window.V2Wallet = { render, refresh }`

- [ ] **Step 1: Read how the live lobby does it, and copy the contract**

Read `public/js/lobby.js` lines 719–860 (`dw()`, `walletConnected()`,
`renderWalletState()`, `ensureWallet()`, `openAddFunds()`,
`openWithdrawModal()`). The v2 wallet screen must call the **same**
functions, not reimplement them, so there is one add-funds and one cash-out
path in the product.

- [ ] **Step 2: Replace the mock balance**

Delete the hardcoded `$12.40` in `public/v2.html` and drive both the header
readout and the wallet screen from `renderWalletState()`.

- [ ] **Step 3: Wire Add Funds and Cash Out to the existing handlers**

```html
<button class="btn pri" onclick="openAddFunds()">Add funds</button>
<button class="btn sec" onclick="openWithdrawModal()">Cash out</button>
```

- [ ] **Step 4: Verify signed-out and signed-in states**

Signed out: the wallet screen shows a sign-in prompt, not `$0.00`.
Signed in: the balance matches what the live lobby shows for the same wallet.

- [ ] **Step 5: Commit**

```bash
git add public/v2.html
git commit -m "feat: drive the v2 wallet screen from the embedded wallet"
```

### Task 4: Stats from real earnings

**Files:**
- Modify: `public/v2.html`

**Interfaces:**
- Consumes: `GET /api/my-profile?wallet=<address>`, `GET /api/stats/winnings`

- [ ] **Step 1: Delete the invented SESSIONS array and derive from the API**

The accounting rules stay exactly as the prototype has them, because they
are the game's real rules: cash out returns 90% with the house keeping 10%;
dying returns nothing and takes no cut. Only the source of the rows changes.

- [ ] **Step 2: Assert the totals still reconcile**

Add to `test/v2route.test.js`:

```js
test('stats accounting rules are unchanged', () => {
  const html = fs.readFileSync('public/v2.html', 'utf8');
  assert.ok(html.includes('const RAKE=0.10'), 'rake is still 10%');
  assert.ok(!html.includes("{d:'Jul 28'"), 'invented sessions removed');
});
```

- [ ] **Step 3: Run and commit**

```bash
node --test test/v2route.test.js && node --check server/index.js
git add public/v2.html test/v2route.test.js
git commit -m "feat: drive v2 stats from real earnings"
```

---

## Phase 2 — Stake model (MONEY-CRITICAL)

Nothing in this phase ships to players until Task 8 passes. This is the only
phase that can lose real funds. Read `CLAUDE.md` "Money System" before
starting.

### Task 5: Entry tokens bind to an amount, not a tier

**Files:**
- Modify: `server/money.js`, `server/index.js:248-275`, `server/index.js:370-410`
- Test: `test/entryToken.test.js`

**Interfaces:**
- Produces: `consumePaidEntry(entryToken, stake)` → `{ ok, worth }`, matching only when the token's recorded stake equals `stake`.

**The invariant that makes this safe:** `money.verifyStake(sig, expected)`
already returns `worth` as the amount **actually transferred on-chain**;
`expected` is only a floor. So the server derives the lobby from what was
genuinely paid. A client that asks for a $50 lobby having paid $0.10 gets a
token worth $0.10 and can only enter the $0.10 lobby.

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { makeEntryStore } = require('../server/entryStore');

test('a token only opens the lobby matching what was paid', () => {
  const s = makeEntryStore({ ttlMs: 60000 });
  const tok = s.mint({ stake: 0.10, worth: 0.10, walletAddress: 'W' });
  assert.deepEqual(s.consume(tok, 5.00), { ok: false, worth: 0 });
  assert.deepEqual(s.consume(tok, 0.10), { ok: true, worth: 0.10, walletAddress: 'W' });
});

test('a token is one-time', () => {
  const s = makeEntryStore({ ttlMs: 60000 });
  const tok = s.mint({ stake: 1, worth: 1, walletAddress: 'W' });
  assert.equal(s.consume(tok, 1).ok, true);
  assert.equal(s.consume(tok, 1).ok, false, 'second use is refused');
});

test('an expired token is refused', () => {
  const s = makeEntryStore({ ttlMs: -1 });
  const tok = s.mint({ stake: 1, worth: 1, walletAddress: 'W' });
  assert.equal(s.consume(tok, 1).ok, false);
});

test('stake is clamped to the allowed range', () => {
  const s = makeEntryStore({ ttlMs: 60000, min: 0.10, max: 100 });
  assert.throws(() => s.mint({ stake: 0.01, worth: 0.01 }), /below the minimum/);
  assert.throws(() => s.mint({ stake: 250, worth: 250 }), /above the maximum/);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/entryToken.test.js`
Expected: FAIL, `Cannot find module '../server/entryStore'`

- [ ] **Step 3: Extract the token store so it is testable**

Create `server/entryStore.js`, moving the logic currently inline at
`server/index.js:250-275`:

```js
'use strict';
const crypto = require('crypto');

/* Server-authorised paid entry. A token records the amount that actually
   landed on-chain, and only opens a lobby at exactly that stake, so the
   client never chooses what it is worth. */
function makeEntryStore({ ttlMs = 120000, min = 0.10, max = 100 } = {}) {
  const tokens = new Map();
  const EPS = 1e-9;
  return {
    mint({ stake, worth, walletAddress }) {
      if (stake !== 0 && stake < min) throw new Error('stake below the minimum');
      if (stake > max) throw new Error('stake above the maximum');
      const t = crypto.randomUUID();
      tokens.set(t, { stake, worth, walletAddress, exp: Date.now() + ttlMs });
      return t;
    },
    consume(token, stake) {
      const t = token && tokens.get(token);
      if (!t || Date.now() > t.exp) return { ok: false, worth: 0 };
      if (Math.abs(t.stake - stake) > EPS) return { ok: false, worth: 0 };
      tokens.delete(token);                       // one-time use
      return { ok: true, worth: t.worth, walletAddress: t.walletAddress };
    },
    sweep() {
      const now = Date.now();
      for (const [k, v] of tokens) if (now > v.exp) tokens.delete(k);
    },
    get size() { return tokens.size; },
  };
}
module.exports = { makeEntryStore };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/entryToken.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Use the store in server/index.js**

Replace the inline `entryTokens` Map and `consumePaidEntry` with:

```js
const { makeEntryStore } = require('./entryStore');
const entryStore = makeEntryStore({ ttlMs: ENTRY_TOKEN_MAX_AGE_MS, min: MIN_STAKE, max: MAX_STAKE });
setInterval(() => entryStore.sweep(), ENTRY_TOKEN_MAX_AGE_MS);
function consumePaidEntry(entryToken, stake) { return entryStore.consume(entryToken, stake); }
```

- [ ] **Step 6: Update the four call sites**

`server/index.js` lines 857, 1013, 1078, 1141 currently pass `shortType`.
Each must pass the numeric stake the socket is joining at. Read each
surrounding handler first; do not blind-replace.

- [ ] **Step 7: Syntax check, full test run, commit**

```bash
node --check server/index.js && node --check server/entryStore.js && node --test
git add server/entryStore.js server/index.js test/entryToken.test.js
git commit -m "feat: bind entry tokens to the amount actually staked"
```

### Task 6: Arbitrary-amount stake quote and submit

**Files:**
- Modify: `server/money.js:20-58`, `server/index.js:370-410`
- Test: `test/entryToken.test.js` (extend)

- [ ] **Step 1: Write the failing test**

```js
test('submit-stake takes worth from the chain, not the request body', async () => {
  const fake = { verifyStake: async () => ({ payer: 'P', worth: 0.10 }) };
  const out = await handleSubmitStake({ body: { stake: 50, signedTx: 'x' } }, fake);
  assert.equal(out.worth, 0.10, 'the claimed 50 is ignored');
  assert.equal(out.stake, 0.10, 'the lobby is the one actually paid for');
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `node --test test/entryToken.test.js`
Expected: FAIL, `handleSubmitStake is not defined`

- [ ] **Step 3: Change the money adapter to take an amount**

```js
// server/money.js — usdcBackend
feeFor: (amount) => Number(amount) || 0,
async stakeQuote(amount) {
  const fee = Number(amount) || 0;
  const { blockhash } = await Usdc.getLatestBlockhash();
  return { mode: 'usdc', ...Usdc.stakeTargets(), amountUsdc: fee,
           units: Usdc.toUnits(fee).toString(), blockhash };
},
```

- [ ] **Step 4: Rewrite the two routes**

`/api/stake-quote?stake=` validates the range, then quotes. `/api/submit-stake`
verifies and mints from the **verified** worth:

```js
const { payer, worth } = await money.verifyStake(sig, requestedStake);
if (!(await db.markStakeSig(sig))) return res.status(400).json({ error: 'Stake already used' });
const entryToken = entryStore.mint({ stake: worth, worth, walletAddress: walletAddress || payer });
res.json({ ok: true, entryToken, worth, stake: worth });
```

- [ ] **Step 5: Run, syntax check, commit**

```bash
node --test && node --check server/money.js && node --check server/index.js
git add server/money.js server/index.js test/entryToken.test.js
git commit -m "feat: quote and verify stakes at any amount"
```

### Task 7: LobbyRegistry

**Files:**
- Create: `server/LobbyRegistry.js`
- Modify: `server/index.js:571-605`
- Test: `test/lobbyRegistry.test.js`

**Interfaces:**
- Produces: `new LobbyRegistry({ makeRoom })` with `get(game, region, stake)`, `list()`, `sweep()`

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { LobbyRegistry } = require('../server/LobbyRegistry');

const stub = () => ({ players: new Map(), started: true, start(){}, stop(){} });

test('a lobby is created on first ask and reused after', () => {
  const r = new LobbyRegistry({ makeRoom: stub });
  const a = r.get('snake', 'na', 0.25);
  const b = r.get('snake', 'na', 0.25);
  assert.equal(a, b, 'same lobby');
  assert.equal(r.list().length, 1);
});

test('stakes never mix', () => {
  const r = new LobbyRegistry({ makeRoom: stub });
  assert.notEqual(r.get('snake','na',0.25), r.get('snake','na',1.00));
  assert.equal(r.list().length, 2);
});

test('an empty lobby is withdrawn, a free one is kept', () => {
  const r = new LobbyRegistry({ makeRoom: stub, emptyMs: -1 });
  r.get('snake','na',1.00); r.get('snake','na',0);
  r.sweep();
  const stakes = r.list().map(l => l.stake);
  assert.deepEqual(stakes, [0], 'the free lobby always survives');
});

test('a lobby with players is never withdrawn', () => {
  const r = new LobbyRegistry({ makeRoom: stub, emptyMs: -1 });
  const room = r.get('snake','na',1.00);
  room.players.set('p1', {});
  r.sweep();
  assert.equal(r.list().length, 1);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `node --test test/lobbyRegistry.test.js`
Expected: FAIL, `Cannot find module '../server/LobbyRegistry'`

- [ ] **Step 3: Implement**

```js
'use strict';
/* Lobbies exist because a player created one, so an empty lobby is one that
   just started rather than a permanent ghost town. Keyed on the exact stake,
   so a $0.50 player and a $20 player are never in the same room. */
class LobbyRegistry {
  constructor({ makeRoom, emptyMs = 120000 }) {
    this.makeRoom = makeRoom; this.emptyMs = emptyMs; this.rooms = new Map();
  }
  key(game, region, stake) { return `${game}:${region}:${stake.toFixed(2)}`; }
  get(game, region, stake) {
    const k = this.key(game, region, stake);
    let e = this.rooms.get(k);
    if (!e) {
      e = { game, region, stake, room: this.makeRoom(game, region, stake), emptySince: Date.now() };
      e.room.start();
      this.rooms.set(k, e);
    }
    return e.room;
  }
  list() {
    return [...this.rooms.values()].map(e => ({
      id: this.key(e.game, e.region, e.stake), game: e.game, region: e.region,
      stake: e.stake, players: e.room.players.size,
    }));
  }
  sweep() {
    const now = Date.now();
    for (const [k, e] of this.rooms) {
      if (e.room.players.size > 0) { e.emptySince = null; continue; }
      if (e.stake === 0) continue;              // the free lobby is permanent
      if (e.emptySince == null) { e.emptySince = now; continue; }
      if (now - e.emptySince > this.emptyMs) { e.room.stop(); this.rooms.delete(k); }
    }
  }
}
module.exports = { LobbyRegistry };
```

- [ ] **Step 4: Run the tests**

Run: `node --test test/lobbyRegistry.test.js`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
node --check server/LobbyRegistry.js
git add server/LobbyRegistry.js test/lobbyRegistry.test.js
git commit -m "feat: add LobbyRegistry keyed on game, region and exact stake"
```

### Task 8: /api/live and the money-path smoke test

**Files:**
- Modify: `server/index.js`
- Test: manual, on mainnet, with a real wallet

- [ ] **Step 1: Add the board endpoint**

```js
app.get('/api/live', (_req, res) => res.json({ lobbies: registry.list() }));
```

- [ ] **Step 2: Run the whole suite**

Run: `node --test`
Expected: PASS, every file.

- [ ] **Step 3: Prove the money loop end to end on mainnet**

This is the gate. Do not proceed past it on a failure.

1. Stake $0.25 from a real wallet, confirm the transfer on Solscan.
2. Confirm the entry token opens **only** the $0.25 lobby.
3. Modify the client to claim $50 while paying $0.25 and confirm the server
   refuses it. This is the anti-cheat invariant; it must be proven, not assumed.
4. Eat, grow, cash out. Confirm the payout is 90% and the 10% cut stayed in escrow.
5. Confirm `db.markStakeSig` refuses a replayed signature.

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat: expose the live board and move rooms onto the registry"
```

---

## Phase 3 — The board and the stake control

### Task 9: Render the live board

**Files:**
- Create: `public/js/v2/board.js`, `public/js/v2/stake.js`

- [ ] **Step 1: Poll /api/live and render rows**

Rows sort by player count descending, so a new player sees the busiest
lobbies first. That convergence is the anti-fragmentation mechanism.

- [ ] **Step 2: Quick-pick chips**

`[0.25] [0.50] [1] [2] [5]` beside a free-text amount, so most players land
on the same handful of values without being restricted to them.

- [ ] **Step 3: Verify the empty board**

With no lobbies open, the board must show the persistent free lobby and an
invitation to open one, never "No open lobbies" with no way forward.

- [ ] **Step 4: Commit**

```bash
git add public/js/v2/board.js public/js/v2/stake.js public/v2.html
git commit -m "feat: render the live board with an any-amount stake control"
```

---

## Phase 4 — Play, spectate, appearance

### Task 10: Fire the real play flow

**Files:**
- Create: `public/js/v2/play.js`
- Modify: `public/wallet/widget.js`

**Interfaces:**
- Produces: `duel:play` CustomEvent carrying `{ game, stake, region }`

- [ ] **Step 1: Re-fire the existing contract**

```js
if (!ensureWallet()) return;
localStorage.setItem('duelseries_playername', name);
if (window.phEvent) window.phEvent('game_started', { game: 'snake', stake });
window.dispatchEvent(new CustomEvent('duel:play', { detail: { game: 'snake', stake, region } }));
```

- [ ] **Step 2: Teach the widget to read `stake` instead of `lobbyType`**

Read `public/wallet/widget.js` first and change only the field it reads from
the event detail. The staking call itself stays as it is.

- [ ] **Step 3: Keep the animation pause contract**

The game runs in an iframe on the shared main thread, so
`window._pauseLobbyAnims()` must still stop the ticker, the still card and
the appearance snake before the iframe is shown, and `_resumeLobbyAnims()`
restart them on `postMessage('game:done')`. Skipping this reintroduces the
30fps drop that cost a day to find.

- [ ] **Step 4: Verify a full free game, then a paid one**

- [ ] **Step 5: Commit**

```bash
git add public/js/v2/play.js public/wallet/widget.js public/v2.html
git commit -m "feat: wire v2 play and spectate to the real launch flow"
```

### Task 11: Appearance screen against the real skin store

**Files:**
- Create: `public/js/v2/look.js`

- [ ] **Step 1: Reuse the live key**

Read and write `duelseries_skin_id`, so the two lobbies agree on the skin
during the parallel period. The colour list is already copied verbatim from
`public/js/lobby.js:1090-1109` including ids.

- [ ] **Step 2: Verify a skin picked at /v2 is what the game plays**

- [ ] **Step 3: Commit**

```bash
git add public/js/v2/look.js public/v2.html
git commit -m "feat: wire the v2 appearance screen to the shared skin store"
```

---

## Phase 5 — Cutover

### Task 12: Make the new lobby the default

**Files:**
- Modify: `server/index.js`, `public/index.html`

- [ ] **Step 1: Swap the routes**

`/` serves the new lobby; the old one moves to `/legacy` for one release so
there is a way back without a revert.

- [ ] **Step 2: Watch a real session**

Confirm via PostHog that `logged_in`, `game_started` and `cashed_out` still
fire, and that session replay shows no dead clicks on the new board.

- [ ] **Step 3: Commit**

```bash
git add server/index.js
git commit -m "feat: make the redesigned lobby the default"
```

### Task 13: Delete the old lobby

Only after a week with no regressions.

- [ ] **Step 1: Remove `public/js/lobby.js`, the old markup, and `/legacy`**
- [ ] **Step 2: Run the full suite and commit**

---

## Phase 6 — Mobile

### Task 14: Fix the header overflow and the responsive pass

**Files:**
- Modify: `public/v2.html`

- [ ] **Step 1: Fix the 255px header overflow**

The header is a single non-wrapping flex row holding the logo, six nav
icons, the balance, the wallet button and the avatar, plus a 352px wallet
dropdown. Collapse the nav to a bottom bar under 760px and move the balance
into the wallet screen.

- [ ] **Step 2: Verify no horizontal scroll at 320, 375 and 414px**

- [ ] **Step 3: Confirm every control meets the 44px target**

- [ ] **Step 4: Commit**

```bash
git add public/v2.html
git commit -m "fix: make the redesigned lobby work on phones"
```

---

## Risks

- **Task 5–8 touch real money.** They are the only tasks that can lose funds.
  The gate is Task 8 Step 3, which must be run on mainnet with a real wallet,
  including the deliberate cheat attempt.
- **Two lobbies share one skin key and one wallet** during Phases 0–4. That is
  intended, but it means a bug in the v2 skin write corrupts the live lobby's
  skin too. `look.js` must validate against the known id list before writing.
- **agar.io becomes unreachable from the lobby** at cutover. `agarRooms` stay
  running server-side, so nothing is destroyed, but no player can reach them
  until agar.io is restored to the board.
- **`MIN_STAKE` and `MAX_STAKE` are new invented numbers.** They were unset in
  the spec. 0.10 matches today's lowest tier; 100 is a guess and should be
  confirmed before Task 6 ships.
- **Empty-lobby expiry is 120s**, also new. The spec left it open. A lobby that
  expires while a player is mid-stake would take their money and give them no
  room, so the sweep must never withdraw a lobby with a pending entry token
  against it.
