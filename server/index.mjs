// Constitutional DAO backend.
//
// - Serves the static front-end in ../ui
// - Exposes read endpoints (proxied to studionet) so the browser never needs a key
// - Exposes write endpoints signed server-side with the key from ../.env
//
// The private key NEVER leaves the server. The browser only calls these routes.

import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import * as chains from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ---- Config loader: prefer process.env (Vercel), fall back to local .env file ----
function loadFileEnv() {
  const out = {};
  const f = join(ROOT, ".env");
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = loadFileEnv();
const env = (k) => process.env[k] ?? fileEnv[k];

const NETWORK = env("GENLAYER_NETWORK") || "testnet-bradbury";
const CONTRACT = env("CONTRACT_ADDRESS") || "0x0B2460cbB579Cd6854101C8cC7568903a22Ac75E";
const PORT = env("PORT") || 8787;
const ATTO = 10n ** 18n;

let PK = env("GENLAYER_PRIVATE_KEY") || "";
if (PK && !PK.startsWith("0x")) PK = "0x" + PK;

// Map CLI-style network names to genlayer-js chain export keys.
const CHAIN_KEYS = {
  localnet: "localnet",
  studionet: "studionet",
  "testnet-asimov": "testnetAsimov",
  "testnet-bradbury": "testnetBradbury",
  testnetAsimov: "testnetAsimov",
  testnetBradbury: "testnetBradbury",
};
const chain = chains[CHAIN_KEYS[NETWORK] || NETWORK] || chains.studionet;

// Read client (no account needed).
const readClient = createClient({ chain });

// Write client (server-signed) — only if a key is configured.
let writeClient = null;
let signerAddress = null;
if (PK) {
  const account = createAccount(PK);
  signerAddress = account.address;
  writeClient = createClient({ chain, account });
  console.log(`[server] signer ready: ${signerAddress}`);
} else {
  console.warn("[server] no GENLAYER_PRIVATE_KEY in .env — write routes disabled.");
}

// Separate appellant client (appeals must come from a different account than the
// original submitter — GenLayer reverts CanNotAppeal otherwise).
let appealClient = null;
let appellantAddress = null;
let APK = env("GENLAYER_APPELLANT_KEY") || "";
if (APK) {
  if (!APK.startsWith("0x")) APK = "0x" + APK;
  const aAcct = createAccount(APK);
  appellantAddress = aAcct.address;
  appealClient = createClient({ chain, account: aAcct });
  console.log(`[server] appellant ready: ${appellantAddress}`);
}

const gen = (whole) => BigInt(Math.trunc(Number(whole))) * ATTO;

const app = express();
app.use(express.json());

// ---- Reads ----
async function read(functionName, args = []) {
  return readClient.readContract({ address: CONTRACT, functionName, args });
}

app.get("/api/config", (_req, res) => {
  res.json({ network: NETWORK, contract: CONTRACT, signer: signerAddress, appellant: appellantAddress, canSign: !!writeClient });
});

app.get("/api/state", async (_req, res) => {
  try {
    const [constitution, treasury, list, members] = await Promise.all([
      read("get_constitution"),
      read("get_treasury"),
      read("list_proposals"),
      read("get_members"),
    ]);
    const proposals = await Promise.all(
      (list || []).map((it) => read("get_proposal", [it.proposal_id]))
    );
    res.json({ constitution, treasury: String(treasury), members: members || [], proposals });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});

app.get("/api/proposal/:id", async (req, res) => {
  try {
    res.json(await read("get_proposal", [req.params.id]));
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});

// ---- Writes (server-signed) ----
// Persisted map of proposalId -> { screening: txHash, delivery: txHash } so we
// know which transaction to appeal for each verdict.
const TXMAP_FILE = join(__dirname, "txmap.json");
let txMap = {};
try { if (existsSync(TXMAP_FILE)) txMap = JSON.parse(readFileSync(TXMAP_FILE, "utf8")); } catch { txMap = {}; }
function saveTxMap() { try { writeFileSync(TXMAP_FILE, JSON.stringify(txMap, null, 2)); } catch (e) { console.warn("[server] could not persist txmap", e); } }
function recordTx(id, phase, hash) {
  if (!txMap[id]) txMap[id] = {};
  txMap[id][phase] = hash;
  saveTxMap();
}

// Core write: returns { hash, status }. Throws on failure.
async function doWrite(functionName, args) {
  if (!writeClient) { const e = new Error("Server signing disabled (no key in .env)."); e.status = 403; throw e; }
  const hash = await writeClient.writeContract({ address: CONTRACT, functionName, args, value: 0n });
  const receipt = await readClient.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, fullTransaction: false });
  return { hash, status: receipt?.statusName || "ACCEPTED" };
}

// Convenience wrapper that writes and sends the HTTP response.
async function write(res, functionName, args) {
  try {
    const out = await doWrite(functionName, args);
    res.json(out);
    return out;
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e?.message || e) });
    return null;
  }
}

app.post("/api/fund", (req, res) => write(res, "fund_treasury", [gen(req.body.amount)]));

app.post("/api/members", (req, res) => {
  const addr = req.body?.address;
  if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return res.status(400).json({ error: "valid 0x address required" });
  write(res, "add_member", [addr]);
});

app.get("/api/member/:addr", async (req, res) => {
  try {
    res.json({ address: req.params.addr, isMember: await read("is_member", [req.params.addr]) });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});

app.post("/api/proposals", async (req, res) => {
  const { id, title, body, reward } = req.body || {};
  if (!id || !title || !body || !reward) return res.status(400).json({ error: "id, title, body, reward required" });
  try {
    const out = await doWrite("submit_proposal", [id, title, body, gen(reward)]);
    recordTx(id, "screening", out.hash); // remember the screening tx for appeals
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e?.message || e) });
  }
});

app.post("/api/proposals/:id/vote", (req, res) =>
  write(res, "vote", [req.params.id, !!req.body.support])
);

app.post("/api/proposals/:id/finalize", (req, res) =>
  write(res, "finalize_vote", [req.params.id])
);

app.post("/api/proposals/:id/deliver", async (req, res) => {
  const url = req.body?.url;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const out = await doWrite("claim_delivery", [req.params.id, url]);
    recordTx(req.params.id, "delivery", out.hash); // remember the delivery tx for appeals
    res.json(out);
  } catch (e) {
    res.status(e.status || 502).json({ error: String(e?.message || e) });
  }
});

// ---- Appeals (protocol-level: re-run consensus on the verdict transaction) ----
// A verdict can only be appealed during its challenge window — once the tx
// FINALIZES the result is locked (the point of optimistic democracy).
async function appealability(hash) {
  if (!hash) return { canAppeal: false, reason: "No recorded verdict transaction for this proposal/phase." };
  try {
    const tx = await readClient.getTransaction({ hash });
    const status = tx?.statusName || tx?.status;
    if (status === "FINALIZED") return { status, canAppeal: false, reason: "Verdict is finalized — the appeal window has closed." };
    const can = await readClient.canAppeal({ txId: hash });
    return { status, canAppeal: !!can, reason: can ? "" : "Not currently appealable." };
  } catch (e) {
    return { canAppeal: false, reason: String(e?.message || e) };
  }
}

app.get("/api/proposals/:id/appeal", async (req, res) => {
  const phase = req.query.phase === "delivery" ? "delivery" : "screening";
  const hash = txMap[req.params.id]?.[phase];
  const a = await appealability(hash);
  res.json({ txHash: hash || null, ...a });
});

app.post("/api/proposals/:id/appeal", async (req, res) => {
  const signer = appealClient || writeClient;
  if (!signer) return res.status(403).json({ error: "Server signing disabled (no key in .env)." });
  const phase = req.body?.phase === "delivery" ? "delivery" : "screening";
  const hash = txMap[req.params.id]?.[phase];
  if (!hash) return res.status(404).json({ error: "No recorded verdict transaction to appeal for this proposal." });
  const a = await appealability(hash);
  if (!a.canAppeal) return res.status(409).json({ error: a.reason || "This verdict can no longer be appealed." });
  try {
    let bond = 0n;
    try { bond = await readClient.getMinAppealBond({ txId: hash }); } catch (_) { /* default 0 */ }
    const result = await signer.appealTransaction({ txId: hash, value: bond });
    res.json({ ok: true, appealed: hash, phase, bond: String(bond), by: appellantAddress || signerAddress, result: result?.hash || result?.txId || "submitted" });
  } catch (e) {
    res.status(502).json({ error: String(e?.message || e) });
  }
});

// ---- Static front-end (local dev only; on Vercel, public/ is served statically) ----
app.use(express.static(join(ROOT, "public")));

// Only start a listening server when run directly (local dev). On Vercel the app
// is imported by the serverless function and must not call listen().
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}  (network=${NETWORK}, contract=${CONTRACT})`);
  });
}

export default app;
