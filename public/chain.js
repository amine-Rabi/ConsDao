// Front-end chain layer for the Constitutional DAO UI.
//
// Two signing paths:
//   1. BACKEND (default): reads/writes go through the local server (server/index.mjs),
//      which signs with the key from .env. The browser never holds a key.
//   2. WALLET (optional): if the user clicks "Connect Wallet", writes are signed by
//      MetaMask via genlayer-js; reads still use the backend.
//
// All requests are same-origin to the backend that serves this page.

let _wallet = null; // { client, address }  (set when MetaMask connected)
let _sdk = null;
let _chains = null;
let _types = null;
let _config = null; // { network, contract, signer, canSign }

const ATTO = 10n ** 18n;

// Map CLI-style network names to genlayer-js chain export keys.
const CHAIN_KEYS = {
  localnet: "localnet",
  studionet: "studionet",
  "testnet-asimov": "testnetAsimov",
  "testnet-bradbury": "testnetBradbury",
};
function chainKey(net) { return CHAIN_KEYS[net] || net; }
function isStudio(net) { return net === "studionet" || net === "localnet"; }

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function getConfig() {
  if (!_config) _config = await api("/api/config");
  return _config;
}

/* ---------------- Reads (always via backend) ---------------- */
export async function fetchState() {
  return api("/api/state");
}

/* ---------------- Wallet (optional MetaMask path) ---------------- */
async function loadSdk() {
  if (_sdk) return;
  const V = "https://esm.sh/genlayer-js@1.1.8";
  const withTimeout = (p, ms, what) =>
    Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`Timed out loading ${what} (network/CDN blocked?)`)), ms))]);
  const [sdk, chains, types] = await withTimeout(
    Promise.all([import(V), import(`${V}/chains`), import(`${V}/types`)]),
    15000,
    "wallet SDK",
  );
  _sdk = sdk; _chains = chains; _types = types;
}

export async function connectWallet() {
  if (!window.ethereum) throw new Error("No browser wallet found. The backend already signs transactions, so a wallet is optional.");
  const cfg = await getConfig();

  // Request account access first — this is what pops MetaMask.
  let address;
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    address = accounts && accounts[0];
  } catch (e) {
    if (e && (e.code === 4001 || /reject/i.test(String(e.message)))) throw new Error("You rejected the connection request.");
    throw e;
  }
  if (!address) throw new Error("No account returned by the wallet.");

  // studionet/localnet are GenLayer Studio networks; MetaMask cannot sign there.
  // Connect the address for display but keep signing on the backend.
  if (isStudio(cfg.network)) {
    _wallet = { client: null, address, backendOnly: true };
    return address;
  }

  await loadSdk();
  const chain = _chains[chainKey(cfg.network)] || _chains.studionet;
  const client = _sdk.createClient({ chain, account: address, provider: window.ethereum });
  try { await client.connect(chainKey(cfg.network)); } catch (_) { /* wallet may already be on chain */ }
  _wallet = { client, address };
  return address;
}

export function walletAddress() { return _wallet?.address || null; }
export function isWalletConnected() { return !!_wallet; }

// Check DAO membership of an address (via the backend read).
export async function isMember(addr) {
  try { const r = await api(`/api/member/${addr}`); return !!r.isMember; }
  catch { return false; }
}

async function walletWrite(functionName, args) {
  // On studionet (or whenever we only have the address), route through the backend signer.
  if (!_wallet || _wallet.backendOnly || !_wallet.client) return null;
  await loadSdk();
  const cfg = await getConfig();
  const hash = await _wallet.client.writeContract({ address: cfg.contract, functionName, args, value: 0n });
  await _wallet.client.waitForTransactionReceipt({ hash, status: _types.TransactionStatus.ACCEPTED, fullTransaction: false });
  return hash;
}

const gen = (whole) => BigInt(Math.trunc(Number(whole))) * ATTO;

// True only when the wallet can actually sign (non-studionet, has a client).
function canWalletSign() { return !!(_wallet && !_wallet.backendOnly && _wallet.client); }

/* ---------------- Writes (wallet if it can sign, else backend) ---------------- */
export async function fundTreasury(amount) {
  if (canWalletSign()) return walletWrite("fund_treasury", [gen(amount)]);
  return api("/api/fund", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount }) });
}

export async function addMember(address) {
  if (canWalletSign()) return walletWrite("add_member", [address]);
  return api("/api/members", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }) });
}

export async function submitProposal(id, title, body, reward) {
  if (canWalletSign()) return walletWrite("submit_proposal", [id, title, body, gen(reward)]);
  return api("/api/proposals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, title, body, reward }) });
}

export async function vote(id, support) {
  if (canWalletSign()) return walletWrite("vote", [id, !!support]);
  return api(`/api/proposals/${encodeURIComponent(id)}/vote`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ support }) });
}

export async function finalizeVote(id) {
  if (canWalletSign()) return walletWrite("finalize_vote", [id]);
  return api(`/api/proposals/${encodeURIComponent(id)}/finalize`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
}

export async function claimDelivery(id, url) {
  if (canWalletSign()) return walletWrite("claim_delivery", [id, url]);
  return api(`/api/proposals/${encodeURIComponent(id)}/deliver`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
}

// Appeals are protocol-level (re-run consensus on the verdict tx). The backend
// holds the tx hash and submits the appeal with the server key.
export async function appealStatus(id, phase = "screening") {
  return api(`/api/proposals/${encodeURIComponent(id)}/appeal?phase=${phase}`);
}

export async function appeal(id, phase = "screening") {
  return api(`/api/proposals/${encodeURIComponent(id)}/appeal`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phase }) });
}

export { ATTO };
