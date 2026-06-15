/* Constitutional DAO — front-end.
 *
 * Reads and writes go through the local backend (server/index.mjs), which signs
 * transactions with the key from .env. Optionally the user can click
 * "Connect Wallet" to sign writes with MetaMask instead; reads stay on the backend.
 *
 * If the backend is unreachable, the page falls back to a local simulation so it
 * still runs. A banner shows the active mode.
 */

import * as chain from "./chain.js";

const state = {
  mode: "connecting", // "live" | "demo"
  cfg: null,
  treasuryGen: 0,
  members: [],
  paidGen: 0,
  proposals: [],
  newIds: new Set(), // proposals submitted this session — highlighted briefly
  busy: false,
};

const HIGHLIGHT_MS = 10000;

function markNew(id) {
  state.newIds.add(id);
  setTimeout(() => { state.newIds.delete(id); render(); }, HIGHLIGHT_MS);
}

/* ---------- Helpers ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ATTO = 10n ** 18n;
const attoToGen = (s) => Number(BigInt(s) / ATTO);

function toast(title, body, kind = "") {
  const wrap = $("#toastWrap");
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.setAttribute("role", kind === "err" ? "alert" : "status");
  el.innerHTML = `<div class="tt">${esc(title)}</div><div class="tb">${esc(body)}</div>`;
  wrap.appendChild(el);
  setTimeout(() => { el.style.transition = "opacity .3s ease"; el.style.opacity = "0"; setTimeout(() => el.remove(), 300); }, 5000);
}

const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';

const STATUS_LABEL = {
  screening: ["Screening", "s-screening"],
  voting: ["Voting", "s-voting"],
  rejected: ["Rejected", "s-rejected"],
  approved: ["Approved", "s-approved"],
  declined: ["Declined", "s-rejected"],
  delivered: ["Verifying delivery", "s-delivered"],
  paid: ["Paid", "s-paid"],
  delivery_rejected: ["Delivery rejected", "s-rejected"],
};

/* ---------- Local simulation (fallback) ---------- */
function mockVerdict(title, body) {
  const text = `${title} ${body}`.toLowerCase();
  const banned = ["marketing", "advertis", "promote our token", "token price", "pump", "influencer", "ad campaign", "billboard"];
  const hit = banned.find((w) => text.includes(w));
  if (hit) return { decision: "fail", reason: `Violates principle 2: appears to fund marketing/advertising ("${hit}").` };
  if (!/(open[- ]?source|mit|apache|gpl|repo|library|tool|protocol|code|sdk|client|bridge|audit|docs|test)/.test(text))
    return { decision: "fail", reason: "Could not confirm open-source software work under principle 1." };
  return { decision: "pass", reason: "Aligns with principle 1 and does not violate principles 2–4." };
}

/* ---------- Rendering ---------- */
function renderMode() {
  const el = $("#modeBanner");
  if (state.mode === "live") {
    const c = state.cfg?.contract || "";
    const signer = state.cfg?.canSign ? "backend signer active" : "read-only (no server key)";
    el.innerHTML = `Live on ${esc(state.cfg?.network || "studionet")} · <span class="mono">${c.slice(0, 10)}…${c.slice(-4)}</span> · ${esc(signer)}`;
    el.className = "mode-banner live";
  } else if (state.mode === "demo") {
    el.textContent = "Demo mode (backend unreachable) — verdicts simulated locally";
    el.className = "mode-banner demo";
  } else {
    el.textContent = "Connecting…";
    el.className = "mode-banner";
  }
}

function renderKpis() {
  $("#kpiTreasury").innerHTML = `${state.treasuryGen.toFixed(1)} <small>GEN</small>`;
  $("#kpiMembers").textContent = String(Array.isArray(state.members) ? state.members.length : state.members);
  $("#kpiVoting").textContent = String(state.proposals.filter((p) => p.status === "voting").length);
  $("#kpiPaid").innerHTML = `${state.paidGen} <small>GEN</small>`;
}

function renderMembers() {
  const el = $("#memberList");
  if (!el) return;
  const list = Array.isArray(state.members) ? state.members : [];
  if (list.length === 0) { el.innerHTML = `<div class="empty" style="padding:var(--space-4)">No members yet.</div>`; return; }
  el.innerHTML = list.map((m) => `<div class="member"><span class="mono">${esc(m.slice(0, 8))}…${esc(m.slice(-4))}</span></div>`).join("");
}

function renderProposals() {
  const list = $("#proposalList");
  if (state.proposals.length === 0) {
    list.innerHTML = `<div class="empty">No proposals yet. Submit a bounty to watch it get screened against the constitution.</div>`;
    return;
  }
  list.innerHTML = state.proposals.map(renderProposal).join("");
}

function renderProposal(p) {
  const [label, cls] = STATUS_LABEL[p.status] || [p.status, "s-screening"];
  const total = p.votesFor + p.votesAgainst;
  const forPct = total ? (p.votesFor / total) * 100 : 0;
  const againstPct = total ? (p.votesAgainst / total) * 100 : 0;

  let verdictBox = "";
  if (p.complianceReason) verdictBox += `<div class="verdict"><div class="vh">${SHIELD} Constitution verdict (consensus)</div>${esc(p.complianceReason)}</div>`;
  if (p.deliveryReason) verdictBox += `<div class="verdict"><div class="vh">${SHIELD} Delivery verdict (consensus)</div>${esc(p.deliveryReason)}</div>`;

  let votes = "";
  if (p.status === "voting") {
    votes = `
      <div class="votes">
        <div class="votebar" role="img" aria-label="${p.votesFor} for, ${p.votesAgainst} against">
          <div class="for" style="width:${forPct}%"></div><div class="against" style="width:${againstPct}%"></div>
        </div>
        <span class="votecount">${p.votesFor} for · ${p.votesAgainst} against</span>
      </div>`;
  }

  let actions = "";
  const dis = state.busy ? "disabled" : "";
  if (p.status === "voting") {
    actions = `
      <div class="actions">
        <button class="btn-for" type="button" data-act="vote-for" data-id="${p.id}" ${dis}>Vote for</button>
        <button class="btn-against" type="button" data-act="vote-against" data-id="${p.id}" ${dis}>Vote against</button>
        <button class="btn-ghost" type="button" data-act="finalize" data-id="${p.id}" ${dis}>Close vote</button>
      </div>`;
  } else if (p.status === "approved") {
    actions = `<div class="actions"><button class="btn-primary" type="button" data-act="claim" data-id="${p.id}" ${dis}>Submit delivery &amp; verify</button></div>`;
  } else if (p.status === "rejected") {
    actions = `<div class="actions"><button class="btn-ghost" type="button" data-act="appeal-screening" data-id="${p.id}" ${dis}>Appeal verdict</button></div>`;
  } else if (p.status === "delivery_rejected" || p.status === "paid") {
    actions = `<div class="actions"><button class="btn-ghost" type="button" data-act="appeal-delivery" data-id="${p.id}" ${dis}>Appeal delivery verdict</button></div>`;
  }

  return `
    <article class="proposal${state.newIds.has(p.id) ? " is-new" : ""}" id="prop-${p.id}">
      <div class="head">
        <div>
          <div class="title">${esc(p.title)}</div>
          <div class="meta">by <span class="mono">${esc(p.author)}</span></div>
        </div>
        <span class="reward">${p.reward} GEN</span>
      </div>
      <div style="margin-top:8px"><span class="status ${cls}">${label}</span></div>
      <p class="body">${esc(p.body)}</p>
      ${verdictBox}
      ${votes}
      ${actions}
    </article>`;
}

function render() { renderMode(); renderKpis(); renderMembers(); renderProposals(); }

/* ---------- Live data ---------- */
function shapeProposal(raw) {
  return {
    id: raw.proposal_id,
    title: raw.title,
    body: raw.body,
    reward: attoToGen(raw.atto_reward),
    author: raw.author ? `${raw.author.slice(0, 6)}…${raw.author.slice(-4)}` : "—",
    status: raw.status,
    complianceReason: raw.compliance_reason || "",
    deliveryReason: raw.delivery_reason || "",
    deliveryUrl: raw.delivery_url || "",
    votesFor: Number(raw.votes_for || 0),
    votesAgainst: Number(raw.votes_against || 0),
  };
}

async function loadLive() {
  const s = await chain.fetchState();
  state.treasuryGen = Number(BigInt(s.treasury) / ATTO);
  state.members = s.members || [];
  // Newest first: the contract appends in submission order, so reverse it.
  state.proposals = (s.proposals || []).map(shapeProposal).reverse();
  state.paidGen = state.proposals.filter((p) => p.status === "paid").reduce((a, p) => a + p.reward, 0);
}

async function refresh() {
  if (state.mode !== "live") return;
  try { await loadLive(); render(); } catch (e) { console.error("refresh failed", e); }
}

/* ---------- Actions ---------- */
function setBusy(b) {
  state.busy = b;
  $("#submitBtn").disabled = b;
  $("#submitBtn").textContent = b ? "Working…" : "Submit for screening";
  renderProposals();
}

async function txFlow(label, fn) {
  setBusy(true);
  toast(label, "Sent to the network. Validators are reaching consensus — this can take ~10–30s.");
  try {
    const r = await fn();
    const hash = typeof r === "string" ? r : r?.hash;
    const short = hash ? `${hash.slice(0, 10)}…${hash.slice(-6)}` : "";
    toast("Confirmed", `Consensus reached.${short ? " tx " + short : ""} Refreshing…`, "ok");
    await refresh();
  } catch (e) {
    console.error(e);
    toast(`${label} failed`, String(e?.message || e), "err");
  } finally {
    setBusy(false);
  }
}

async function onAppeal(p, phase) {
  if (state.mode === "demo") {
    toast("Appeal (demo)", "On a live network this re-runs consensus with a rotated validator set.", "");
    return;
  }
  setBusy(true);
  try {
    const status = await chain.appealStatus(p.id, phase);
    if (!status.txHash) { toast("Cannot appeal", "No recorded verdict transaction for this proposal.", "err"); return; }
    if (!status.canAppeal) {
      toast("Appeal window closed", status.reason || "This verdict is finalized and can no longer be appealed.", "err");
      return;
    }
    toast("Appealing", "Submitting an appeal — a rotated validator set will re-judge this verdict…");
    await chain.appeal(p.id, phase);
    toast("Appeal submitted", "The verdict is being re-evaluated by new validators.", "ok");
    setTimeout(refresh, 4000);
  } catch (e) {
    console.error(e);
    toast("Appeal failed", String(e?.message || e), "err");
  } finally {
    setBusy(false);
  }
}

/* ---------- Demo flow ---------- */
function demoSubmit(title, body, reward) {
  if (reward > state.treasuryGen) { toast("Rejected", "Reward exceeds treasury balance.", "err"); return; }
  const v = mockVerdict(title, body);
  const id = `p${Date.now()}`;
  const p = { id, title, body, reward, author: "0xYouR…a1b2",
    status: v.decision === "pass" ? "voting" : "rejected", complianceReason: v.reason,
    deliveryReason: "", deliveryUrl: "", votesFor: 0, votesAgainst: 0 };
  state.proposals.unshift(p);
  markNew(id);
  toast(p.status === "voting" ? "Passed screening" : "Rejected", v.reason, p.status === "voting" ? "ok" : "err");
  render();
}

/* ---------- Handlers ---------- */
$("#proposalForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#pTitle").value.trim();
  const body = $("#pBody").value.trim();
  const reward = parseInt($("#pReward").value, 10);
  if (!title || !body || !reward || reward < 1) { toast("Missing fields", "Title, description and a reward ≥ 1 GEN are required.", "err"); return; }
  if (state.mode === "demo") { demoSubmit(title, body, reward); e.target.reset(); return; }

  // If signing with a connected wallet, it must be a DAO member.
  if (chain.isWalletConnected()) {
    const addr = chain.walletAddress();
    const ok = await chain.isMember(addr);
    if (!ok) {
      toast("Wallet not a member", `${addr.slice(0,6)}…${addr.slice(-4)} isn't a DAO member, so it can't submit. Ask the owner to add it (Members → + Add), or disconnect the wallet to submit via the backend signer.`, "err");
      return;
    }
  }

  const id = `p-${Date.now().toString(36)}`;
  txFlow("Submitting proposal", async () => { await chain.submitProposal(id, title, body, reward); markNew(id); });
  e.target.reset();
});

$("#proposalList").addEventListener("pointermove", (e) => {
  const card = e.target.closest(".proposal");
  if (!card) return;
  const r = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${e.clientX - r.left}px`);
  card.style.setProperty("--my", `${e.clientY - r.top}px`);
});

$("#proposalList").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const p = state.proposals.find((x) => x.id === btn.dataset.id);
  if (!p) return;
  if (state.mode === "demo") {
    if (btn.dataset.act === "vote-for") p.votesFor++;
    else if (btn.dataset.act === "vote-against") p.votesAgainst++;
    else if (btn.dataset.act === "finalize") p.status = p.votesFor > p.votesAgainst ? "approved" : "declined";
    render();
    return;
  }
  switch (btn.dataset.act) {
    case "vote-for": txFlow("Voting", () => chain.vote(p.id, true)); break;
    case "vote-against": txFlow("Voting", () => chain.vote(p.id, false)); break;
    case "finalize": txFlow("Finalizing vote", () => chain.finalizeVote(p.id)); break;
    case "claim": {
      const url = prompt("Paste the delivery URL (try one containing 'empty' to see a rejection):", "https://github.com/dao/encrypted-backups");
      if (url) txFlow("Verifying delivery", () => chain.claimDelivery(p.id, url));
      break;
    }
    case "appeal-screening": onAppeal(p, "screening"); break;
    case "appeal-delivery": onAppeal(p, "delivery"); break;
  }
});

$("#fundBtn").addEventListener("click", () => {
  if (state.mode === "demo") { state.treasuryGen += 50; render(); toast("Funded (demo)", "Added 50 GEN.", "ok"); return; }
  const amt = parseInt(prompt("Amount of GEN to add to the treasury:", "50") || "0", 10);
  if (amt > 0) txFlow("Funding treasury", () => chain.fundTreasury(amt));
});

$("#addMemberBtn").addEventListener("click", () => {
  const addr = (prompt("Member address (0x…):", "") || "").trim();
  if (!addr) return;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { toast("Invalid address", "Expected a 0x-prefixed 40-hex address.", "err"); return; }
  if (state.mode === "demo") { state.members = [...(state.members || []), addr]; render(); toast("Member added (demo)", addr, "ok"); return; }
  txFlow("Adding member", () => chain.addMember(addr));
});

$("#memberForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const addr = $("#mAddr").value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { toast("Invalid address", "Enter a valid 0x… address (40 hex chars).", "err"); return; }
  if (state.mode === "demo") { state.members += 1; render(); toast("Member added (demo)", addr, "ok"); e.target.reset(); return; }
  txFlow("Adding member", () => chain.addMember(addr));
  e.target.reset();
});

$("#connectBtn").addEventListener("click", async () => {
  console.log("[connect] clicked; mode=", state.mode);
  if (state.mode === "demo") { toast("Demo mode", "Backend is unreachable, so wallet connect is disabled. Start the server (npm start) and reload.", "err"); return; }
  if (chain.isWalletConnected()) { toast("Already connected", chain.walletAddress(), "ok"); return; }

  if (!window.ethereum) {
    toast("No wallet detected", "MetaMask isn't installed. You don't need it — the backend already signs every transaction. Just submit/vote directly.", "err");
    return;
  }

  const btn = $("#connectBtn");
  const prev = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Connecting…";
  toast("Opening wallet", "Approve the connection request in MetaMask…");
  try {
    const addr = await chain.connectWallet();
    btn.textContent = `${addr.slice(0, 6)}…${addr.slice(-4)}`;
    toast("Wallet connected", "Writes will be signed by your wallet where the network supports it.", "ok");
  } catch (e) {
    console.error("[connect] failed", e);
    btn.textContent = prev;
    toast("Connect failed", String(e?.message || e), "err");
  } finally {
    btn.disabled = false;
  }
});

/* ---------- Boot ---------- */
async function boot() {
  renderMode();
  try {
    state.cfg = await chain.getConfig();
    await loadLive();
    state.mode = "live";
    render();
    toast("Connected", `Reading live state from ${state.cfg.network}.`, "ok");
    setInterval(refresh, 12000);
  } catch (e) {
    console.warn("Backend unreachable, demo mode:", e);
    state.mode = "demo";
    seedDemo();
    render();
  }
}

function seedDemo() {
  state.treasuryGen = 120;
  state.members = ["0xA665bC8122Aa1299Bb70eDb4Df860B01cf96cB3d", "0x9f2c11aa00bb2233445566778899aabbccddee01"];
  state.proposals = [
    { id: "seed1", title: "Encrypted local backups for the wallet", body: "Open-source (MIT) module adding client-side encrypted backups with tests and docs.", author: "0x9f2c…d4e1", status: "voting", complianceReason: "Aligns with principle 1 (open-source) and does not violate principles 2–4.", deliveryReason: "", deliveryUrl: "", votesFor: 2, votesAgainst: 1 },
    { id: "seed2", title: "Twitter ad campaign for token launch", body: "Pay influencers to promote our token and run paid ad placements.", author: "0x4b71…aa09", status: "rejected", complianceReason: 'Violates principle 2: appears to fund marketing/advertising ("ad campaign").', deliveryReason: "", deliveryUrl: "", votesFor: 0, votesAgainst: 0 },
  ];
}

boot();
