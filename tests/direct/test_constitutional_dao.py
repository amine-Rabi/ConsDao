"""Direct-mode tests for the Constitutional DAO intelligent contract.

These exercise the deterministic logic plus the LEADER side of the two
consensus decisions (constitution screening and delivery verification).
Validator-agreement logic is covered separately by integration tests.
"""

import json

from conftest import (
    CONSTITUTION,
    mock_compliance,
    mock_delivery_page,
    mock_delivery_verdict,
)

CONTRACT = "contracts/constitutional_dao.py"
ONE_TOKEN = 10**18


def _hex(addr) -> str:
    """Render a test address (raw bytes or object) as a 0x hex string."""
    if isinstance(addr, (bytes, bytearray)):
        return "0x" + bytes(addr).hex()
    if hasattr(addr, "as_hex"):
        return addr.as_hex
    return str(addr)


# ---------------------------------------------------------------------------
# Deployment & membership
# ---------------------------------------------------------------------------
def test_deploy_sets_owner_as_first_member(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    assert dao.get_constitution() == CONSTITUTION
    assert dao.is_member(_hex(direct_owner)) is True
    assert dao.get_treasury() == "0"


def test_only_owner_can_add_members(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    dao = direct_deploy(CONTRACT, CONSTITUTION)

    direct_vm.sender = direct_alice
    with direct_vm.expect_revert("Only owner can add members"):
        dao.add_member(_hex(direct_bob))

    direct_vm.sender = direct_owner
    dao.add_member(_hex(direct_alice))
    assert dao.is_member(_hex(direct_alice)) is True


def test_fund_treasury_accumulates(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(5 * ONE_TOKEN)
    dao.fund_treasury(3 * ONE_TOKEN)
    assert dao.get_treasury() == str(8 * ONE_TOKEN)


def test_fund_treasury_rejects_non_positive(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    with direct_vm.expect_revert("Amount must be positive"):
        dao.fund_treasury(0)


# ---------------------------------------------------------------------------
# 1) Proposal screening against the constitution (consensus / LLM)
# ---------------------------------------------------------------------------
def test_compliant_proposal_goes_to_voting(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)

    mock_compliance(direct_vm, "pass", "Open-source privacy tool, aligns with principle 1.")
    dao.submit_proposal("p1", "Build a Tor bridge", "Open-source MIT bridge relay tooling.", 2 * ONE_TOKEN)

    p = dao.get_proposal("p1")
    assert p["status"] == "voting"
    assert "principle 1" in p["compliance_reason"]


def test_noncompliant_proposal_is_rejected(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)

    mock_compliance(direct_vm, "fail", "Funds marketing, violates principle 2.")
    dao.submit_proposal("p2", "Twitter ad campaign", "Pay influencers to promote our token.", 2 * ONE_TOKEN)

    p = dao.get_proposal("p2")
    assert p["status"] == "rejected"
    assert "principle 2" in p["compliance_reason"]


def test_non_member_cannot_submit(direct_vm, direct_deploy, direct_owner, direct_alice):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)

    direct_vm.sender = direct_alice
    mock_compliance(direct_vm, "pass")
    with direct_vm.expect_revert("Only members can submit proposals"):
        dao.submit_proposal("p3", "x", "y", ONE_TOKEN)


def test_reward_cannot_exceed_treasury(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(ONE_TOKEN)

    mock_compliance(direct_vm, "pass")
    with direct_vm.expect_revert("Reward exceeds treasury balance"):
        dao.submit_proposal("p4", "x", "y", 5 * ONE_TOKEN)


def test_duplicate_proposal_id_rejected(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)

    mock_compliance(direct_vm, "pass")
    dao.submit_proposal("dup", "x", "y", ONE_TOKEN)
    with direct_vm.expect_revert("Proposal id already exists"):
        dao.submit_proposal("dup", "x2", "y2", ONE_TOKEN)


# ---------------------------------------------------------------------------
# 2) Voting (deterministic)
# ---------------------------------------------------------------------------
def _seed_voting_proposal(direct_vm, dao, direct_owner, pid="pv"):
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    mock_compliance(direct_vm, "pass")
    dao.submit_proposal(pid, "Build a tool", "Open-source tool.", 2 * ONE_TOKEN)
    return pid


def test_vote_counts_and_majority_approves(direct_vm, direct_deploy, direct_owner, direct_alice, direct_bob):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    pid = _seed_voting_proposal(direct_vm, dao, direct_owner)

    direct_vm.sender = direct_owner
    dao.add_member(_hex(direct_alice))
    dao.add_member(_hex(direct_bob))

    direct_vm.sender = direct_owner
    dao.vote(pid, True)
    direct_vm.sender = direct_alice
    dao.vote(pid, True)
    direct_vm.sender = direct_bob
    dao.vote(pid, False)

    p = dao.get_proposal(pid)
    assert p["votes_for"] == "2"
    assert p["votes_against"] == "1"

    direct_vm.sender = direct_owner
    dao.finalize_vote(pid)
    assert dao.get_proposal(pid)["status"] == "approved"


def test_minority_support_declines(direct_vm, direct_deploy, direct_owner, direct_alice):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    pid = _seed_voting_proposal(direct_vm, dao, direct_owner)

    direct_vm.sender = direct_owner
    dao.add_member(_hex(direct_alice))

    direct_vm.sender = direct_owner
    dao.vote(pid, False)
    direct_vm.sender = direct_alice
    dao.vote(pid, False)

    direct_vm.sender = direct_owner
    dao.finalize_vote(pid)
    assert dao.get_proposal(pid)["status"] == "declined"


def test_double_vote_rejected(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    pid = _seed_voting_proposal(direct_vm, dao, direct_owner)

    direct_vm.sender = direct_owner
    dao.vote(pid, True)
    with direct_vm.expect_revert("Already voted"):
        dao.vote(pid, True)


def test_cannot_vote_on_rejected_proposal(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    mock_compliance(direct_vm, "fail", "violates principle 2")
    dao.submit_proposal("pr", "ads", "promote token", ONE_TOKEN)

    with direct_vm.expect_revert("Proposal is not open for voting"):
        dao.vote("pr", True)


# ---------------------------------------------------------------------------
# 3) Delivery claim + verification (consensus / LLM + web)
# ---------------------------------------------------------------------------
def _approved_proposal(direct_vm, dao, direct_owner, pid="pd"):
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    mock_compliance(direct_vm, "pass")
    dao.submit_proposal(pid, "Build a tool", "Open-source tool with tests.", 2 * ONE_TOKEN)
    dao.vote(pid, True)
    dao.finalize_vote(pid)
    return pid


def test_successful_delivery_pays_out(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    pid = _approved_proposal(direct_vm, dao, direct_owner)

    direct_vm.clear_mocks()
    mock_delivery_page(direct_vm, "Repo README: open-source tool with full test suite.")
    mock_delivery_verdict(direct_vm, "pass", "Matches requirements.")

    dao.claim_delivery(pid, "https://github.com/example/tool")

    p = dao.get_proposal(pid)
    assert p["status"] == "paid"
    # treasury reduced by the 2-token reward
    assert dao.get_treasury() == str(8 * ONE_TOKEN)


def test_failed_delivery_does_not_pay(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    pid = _approved_proposal(direct_vm, dao, direct_owner)

    direct_vm.clear_mocks()
    mock_delivery_page(direct_vm, "Empty repo, no code.")
    mock_delivery_verdict(direct_vm, "fail", "No deliverable found.")

    dao.claim_delivery(pid, "https://github.com/example/empty")

    p = dao.get_proposal(pid)
    assert p["status"] == "delivery_rejected"
    # treasury untouched
    assert dao.get_treasury() == str(10 * ONE_TOKEN)


def test_cannot_claim_unapproved_proposal(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    mock_compliance(direct_vm, "pass")
    dao.submit_proposal("pc", "x", "y", ONE_TOKEN)  # status: voting, not approved

    direct_vm.clear_mocks()
    mock_delivery_page(direct_vm, "stuff")
    mock_delivery_verdict(direct_vm, "pass")
    with direct_vm.expect_revert("Proposal not approved for delivery"):
        dao.claim_delivery("pc", "https://x")


# ---------------------------------------------------------------------------
# Listing
# ---------------------------------------------------------------------------
def test_list_proposals(direct_vm, direct_deploy, direct_owner):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    mock_compliance(direct_vm, "pass")
    dao.submit_proposal("a", "A", "open source", ONE_TOKEN)
    dao.submit_proposal("b", "B", "open source", ONE_TOKEN)

    listed = dao.list_proposals()
    ids = sorted(item["proposal_id"] for item in listed)
    assert ids == ["a", "b"]


def test_get_stats(direct_vm, direct_deploy, direct_owner, direct_alice):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    dao.add_member(_hex(direct_alice))
    mock_compliance(direct_vm, "pass")
    dao.submit_proposal("s1", "A", "open source", ONE_TOKEN)

    stats = dao.get_stats()
    assert stats["member_count"] == "2"
    assert stats["proposal_count"] == "1"
    assert stats["treasury_atto"] == str(10 * ONE_TOKEN)


# ---------------------------------------------------------------------------
# Stats & members views
# ---------------------------------------------------------------------------
def test_get_stats_and_members(direct_vm, direct_deploy, direct_owner, direct_alice):
    dao = direct_deploy(CONTRACT, CONSTITUTION)
    direct_vm.sender = direct_owner
    dao.fund_treasury(10 * ONE_TOKEN)
    dao.add_member(_hex(direct_alice))

    mock_compliance(direct_vm, "pass")
    dao.submit_proposal("s1", "Tool", "open source tool", ONE_TOKEN)
    direct_vm.clear_mocks()
    mock_compliance(direct_vm, "fail", "violates principle 2")
    dao.submit_proposal("s2", "ads", "promote token", ONE_TOKEN)

    listed = dao.list_proposals()
    statuses = sorted(item["status"] for item in listed)
    assert statuses == ["rejected", "voting"]

    members = dao.get_members()
    assert len(members) == 2
    assert dao.get_member_count() == "2"
