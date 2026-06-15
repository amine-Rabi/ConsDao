"""Shared fixtures and mock helpers for Constitutional DAO direct-mode tests."""

import json
import os

# ---------------------------------------------------------------------------
# Windows compatibility shim.
# The gltest direct loader dup2()s a temp file into stdin and then immediately
# os.unlink()s it. On Windows you cannot delete a file that still has an open
# handle, so the harness raises PermissionError [WinError 32]. We make unlink
# tolerant of that one case; the OS reclaims the temp file later. This does not
# affect contract behavior — it only patches test-harness file cleanup.
# ---------------------------------------------------------------------------
_real_unlink = os.unlink


def _tolerant_unlink(path, *args, **kwargs):
    try:
        return _real_unlink(path, *args, **kwargs)
    except PermissionError:
        return None


os.unlink = _tolerant_unlink

CONSTITUTION = """The DAO funds open-source software that advances privacy and
user sovereignty. Principles:
1. Funds may only support open-source work released under an OSI-approved license.
2. No proposal may fund marketing, advertising, or token-price promotion.
3. No proposal may fund anything illegal or harmful to users.
4. Rewards must be proportionate to the scope of work described."""


def mock_compliance(direct_vm, decision: str, reason: str = "ok"):
    """Mock the constitution-compliance LLM call."""
    direct_vm.mock_llm(
        r".*constitutional review officer.*",
        json.dumps({"decision": decision, "reason": reason}),
    )


def mock_delivery_page(direct_vm, body: str):
    """Mock the web fetch of a delivered-work URL."""
    direct_vm.mock_web(r".*", {"status": 200, "body": body})


def mock_delivery_verdict(direct_vm, decision: str, reason: str = "ok"):
    """Mock the delivery-verification LLM call."""
    direct_vm.mock_llm(
        r".*verify whether delivered work.*",
        json.dumps({"decision": decision, "reason": reason}),
    )
