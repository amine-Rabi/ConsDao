# Constitutional DAO — Optimistic Democracy on GenLayer

A DAO where every bounty proposal must pass a natural-language **constitution**
check — decided by GenLayer validator consensus — *before* members are allowed to
vote on it. After an approved bounty is claimed, a second consensus decision
judges whether the delivered work satisfies the proposal before the treasury
pays out.

Inspired by the "Constitutional DAO" project from GenLayer's first hackathon,
rebuilt around the optimistic-democracy model.

## Where GenLayer consensus is actually used

Most of a DAO is plain deterministic logic and does **not** need AI consensus.
Only two steps require subjective, validator-verified judgment:

| Step | Mechanism | Why |
|------|-----------|-----|
| Submit proposal | deterministic | just storage |
| **Constitution compliance check** | **optimistic LLM verdict + appeal window** | subjective judgment |
| Member voting | deterministic | counting votes |
| **Delivery verification before payout** | **optimistic LLM verdict + appeal window** | subjective judgment |
| Transfer funds | deterministic | balance math |

The contract uses a **custom validator function** (`gl.vm.run_nondet_unsafe`) for
both consensus decisions: the leader produces a verdict, and each validator
independently re-derives the verdict and must agree on the decision field. This
is real consensus, not leader-output rubber-stamping.

## Project layout

```
contracts/constitutional_dao.py   # the intelligent contract
tests/direct/                      # fast direct-mode tests (17 cases)
ui/                                # self-contained demo front-end
```

## Contract

- Runner version is pinned (required by all GenLayer networks).
- Money is stored in atto-units (`u256`, value × 10^18) for cross-chain safety.
- Errors are classified (`[EXPECTED]`, `[EXTERNAL]`, `[TRANSIENT]`, `[LLM_ERROR]`)
  so validators compare failure paths correctly.
- LLM responses are parsed defensively (key aliasing, JSON cleanup).

### Develop

```bash
genvm-lint check contracts/constitutional_dao.py     # lint + validate
pytest tests/direct/ -v                              # run direct-mode tests
```

> Note on Windows: the `gltest` direct loader deletes a temp file while it is
> still open as stdin, which Windows forbids. `tests/direct/conftest.py` includes
> a small shim that makes `os.unlink` tolerant of that single harness quirk. It
> does not change contract behavior.

## UI (live dApp)

The app talks to the deployed contract on studionet. There are two signing paths:

- **Backend signer (default):** the Node server in `server/` holds the private key
  from `.env` and signs all writes server-side. The browser never holds a key.
- **Wallet (optional):** click **Connect Wallet** to sign writes with MetaMask
  instead. Reads always go through the backend.

If the backend is unreachable the page falls back to a local simulation so it
still runs, with a banner showing the active mode.

Visual design was generated with the `ui-ux-pro-max` skill: a data-dense
dashboard style with a web3 dark palette (purple `#8B5CF6` + gold `#FBBF24`),
Space Grotesk headings and Inter body.

### Run

```bash
cd server
npm install
npm start
# open http://localhost:8787
```

The server reads `GENLAYER_PRIVATE_KEY` and `GENLAYER_NETWORK` from the repo-root
`.env`, serves the UI from `ui/`, and exposes:

| Route | Purpose |
|-------|---------|
| `GET /api/config` | network, contract address, signer, canSign |
| `GET /api/state` | constitution + treasury + members + all proposals |
| `GET /api/proposal/:id` | one proposal |
| `POST /api/fund` | `{amount}` fund treasury |
| `POST /api/members` | `{address}` add a member (owner only) |
| `POST /api/proposals` | `{id,title,body,reward}` submit (triggers screening consensus) |
| `POST /api/proposals/:id/vote` | `{support}` |
| `POST /api/proposals/:id/finalize` | close voting |
| `POST /api/proposals/:id/deliver` | `{url}` claim + delivery verification consensus |

Try submitting a proposal mentioning "marketing" or "ad campaign" to see it
rejected under principle 2, and a normal open-source bounty to watch it pass
screening and move to voting.

## Deployed (studionet)

- Contract: `0x22b051788fb0a8c3ba84cA2Fb9248352aE709B52`
- The full flow has been exercised live: funding, a compliant proposal (→ voting)
  and a marketing proposal (→ rejected), plus a server-signed vote — all with
  multi-model validator consensus (gpt, claude, qwen, deepseek, gemini, grok…).


## Deploy on Vercel

The project is Vercel-ready:
- `public/` — the static dApp (served at the root)
- `api/index.mjs` — the Express backend as a serverless function (all `/api/*` routes)
- `vercel.json` — routes `/api/*` to the function; everything else is static
- Config is read from **environment variables** (set in the Vercel dashboard), with the local `.env` as a fallback for `npm start`

### Steps
1. Push the repo to GitHub and "Import Project" in Vercel (no framework preset needed).
2. In Vercel → Project → Settings → Environment Variables, set:
   - `GENLAYER_NETWORK` = `testnet-bradbury`
   - `CONTRACT_ADDRESS` = `0x0B2460cbB579Cd6854101C8cC7568903a22Ac75E`
   - *(optional)* `GENLAYER_APPELLANT_KEY` — a funded appeal signer
3. Deploy.

### ⚠️ Security: do NOT put the signing key on a public deployment
The backend signs transactions with `GENLAYER_PRIVATE_KEY`. If you set that variable
on a **public** Vercel deployment, anyone who finds the URL can call the write
endpoints and spend that account's GEN or mutate the DAO — there is no auth.

Recommended for public deploys:
- **Leave `GENLAYER_PRIVATE_KEY` unset.** The backend then runs **read-only**
  (`canSign:false`), and all writes are signed by the visitor's own **MetaMask
  wallet** (the UI prompts "Connect Wallet"). This is the standard, safe dApp model.
- Only set the server key if the deployment is private / access-controlled, or add
  an auth gate to the write routes first.
