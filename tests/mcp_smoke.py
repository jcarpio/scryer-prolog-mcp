#!/usr/bin/env python3
"""Optional, independent MCP end-to-end smoke test.

Run from the MCP repository root on Fedora (only once Docker Compose is up):

  sudo docker run --rm --network pld-dify_default --env-file .env \
    -v "$PWD/tests/mcp_smoke.py:/tests/mcp_smoke.py:ro" \
    python:3.12-alpine python /tests/mcp_smoke.py

If using the accompanying documentation archive rather than copying the script
into the MCP checkout, mount its absolute path instead. This is an additional
verification helper, NOT part of the field-validated installation.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.getenv("MCP_BASE_URL", "http://pld-scryer-prolog-mcp:8000")
KEY = os.environ.get("MCP_API_KEY", "")
if not KEY:
    sys.exit("ERROR: MCP_API_KEY is not set (use --env-file .env).")


def request(method, path, data=None, *, auth=True, session=None):
    headers = {"Accept": "application/json, text/event-stream"}
    if auth:
        headers["X-API-Key"] = KEY
    if data is not None:
        headers["Content-Type"] = "application/json"
        body = json.dumps(data, separators=(",", ":")).encode()
    else:
        body = None
    if session:
        headers["Mcp-Session-Id"] = session
    req = urllib.request.Request(BASE + path, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            text = res.read(2_000_000).decode()
            return res.status, dict(res.headers.items()), text
    except urllib.error.HTTPError as err:
        return err.code, dict(err.headers.items()), err.read(8192).decode(errors="replace")


def rpc(data, *, session=None):
    status, headers, text = request("POST", "/mcp", data, session=session)
    if status != 200:
        raise RuntimeError(f"MCP request HTTP {status}: {text[:400]}")
    # Some MCP gateways return SSE; others return direct JSON.
    if text.lstrip().startswith("{"):
        payload = json.loads(text)
    else:
        messages = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        if not messages:
            raise RuntimeError(f"No JSON-RPC message in response: {text[:300]}")
        payload = json.loads(messages[-1])
    if "error" in payload:
        raise RuntimeError(f"MCP JSON-RPC error: {payload['error']}")
    return headers, payload.get("result", {})


status, _, body = request("GET", "/healthz", auth=False)
assert status == 200, (status, body)
print("PASS /healthz HTTP 200")

status, _, _ = request("GET", "/mcp", auth=False)
assert status == 401, f"Expected HTTP 401 without API key; got {status}"
print("PASS unauthenticated MCP request rejected")

headers, result = rpc({
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {
        "protocolVersion": "2025-03-26", "capabilities": {},
        "clientInfo": {"name": "pld-smoke-test", "version": "1.0"},
    },
})
assert result.get("serverInfo", {}).get("name") == "scryer-prolog-mcp", result
session = next((v for k, v in headers.items() if k.lower() == "mcp-session-id"), None)
print("PASS MCP initialize", "(session obtained)" if session else "(no session header)")

_, result = rpc({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}, session=session)
names = {tool["name"] for tool in result["tools"]}
expected = {"runProgramQuery", "loadProgram", "runPrologQuery", "saveSession", "loadSession"}
assert expected.issubset(names), (names, expected)
print("PASS tools/list:", ", ".join(sorted(names)))

_, result = rpc({
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {
        "name": "runProgramQuery",
        "arguments": {
            "program": ":- use_module(library(clpz)).",
            "query": "X #= 2 + 3",
            "template": "X",
        },
    },
}, session=session)
assert not result.get("isError", False), result
contents = [p.get("text", "") for p in result.get("content", []) if p.get("type") == "text"]
assert contents, result
inner = json.loads(contents[0])
assert inner.get("status") == "success", inner
assert "'X'=5" in inner.get("result", ""), inner
print("PASS CLP(Z) runProgramQuery: X = 5")
print("ALL TESTS PASSED (gateway, authentication, discovery, Prolog).")
