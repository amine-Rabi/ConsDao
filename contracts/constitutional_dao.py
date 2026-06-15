# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

"""
Constitutional DAO — an Intelligent Contract for GenLayer.

A DAO where every bounty proposal must pass a natural-language "constitution"
compliance check (decided by validator consensus) BEFORE members are allowed to
vote on it. After a funded bounty is claimed, a second consensus decision judges
whether the delivered work actually satisfies the proposal before funds are
released.

Where optimistic democracy / GenLayer consensus is used:
  1. submit_proposal  -> LLM judges proposal vs constitution (comparative validator)
  2. verify_delivery  -> LLM judges submitted work vs proposal (comparative validator)

Everything else (membership, voting tally, fund accounting) is deterministic and
does NOT use the LLM — by design, those steps do not need validator judgment.
"""

from genlayer import *

import json
import typing
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# Error classification prefixes (used so validators compare failures correctly)
# ---------------------------------------------------------------------------
ERROR_EXPECTED = "[EXPECTED]"    # Business-logic error — deterministic, exact match
ERROR_EXTERNAL = "[EXTERNAL]"    # External 4xx — deterministic, exact match
ERROR_TRANSIENT = "[TRANSIENT]"  # Network/5xx — agree if both transient
ERROR_LLM = "[LLM_ERROR]"        # LLM misbehavior — always disagree, force rotation


# ---------------------------------------------------------------------------
# Proposal lifecycle status values (stored as plain strings, never Enum)
# ---------------------------------------------------------------------------
STATUS_SCREENING = "screening"      # compliance verdict produced, in appeal window
STATUS_REJECTED = "rejected"        # failed constitution check (final)
STATUS_VOTING = "voting"            # passed constitution check, open for votes
STATUS_APPROVED = "approved"        # vote passed, awaiting delivery
STATUS_DECLINED = "declined"        # vote failed
STATUS_DELIVERED = "delivered"      # work submitted, delivery verdict in appeal window
STATUS_PAID = "paid"                # delivery verified, funds released
STATUS_DELIVERY_REJECTED = "delivery_rejected"  # delivery failed verification


@allow_storage
@dataclass
class Proposal:
    proposal_id: str
    author: Address
    title: str
    body: str                 # natural-language description of the bounty
    atto_reward: u256         # reward in atto-units (value * 10^18)
    status: str
    compliance_reason: str    # LLM reasoning for the compliance verdict
    delivery_url: str         # where the claimed work lives (set on claim)
    delivery_reason: str      # LLM reasoning for the delivery verdict
    votes_for: u256
    votes_against: u256
    created_at: str


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------
def _parse_verdict(analysis: typing.Any) -> dict:
    """Normalize an LLM compliance/delivery response into a stable verdict dict.

    Returns: {"decision": "pass"|"fail", "reason": str}
    Raises gl.vm.UserError(ERROR_LLM ...) when the response is unusable so the
    validator can force a rotation instead of locking bad state.
    """
    if not isinstance(analysis, dict):
        raise gl.vm.UserError(f"{ERROR_LLM} Non-dict LLM response: {type(analysis)}")

    raw = analysis.get("decision")
    if raw is None:
        for alt in ("verdict", "result", "compliant", "passed", "approve"):
            if alt in analysis:
                raw = analysis[alt]
                break

    if raw is None:
        raise gl.vm.UserError(
            f"{ERROR_LLM} Missing 'decision'. Keys: {list(analysis.keys())}"
        )

    # Coerce many shapes (bool, "pass"/"fail", "yes"/"no", "compliant") to pass/fail
    if isinstance(raw, bool):
        decision = "pass" if raw else "fail"
    else:
        token = str(raw).strip().lower()
        if token in ("pass", "passed", "yes", "true", "compliant", "approve", "approved", "1"):
            decision = "pass"
        elif token in ("fail", "failed", "no", "false", "noncompliant", "non-compliant", "reject", "rejected", "0"):
            decision = "fail"
        else:
            raise gl.vm.UserError(f"{ERROR_LLM} Unrecognized decision: {raw!r}")

    reason = analysis.get("reason") or analysis.get("reasoning") or analysis.get("analysis") or ""
    return {"decision": decision, "reason": str(reason)[:1000]}


def _handle_leader_error(leaders_res: gl.vm.Result, leader_fn) -> bool:
    """Standard validator-side handling when the leader returned an error."""
    leader_msg = leaders_res.message if hasattr(leaders_res, "message") else ""
    try:
        leader_fn()
        return False  # leader errored but validator succeeded -> disagree
    except gl.vm.UserError as e:
        validator_msg = e.message if hasattr(e, "message") else str(e)
        if validator_msg.startswith(ERROR_EXPECTED) or validator_msg.startswith(ERROR_EXTERNAL):
            return validator_msg == leader_msg
        if validator_msg.startswith(ERROR_TRANSIENT) and leader_msg.startswith(ERROR_TRANSIENT):
            return True
        return False
    except Exception:
        return False


class ConstitutionalDAO(gl.Contract):
    # --- storage fields (class-level annotations declare the slots) ---
    owner: Address
    constitution: str
    treasury_atto: u256                       # atto-units held by the DAO
    members: TreeMap[Address, bool]
    member_count: u256
    member_order: DynArray[str]
    proposals: TreeMap[str, Proposal]
    proposal_order: DynArray[str]
    proposal_count: u256
    # voter tracking: key "<proposal_id>:<address>" -> True once voted
    has_voted: TreeMap[str, bool]

    def __init__(self, constitution: str):
        self.owner = gl.message.sender_address
        self.constitution = constitution
        self.treasury_atto = u256(0)
        self.member_count = u256(0)
        self.proposal_count = u256(0)
        # The deployer is the first member.
        self.members[gl.message.sender_address] = True
        self.member_count = u256(1)
        self.member_order.append(gl.message.sender_address.as_hex)

    # -----------------------------------------------------------------
    # Membership & treasury (deterministic — no consensus/LLM needed)
    # -----------------------------------------------------------------
    @gl.public.write
    def add_member(self, member: str) -> None:
        if gl.message.sender_address != self.owner:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only owner can add members")
        addr = Address(member)
        if not self.members.get(addr, False):
            self.members[addr] = True
            self.member_count = u256(self.member_count + 1)
            self.member_order.append(addr.as_hex)

    @gl.public.view
    def get_members(self) -> list:
        return [m for m in self.member_order]

    @gl.public.write
    def fund_treasury(self, atto_amount: int) -> None:
        """Record a contribution to the DAO treasury (atto-scale units)."""
        if atto_amount <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Amount must be positive")
        self.treasury_atto = u256(self.treasury_atto + atto_amount)

    @gl.public.view
    def get_constitution(self) -> str:
        return self.constitution

    @gl.public.view
    def is_member(self, addr: str) -> bool:
        return self.members.get(Address(addr), False)

    @gl.public.view
    def get_treasury(self) -> str:
        return str(self.treasury_atto)

    @gl.public.view
    def get_member_count(self) -> str:
        return str(self.member_count)

    @gl.public.view
    def get_stats(self) -> dict:
        return {
            "member_count": str(self.member_count),
            "proposal_count": str(self.proposal_count),
            "treasury_atto": str(self.treasury_atto),
        }

    # -----------------------------------------------------------------
    # 1) PROPOSAL SCREENING — uses GenLayer consensus (LLM vs constitution)
    # -----------------------------------------------------------------
    @gl.public.write
    def submit_proposal(
        self, proposal_id: str, title: str, body: str, atto_reward: int
    ) -> None:
        sender = gl.message.sender_address
        if not self.members.get(sender, False):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only members can submit proposals")
        if proposal_id in self.proposals:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Proposal id already exists")
        if atto_reward <= 0:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Reward must be positive")
        if atto_reward > int(self.treasury_atto):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Reward exceeds treasury balance")

        verdict = self._check_compliance(title, body)

        status = STATUS_VOTING if verdict["decision"] == "pass" else STATUS_REJECTED

        self.proposals[proposal_id] = Proposal(
            proposal_id=proposal_id,
            author=sender,
            title=title,
            body=body,
            atto_reward=u256(atto_reward),
            status=status,
            compliance_reason=verdict["reason"],
            delivery_url="",
            delivery_reason="",
            votes_for=u256(0),
            votes_against=u256(0),
            created_at=str(gl.message.datetime) if hasattr(gl.message, "datetime") else "",
        )
        self.proposal_order.append(proposal_id)
        self.proposal_count = u256(self.proposal_count + 1)

    def _check_compliance(self, title: str, body: str) -> dict:
        """Run the constitution compliance check under validator consensus."""
        constitution = self.constitution

        def leader_fn() -> dict:
            prompt = f"""You are the constitutional review officer of a DAO.
Decide whether the following bounty proposal complies with the DAO constitution.
Judge ONLY against the constitution text. A proposal complies if it does not
violate any principle and is consistent with the DAO's stated purpose.

=== CONSTITUTION ===
{constitution}

=== PROPOSAL TITLE ===
{title}

=== PROPOSAL BODY ===
{body}

Respond ONLY with JSON of the form:
{{"decision": "pass" | "fail", "reason": "<one short paragraph citing the relevant principle>"}}"""
            analysis = gl.nondet.exec_prompt(prompt, response_format="json")
            if isinstance(analysis, str):
                analysis = _safe_json(analysis)
            return _parse_verdict(analysis)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            # Independently re-derive the verdict and require the decisions match.
            validator_verdict = leader_fn()
            leader_decision = leaders_res.calldata["decision"]
            return leader_decision == validator_verdict["decision"]

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    # -----------------------------------------------------------------
    # 2) VOTING (deterministic — just counting)
    # -----------------------------------------------------------------
    @gl.public.write
    def vote(self, proposal_id: str, support: bool) -> None:
        sender = gl.message.sender_address
        if not self.members.get(sender, False):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Only members can vote")
        if proposal_id not in self.proposals:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Unknown proposal")
        proposal = self.proposals[proposal_id]
        if proposal.status != STATUS_VOTING:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Proposal is not open for voting")

        vote_key = f"{proposal_id}:{sender.as_hex}"
        if self.has_voted.get(vote_key, False):
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Already voted")
        self.has_voted[vote_key] = True

        if support:
            proposal.votes_for = u256(proposal.votes_for + 1)
        else:
            proposal.votes_against = u256(proposal.votes_against + 1)

    @gl.public.write
    def finalize_vote(self, proposal_id: str) -> None:
        """Close voting and mark approved/declined by simple majority."""
        if proposal_id not in self.proposals:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Unknown proposal")
        proposal = self.proposals[proposal_id]
        if proposal.status != STATUS_VOTING:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Proposal is not in voting")
        if proposal.votes_for > proposal.votes_against:
            proposal.status = STATUS_APPROVED
        else:
            proposal.status = STATUS_DECLINED

    # -----------------------------------------------------------------
    # 3) DELIVERY CLAIM + VERIFICATION — uses GenLayer consensus again
    # -----------------------------------------------------------------
    @gl.public.write
    def claim_delivery(self, proposal_id: str, delivery_url: str) -> None:
        sender = gl.message.sender_address
        if proposal_id not in self.proposals:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Unknown proposal")
        proposal = self.proposals[proposal_id]
        if proposal.status != STATUS_APPROVED:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Proposal not approved for delivery")
        proposal.delivery_url = delivery_url

        verdict = self._verify_delivery(proposal.title, proposal.body, delivery_url)
        proposal.delivery_reason = verdict["reason"]

        if verdict["decision"] == "pass":
            reward = int(proposal.atto_reward)
            if reward > int(self.treasury_atto):
                raise gl.vm.UserError(f"{ERROR_EXPECTED} Treasury cannot cover reward")
            self.treasury_atto = u256(self.treasury_atto - reward)
            proposal.status = STATUS_PAID
        else:
            proposal.status = STATUS_DELIVERY_REJECTED

    def _verify_delivery(self, title: str, body: str, delivery_url: str) -> dict:
        """Judge whether the delivered work (fetched from the web) satisfies the bounty."""

        def leader_fn() -> dict:
            try:
                page = gl.nondet.web.render(delivery_url, mode="text")
            except Exception as e:
                raise gl.vm.UserError(f"{ERROR_TRANSIENT} Could not fetch delivery: {e}")
            content = _extract_text(page)[:8000]

            prompt = f"""You verify whether delivered work satisfies a DAO bounty.

=== BOUNTY TITLE ===
{title}

=== BOUNTY REQUIREMENTS ===
{body}

=== DELIVERED WORK (fetched from {delivery_url}) ===
{content}

Decide if the delivered work substantively satisfies the bounty requirements.
Respond ONLY with JSON:
{{"decision": "pass" | "fail", "reason": "<short justification>"}}"""
            analysis = gl.nondet.exec_prompt(prompt, response_format="json")
            if isinstance(analysis, str):
                analysis = _safe_json(analysis)
            return _parse_verdict(analysis)

        def validator_fn(leaders_res: gl.vm.Result) -> bool:
            if not isinstance(leaders_res, gl.vm.Return):
                return _handle_leader_error(leaders_res, leader_fn)
            validator_verdict = leader_fn()
            return leaders_res.calldata["decision"] == validator_verdict["decision"]

        return gl.vm.run_nondet_unsafe(leader_fn, validator_fn)

    # -----------------------------------------------------------------
    # Read helpers
    # -----------------------------------------------------------------
    @gl.public.view
    def get_proposal(self, proposal_id: str) -> dict:
        if proposal_id not in self.proposals:
            raise gl.vm.UserError(f"{ERROR_EXPECTED} Unknown proposal")
        p = self.proposals[proposal_id]
        return {
            "proposal_id": p.proposal_id,
            "author": p.author.as_hex,
            "title": p.title,
            "body": p.body,
            "atto_reward": str(p.atto_reward),
            "status": p.status,
            "compliance_reason": p.compliance_reason,
            "delivery_url": p.delivery_url,
            "delivery_reason": p.delivery_reason,
            "votes_for": str(p.votes_for),
            "votes_against": str(p.votes_against),
            "created_at": p.created_at,
        }

    @gl.public.view
    def list_proposals(self) -> list:
        out = []
        for pid in self.proposal_order:
            p = self.proposals[pid]
            out.append({
                "proposal_id": p.proposal_id,
                "title": p.title,
                "status": p.status,
                "atto_reward": str(p.atto_reward),
                "votes_for": str(p.votes_for),
                "votes_against": str(p.votes_against),
            })
        return out


def _extract_text(page: typing.Any) -> str:
    """Normalize the various shapes gl.nondet.web.render may return into text."""
    if isinstance(page, str):
        return page
    if isinstance(page, dict):
        # Common shapes: {"text": ...} or {"ok": {"text": ...}}
        if "text" in page:
            return str(page["text"])
        ok = page.get("ok")
        if isinstance(ok, dict) and "text" in ok:
            return str(ok["text"])
    return str(page)


def _safe_json(text: str) -> dict:
    """Clean common LLM JSON issues then parse. Raises ERROR_LLM on failure."""
    import re
    try:
        first = text.find("{")
        last = text.rfind("}")
        if first == -1 or last == -1:
            raise ValueError("no JSON object found")
        snippet = text[first:last + 1]
        snippet = re.sub(r",(?!\s*?[\{\[\"\'\w])", "", snippet)
        return json.loads(snippet)
    except Exception as e:
        raise gl.vm.UserError(f"{ERROR_LLM} Could not parse JSON: {e}")
