# Scryer Prolog MCP on Fedora: Reproducible Docker Deployment, Dify Integration, and Operational Hardening

**Project:** Personal Life Director (PLD)  
**Field deployment:** 7 November 2026  
**Document language:** English  
**Status:** **Working and integrated with Dify for trusted internal testing.** Production hardening and reboot validation remain open.  
**Repository:** https://github.com/jcarpio/scryer-prolog-mcp  
**Suggested repository location:** `docs/deployment/SCRYER_PROLOG_MCP_FEDORA_DIFY_DEPLOYMENT.md`

> **Scope and evidence.** This report reconstructs the actual installation and troubleshooting carried out on the PLD HP/Fedora host. Commands whose outputs were observed are labeled **Verified**. Future checks and security improvements are labeled **Pending** or **Recommended**. Do not interpret an unperformed check as a passed test. Screenshots are taken from the original field session and are included under `assets/`.
>
> **Security warning.** The MCP tools execute caller-supplied Prolog programs. Their existing time and output limits are **not a security sandbox**. The deployed container is suitable for trusted internal experiments only until egress restrictions and stronger workload isolation have been assessed.

## Contents

1. [Executive summary and evidence](#1-executive-summary-and-evidence)
2. [System architecture](#2-system-architecture)
3. [Prerequisites and inventory](#3-prerequisites-and-inventory)
4. [Inspect and obtain the MCP source code](#4-inspect-and-obtain-the-mcp-source-code)
5. [Build Scryer Prolog and Supergateway with Docker](#5-build-scryer-prolog-and-supergateway-with-docker)
6. [Solve the OpenSSL shared-library failure](#6-solve-the-openssl-shared-library-failure)
7. [Deploy as an independent Docker Compose service](#7-deploy-as-an-independent-docker-compose-service)
8. [Validate service startup, transport, authentication, tools, and CLPZ](#8-validate-service-startup-transport-authentication-tools-and-clpz)
9. [Connect the MCP server to Dify](#9-connect-the-mcp-server-to-dify)
10. [Diagnose and correct Dify's SSRF proxy restriction](#10-diagnose-and-correct-difys-ssrf-proxy-restriction)
11. [Resolve Dify authentication and OAuth fallback errors](#11-resolve-dify-authentication-and-oauth-fallback-errors)
12. [Final verification matrix](#12-final-verification-matrix)
13. [Finish the installation safely: open operational checks](#13-finish-the-installation-safely-open-operational-checks)
14. [Hardening roadmap and threat model](#14-hardening-roadmap-and-threat-model)
15. [Operations, diagnostics, updates, rollback, and backup](#15-operations-diagnostics-updates-rollback-and-backup)
16. [Mac examples and Timely workflow recovery](#16-mac-examples-and-timely-workflow-recovery)
17. [Troubleshooting reference](#17-troubleshooting-reference)
18. [Reference files, sources, and provenance](#18-reference-files-sources-and-provenance)

---

## 1. Executive summary and evidence

This deployment runs the native **Scryer Prolog** engine behind an **MCP (Model Context Protocol)** server written in Node.js. Because the repository implements MCP over **stdio**, **Supergateway** translates incoming **Streamable HTTP** requests from Dify to the stdio process. The service is packaged separately from Dify as a Docker Compose project, joined to Dify's existing Docker bridge network, and protected with a randomly generated API key.

**Observed working state:**

- Docker image `pld-scryer-mcp:0.1` was built on Fedora.
- `scryer-prolog --version` ran successfully and output `cargo:0.10.0`.
- Supergateway listened on container port `8000`, with HTTP MCP endpoint `/mcp` and health endpoint `/healthz`.
- The HTTP health check returned **200 OK** with body `ok`.
- A request lacking an API key returned **401 Unauthorized**.
- Authenticated MCP `initialize` returned **200 OK**, a session ID, and server info `scryer-prolog-mcp` version `0.1.0`.
- `tools/list` returned **five tools**.
- `runProgramQuery` evaluated the integer constraint `X #= 2 + 3` and returned `X = 5` via Scryer `library(clpz)`.
- Dify's SSRF proxy was adjusted via a **specific private-domain exception**, and the Dify UI finally showed **Authorized — 5 tools included**.

**Not yet shown by the field evidence:** a successful `tools/call` invoked from inside a Dify workflow/agent, persistence across an actual Fedora reboot, an active Docker healthcheck with failover, permanent session persistence, or robust isolation for untrusted Prolog. These are explicitly covered in §13–14.

![Successful initial Docker image build](assets/01-docker-build-success.jpg)

*Figure 1. Initial Docker image completed successfully. A successful image build did not yet prove the native binary could load its shared libraries.*

## 2. System architecture

### 2.1 Topology

```mermaid
flowchart TD
  Mac[MacBook on university VPN] -->|SSH tunnel to localhost:8080| UI[Dify Web UI]
  subgraph HP[HP workstation — Fedora 43]
    UI --> API[Dify API / MCP client]
    API -->|HTTP via SSRF forward proxy| Squid[pld-dify-ssrf_proxy-1:3128]
    Squid -->|allowlisted hostname, TCP 8000| GW[pld-scryer-prolog-mcp:8000]
    GW -->|MCP Streamable HTTP /mcp| Trans[Supergateway 4.2.1]
    Trans -->|MCP stdio| MCP[Node.js 22 — index.mjs]
    MCP -->|spawn a separate process| Prolog[Scryer Prolog 0.10.0 + CLP\(Z\)]
  end
  GW -.->|container joins| Net[pld-dify_default bridge]
  API -.-> Net
```

The image **does not publish any TCP port on the HP host**. `8000/tcp` in `docker compose ps` is the container's declared internal port, **not** the same as a host mapping such as `0.0.0.0:8000->8000/tcp`.

### 2.2 Relevant addresses and names

| Item | Actual field value | Meaning |
|---|---|---|
| Fedora host | `172.16.172.184` | University network; used by VPN/SSH |
| Host project root | `/mnt/data/personal-life-director/` | Large SSD used for PLD |
| MCP checkout | `/mnt/data/personal-life-director/services/scryer-prolog-mcp` | Git checkout, build context, Compose file |
| Dify Compose root | `/mnt/data/personal-life-director/dify/dify/docker` | Existing Dify deployment |
| Dify Docker project | `pld-dify` | **Must be specified with `-p pld-dify`** |
| MCP Docker project | `pld-scryer` | Independent Compose deployment |
| Dify Docker network | `pld-dify_default` | Pre-existing bridge network |
| MCP container | `pld-scryer-prolog-mcp` | DNS name on shared network |
| MCP URL in Dify | `http://pld-scryer-prolog-mcp:8000/mcp` | Internal service URL |
| Health endpoint | `http://pld-scryer-prolog-mcp:8000/healthz` | Does not require API key |
| Authentication | `X-API-Key: <64-hex-character-secret>` | A value, **not** `MCP_API_KEY=...` |

The deployment deliberately does **not** install Node.js or Scryer Prolog on Fedora itself. Host package installation was attempted using the interactive package-not-found helper and failed to authenticate, which had no effect on the subsequent successful Docker approach.

### 2.3 MCP state model

The repository has a server-wide in-memory `Engine.program` value per stdio process. `loadProgram` modifies that in-memory value, and `runPrologQuery` consumes it. **Do not assume two requests arriving through Dify will share the same stdio engine** without checking session routing. Prefer the atomic `runProgramQuery` tool for workflows, because it transmits source and query together and leaves the stored source untouched.

The `stateful` setting in Supergateway refers to MCP transport sessions; it does not imply persistent programs or files across container recreation.

## 3. Prerequisites and inventory

### 3.1 Prerequisites

- Fedora 43 host with functional Docker Engine and Docker Compose v2-compatible CLI (`sudo docker compose`).
- Working network connectivity and access to the source repository.
- Existing Dify installation as a Docker Compose project, known project name `pld-dify` in this case.
- Sufficient free space for Rust build layers and Node images.
- Shell user allowed to run `sudo docker`. Docker-socket access is high privilege; **do not add a user to the `docker` group merely to avoid sudo**.
- Authenticated Dify administrator access through VPN / SSH tunneling.
- For exact binary/build provenance, record Git commit and image digests at deployment time.

### 3.2 Field tool versions

| Component | Field observation |
|---|---|
| Host OS | Fedora Linux 43 |
| Host Git | `2.56.0` |
| Docker Compose CLI | `v5.7.0` |
| Container Node.js | major version `22` (version command ran; exact patch not captured) |
| `@modelcontextprotocol/sdk` | `1.32.2` in package.json |
| Scryer Prolog | installed Cargo package `0.10.0` |
| Supergateway | npm package `4.2.1` |
| MCP server package | `0.1.0` |
| Image tag | `pld-scryer-mcp:0.1` |
| Dify | deployed existing PLD instance; Dify UI confirmed connectivity |

For the reproducible installation, the package versions are constrained but Docker base image tags (`rust:1-bookworm`, `node:22-bookworm-slim`) may resolve to newer image builds later. See the reproducibility section (§14.4).

## 4. Inspect and obtain the MCP source code

The user cloned the repository on the host:

```bash
sudo docker compose version
git --version
mkdir -p /mnt/data/personal-life-director/services
cd /mnt/data/personal-life-director/services
git clone https://github.com/jcarpio/scryer-prolog-mcp.git
cd scryer-prolog-mcp
ls -la
cat package.json
```

Relevant `package.json` from the field deployment:

```json
{
  "name": "scryer-prolog-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node index.mjs",
    "test": "node smoke.mjs && node mcp-test.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.32.2"
  },
  "engines": {
    "node": ">=20"
  }
}
```

The user searched source files for protocol and native-engine clues:

```bash
grep -nE 'spawn|scryer-prolog|Stdio|HTTP|SSE|listen|PORT|MCP' \
  engine.mjs index.mjs README.md | head -70
```

This established:

- `index.mjs` imports `StdioServerTransport` and connects using `new StdioServerTransport()`.
- The Node MCP process has no built-in HTTP listener.
- `engine.mjs` uses `spawn(this.binary, ['-f', 'program.pl', '-g', token], ...)` to start a native Scryer process.
- The Scryer executable defaults to `scryer-prolog`; it can be overridden with `SCRYER_PROLOG`.
- Session paths can be overridden with `SCRYER_SESSIONS`.

Part of the actual engine (explanatory excerpt):

```js
constructor({
  binary = process.env.SCRYER_PROLOG || 'scryer-prolog',
  timeout = 15000,
  sessions = process.env.SCRYER_SESSIONS || join(homedir(), '.scryer-prolog-sessions')
} = {}) {
  this.binary = binary;
  this.timeout = timeout;
  this.sessions = sessions;
  this.program = '';
}

// Each query is evaluated in a separate process.
const child = spawn(this.binary,
  ['-f', join(dir, 'program.pl'), '-g', token],
  {cwd: dir, stdio: ['ignore', 'pipe', 'pipe']});
```

The implementation has a 15-second default timeout, limits combined stdout+stderr to approximately 1 MiB, and removes per-execution temporary directories. These are useful operational guardrails, **not** a substitute for a sandbox or host/network isolation. Long-running `spawn` child processes are killed on timeout. User-controlled source can still be dangerous in a trusted-network environment.

## 5. Build Scryer Prolog and Supergateway with Docker

The first build used a two-stage image: Rust for compiling Scryer, then a smaller Node.js runtime image. The field build completed, but the native executable initially lacked a runtime shared library. The **corrected final Dockerfile** is below and included separately in `deployment/Dockerfile`.

```dockerfile
# Phase 1: compile a pinned Scryer Prolog release.
FROM rust:1-bookworm AS prolog-builder
RUN cargo install --locked scryer-prolog --version 0.10.0

# Phase 2: Node.js runtime with required shared libraries.
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libssl3 \
       ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=prolog-builder \
  /usr/local/cargo/bin/scryer-prolog \
  /usr/local/bin/scryer-prolog

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm install --global supergateway@4.2.1
COPY index.mjs engine.mjs ./

ENV NODE_ENV=production
ENV SCRYER_PROLOG=/usr/local/bin/scryer-prolog
ENV SCRYER_SESSIONS=/sessions

RUN mkdir -p /sessions && chown node:node /sessions
USER node
EXPOSE 8000

CMD ["supergateway", \
     "--stdio", "node /app/index.mjs", \
     "--outputTransport", "streamableHttp", \
     "--stateful", \
     "--port", "8000", \
     "--healthEndpoint", "/healthz"]
```

**Build command:**

```bash
cd /mnt/data/personal-life-director/services/scryer-prolog-mcp
sudo docker build -t pld-scryer-mcp:0.1 .
```

Why this layout:

1. `cargo install --locked` compiles an explicitly selected Scryer release with lockfile-compatible dependency resolution.
2. `COPY --from=...` moves only the built native binary into the runtime stage.
3. `npm ci` installs npm dependencies according to `package-lock.json`.
4. `supergateway@4.2.1` is installed as a pinned transport bridge.
5. `USER node` avoids running the HTTP service as root.
6. The MCP command and its standard streams are managed by Supergateway. No shell service or Node package needs installation on Fedora.

**Field image output:** Docker reached `FINISHED`, exported the image, and tagged `pld-scryer-mcp:0.1`.

## 6. Solve the OpenSSL shared-library failure

The first container verification failed:

```bash
sudo docker run --rm \
  --entrypoint scryer-prolog \
  pld-scryer-mcp:0.1 --version
```

**Observed failure:**

```text
scryer-prolog: error while loading shared libraries:
libssl.so.3: cannot open shared object file: No such file or directory
```

![First run failed because libssl.so.3 was missing](assets/02-libssl-missing.jpg)

*Figure 2. Multi-stage builds can successfully copy an executable that still requires shared libraries at runtime.*

**Fix:** add to the runtime `node:22-bookworm-slim` stage:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
```

Rebuild and test:

```bash
sudo docker build -t pld-scryer-mcp:0.1 .
sudo docker run --rm \
  --entrypoint scryer-prolog \
  pld-scryer-mcp:0.1 --version
```

**Verified output:**

```text
cargo:0.10.0
```

The value `cargo:0.10.0` is Scryer's version output in this build; it is not a failure.

![Image rebuilt after adding libssl3](assets/03-docker-build-with-libssl.jpg)

*Figure 3. Rebuild completed after installing the required runtime library. Docker reused the previously compiled Rust layer.*

The user also verified Node.js and Supergateway were executable:

```bash
sudo docker run --rm \
  --entrypoint sh \
  pld-scryer-mcp:0.1 \
  -c 'node --version && supergateway --help'
```

![Supergateway CLI support shown in terminal](assets/04-supergateway-help.jpg)

*Figure 4. Supergateway help documents `--stateful`, `--apiKey`, session settings, and transport flags.*

## 7. Deploy as an independent Docker Compose service

### 7.1 Discover the Dify network rather than assuming its name

Ordinary Docker CLI usage without `sudo` initially returned:

```text
permission denied while trying to connect to the docker API at unix:///var/run/docker.sock
```

The command was rerun with `sudo`:

```bash
sudo docker network ls --format '{{.Name}}'
```

Relevant observed networks:

```text
pld-dify_agent_sandbox_network
pld-dify_default
pld-dify_local_sandbox_proxy_network
pld-dify_ssrf_proxy_network
```

Next, confirm the Dify API is actually attached:

```bash
sudo docker network inspect pld-dify_default \
  --format '{{range .Containers}}{{println .Name}}{{end}}'
```

**Verified:** `pld-dify-api-1` was present. Network properties:

```bash
sudo docker network inspect pld-dify_default \
  --format 'Internal={{.Internal}} Driver={{.Driver}}'
# Internal=false Driver=bridge
```

Do **not** confuse the Dify `default` network with the sandbox or SSRF-only networks. Do not publish MCP on the host merely to make Dify see it.

### 7.2 Docker Compose configuration

Create `compose.yaml` in the MCP repository root:

```yaml
services:
  scryer-prolog-mcp:
    image: pld-scryer-mcp:0.1
    container_name: pld-scryer-prolog-mcp
    restart: unless-stopped
    init: true

    environment:
      SUPERGATEWAY_API_KEY: ${MCP_API_KEY:?MCP_API_KEY is required}
      SCRYER_SESSIONS: /sessions

    read_only: true
    tmpfs:
      - /tmp:rw,nosuid,nodev,size=64m
      - /sessions:rw,nosuid,nodev,size=32m,uid=1000,gid=1000

    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 64
    mem_limit: 512m
    cpus: 1.0

    networks:
      - dify

networks:
  dify:
    external: true
    name: pld-dify_default
```

Why these options matter:

- **`restart: unless-stopped`:** Docker attempts to restart the service after an unexpected exit and across Docker daemon startup, unless an operator explicitly stopped it. The policy is configured; actual Fedora reboot behavior has not yet been validated.
- **`read_only: true`:** makes the image root filesystem read-only. It does **not** prevent reads of image-provided files or network connections.
- **`tmpfs /tmp`:** provides temporary space for dynamically created Prolog programs; data is discarded after container restart.
- **`tmpfs /sessions`:** gives the engine a writable session directory; saved sessions are **ephemeral** in this configuration.
- **`USER node`, `cap_drop`, `no-new-privileges`:** reduce privilege but do **not** fully sandbox untrusted Prolog.
- **CPU/memory/PID controls:** set initial operating resource limits; these are not a complete resource security model.
- **No `ports`:** no socket published on Fedora's university-facing interface.

### 7.3 Create a secret (do not commit it)

```bash
cd /mnt/data/personal-life-director/services/scryer-prolog-mcp
printf 'MCP_API_KEY=%s\n' "$(openssl rand -hex 32)" > .env
chmod 600 .env
grep -qxF '.env' .gitignore || echo '.env' >> .gitignore
```

The `openssl rand -hex 32` expression generates a **64-character hexadecimal value** (32 random bytes). In Dify, the header must contain the *value only*, not `MCP_API_KEY=`. Never add the secret to screenshots, README files, shell command history, logs, or a public repository.

### 7.4 Validate and launch

```bash
sudo docker compose -p pld-scryer config --quiet
sudo docker compose -p pld-scryer up -d
sudo docker compose -p pld-scryer ps
```

**Observed:** `pld-scryer-prolog-mcp`, `Up`, `8000/tcp`. `docker compose ps` was not reporting a host-published port. The project was started independently of `pld-dify`.

## 8. Validate service startup, transport, authentication, tools, and CLPZ

The following checks avoid publishing MCP externally. Tests use a disposable curl container **on the same Docker network**. All commands are run from the MCP repository root (to read `.env`).

### 8.1 Startup logs

```bash
sudo docker logs --tail 40 pld-scryer-prolog-mcp
```

The actual log reported:

```text
[supergateway] Starting...
[supergateway]   - outputTransport: streamableHttp
[supergateway] Running stateful server
[supergateway]   - port: 8000
[supergateway]   - stdio: node /app/index.mjs
[supergateway]   - streamableHttpPath: /mcp
[supergateway]   - CORS: disabled
[supergateway]   - Health endpoints: /healthz
[supergateway]   - API key: required (1 key)
[supergateway]   - Session timeout: 1800000ms
[supergateway] Listening on port 8000
```

### 8.2 Health endpoint: 200

```bash
sudo docker run --rm \
  --network pld-dify_default \
  curlimages/curl:8.12.1 \
  -i --max-time 5 \
  http://pld-scryer-prolog-mcp:8000/healthz
```

**Verified:** `HTTP/1.1 200 OK` and body `ok`. This confirms **gateway HTTP reachability**, not necessarily that every Prolog tool remains healthy.

### 8.3 Authentication negative test: 401

```bash
sudo docker run --rm \
  --network pld-dify_default \
  curlimages/curl:8.12.1 \
  -s -o /dev/null -w 'HTTP %{http_code}\n' --max-time 5 \
  http://pld-scryer-prolog-mcp:8000/mcp
```

**Verified:** `HTTP 401`.

### 8.4 MCP `initialize`: 200 with key

Use the secret through Docker's environment, without placing it into the shell history or output:

```bash
sudo docker run --rm \
  --network pld-dify_default \
  --env-file .env \
  --entrypoint sh \
  curlimages/curl:8.12.1 \
  -c 'curl -sS -i --max-time 10 \
    -X POST http://pld-scryer-prolog-mcp:8000/mcp \
    -H "X-API-Key: $MCP_API_KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '\''{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"pld-test","version":"1.0"}}}'\'''
```

**Verified:** HTTP 200 with `content-type: text/event-stream` and a session header similar to:

```text
mcp-session-id: <generated UUID>
event: message
data: {"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}},"serverInfo":{"name":"scryer-prolog-mcp","version":"0.1.0"}},"jsonrpc":"2.0","id":1}
```

![Successful authenticated MCP initialization](assets/05-mcp-auth-initialize.jpg)

*Figure 5. Unauthorized access returned 401; authenticated MCP initialization returned 200 and a session identifier.*

> **MCP session semantics.** The original proof reused a session ID emitted by an earlier initialize call. A freshly recreated container or expired session requires a new initialization. Do not hard-code the old UUID from this report into scripts. The optional automated smoke test provided with this report (`tests/mcp_smoke.py`) initializes a new session and uses the returned ID. It was authored for this report and has not been executed against the live HP; validate it in your own environment before relying on it.

### 8.5 List the five MCP tools

With an active `<SESSION_ID>` obtained from initialization:

```bash
sudo docker run --rm \
  --network pld-dify_default \
  --env-file .env \
  --entrypoint sh \
  curlimages/curl:8.12.1 \
  -c 'curl -sS --max-time 10 \
    http://pld-scryer-prolog-mcp:8000/mcp \
    -H "X-API-Key: $MCP_API_KEY" \
    -H "Mcp-Session-Id: <SESSION_ID>" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '\''{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'\'''
```

Replace `<SESSION_ID>` in the command. For a copy/paste test that handles the ID automatically, see `tests/mcp_smoke.py`.

**Verified tools:**

| Tool | Purpose | Important limitation |
|---|---|---|
| `runProgramQuery` | Supply Prolog program and query atomically | Preferred for Dify workflows |
| `loadProgram` | Validate and replace in-memory source | Per underlying stdio engine/session |
| `runPrologQuery` | Query currently loaded source | Context/session routing matters |
| `saveSession` | Save loaded Prolog source | `/sessions` is tmpfs in the field deployment |
| `loadSession` | Reload a saved source | Lost on container recreation with tmpfs |

### 8.6 Execute a real CLP(Z) query

Prolog source:

```prolog
:- use_module(library(clpz)).
```

Query: `X #= 2 + 3`; template: `X`. The field session executed MCP `tools/call` with `runProgramQuery`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "runProgramQuery",
    "arguments": {
      "program": ":- use_module(library(clpz)).",
      "query": "X #= 2 + 3",
      "template": "X"
    }
  }
}
```

**Verified tool data:**

```json
{
  "status": "success",
  "result": "success:['X'=5]-5",
  "stdout": "",
  "stderr": ""
}
```

![Verified CLPZ constraint execution](assets/06-clpz-success.jpg)

*Figure 6. `runProgramQuery` evaluated `X #= 2 + 3`, returned `status: success`, and bound `X` to `5`.*

`tools/call` returns an MCP envelope with `content` containing a text value; the JSON result above is nested in that text. Agents and Dify workflows may need to parse this nested object rather than reading an outer `text` field directly.

## 9. Connect the MCP server to Dify

### 9.1 Navigate to the integration

In the Dify user interface:

1. Open **Integrations → Tools → MCP**.
2. Select **Add MCP Server (HTTP)**.
3. Enter the **internal** endpoint URL, not `localhost` on the Mac:

   `http://pld-scryer-prolog-mcp:8000/mcp`

4. Set **Name & Icon**: `Scryer Prolog MCP`.
5. Set **Server Identifier**: `scryer-prolog-mcp` (stable identifier; avoid changing it once workflows refer to it).
6. Turn **Use Dynamic Client Registration** **off**; this gateway authenticates with a static API key, not an OAuth authorization service.
7. On **Headers**, add exactly `X-API-Key` with only the secret *value* from the MCP project's `.env` file.
8. Save/authorize, then verify the five tool names.

![Dify Add MCP Server dialog](assets/07-dify-add-mcp.jpg)

*Figure 7. The correct HTTP integration page. The MCP endpoint is the container hostname and internal port.*

**The key is not displayed in this document.** To inspect it locally on Fedora (avoid recording the output):

```bash
cd /mnt/data/personal-life-director/services/scryer-prolog-mcp
cut -d= -f2- .env
```

Never paste the entire `MCP_API_KEY=<value>` assignment into the Header Value field.

## 10. Diagnose and correct Dify's SSRF proxy restriction

### 10.1 Actual failure

The first Dify authorization attempt showed a **403 Forbidden** for the MCP endpoint and left the server marked **Unconfigured Server**.

![Dify forbidden error](assets/08-dify-403-ssrf.jpg)

*Figure 8. Dify could not discover tools because its outbound SSRF proxy rejected the private Docker target.*

On Fedora, inspect:

```bash
sudo docker logs --tail 40 pld-dify-ssrf_proxy-1
```

**Observed line:**

```text
TCP_DENIED/403 ... POST http://pld-scryer-prolog-mcp:8000/mcp ... HIER_NONE/-
```

Squid's `HTTP 403` was **not** an API key error. The HTTP request was denied **before** reaching Supergateway. Do not disable SSRF protection globally or change the MCP server to an Internet-facing port.

### 10.2 Inspect Squid's policy, include order, and mounts

```bash
sudo docker exec pld-dify-ssrf_proxy-1 cat /etc/squid/squid.conf
sudo docker exec pld-dify-ssrf_proxy-1 sh -c \
  'cat /etc/squid/dify_allow_private.conf; grep -nE "Safe_ports|SSL_ports|8000" /etc/squid/dify_common.conf'
sudo docker inspect pld-dify-ssrf_proxy-1 \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

Relevant actual policy order:

```squidconf
include /etc/squid/dify_common.conf
acl allowed_domains dstdomain .marketplace.dify.ai
http_port 3128
http_access deny !Safe_ports
http_access deny CONNECT !SSL_ports
http_access allow localhost manager
http_access deny manager
include /etc/squid/dify_sandbox_proxy.conf
include /etc/squid/dify_allow_private.conf
http_access deny to_private_networks
http_access allow allowed_domains
http_access allow client_localnet
http_access allow localhost
http_access deny all
```

Port `8000` was **already** inside the `Safe_ports` interval `1025-65535`; the blocking rule was the private-network deny. The include `dify_allow_private.conf` is deliberately placed before that deny.

Inspect the Dify entrypoint and available environment variables:

```bash
DIFY=/mnt/data/personal-life-director/dify/dify/docker
grep -nEi 'private|allow|proxy|acl|squid' \
  "$DIFY/ssrf_proxy/docker-entrypoint.sh"
grep -n 'SSRF_PROXY_ALLOW_PRIVATE' \
  "$DIFY/envs/infrastructure/ssrf-proxy.defaults"
```

The entrypoint supports:

```text
SSRF_PROXY_ALLOW_PRIVATE_IPS
SSRF_PROXY_ALLOW_PRIVATE_DOMAINS
```

It automatically generates `/etc/squid/dify_allow_private.conf`. Editing that generated file **inside the running container** would be ephemeral.

### 10.3 Modify the existing Dify Compose override, not upstream Compose

The Dify instance already had an override:

```yaml
services:
  plugin_daemon:
    ports: !override
      - "127.0.0.1:5003:5003"
```

Preserve that setting. Back up the file and add an `ssrf_proxy.environment` stanza:

```bash
cd /mnt/data/personal-life-director/dify/dify/docker
cp docker-compose.override.yaml docker-compose.override.yaml.bak
```

Final `docker-compose.override.yaml`:

```yaml
services:
  plugin_daemon:
    ports: !override
      - "127.0.0.1:5003:5003"

  ssrf_proxy:
    environment:
      SSRF_PROXY_ALLOW_PRIVATE_DOMAINS: "pld-scryer-prolog-mcp"
```

**Why the override works:** the original `ssrf_proxy` service combines an optional `ssrf-proxy.env` file with `ssrf-proxy.defaults`. The optional file was absent during this installation. Container `environment` settings have precedence over entries from `env_file`. The user's inspection of the flattened Compose configuration showed two `SSRF_PROXY_ALLOW_PRIVATE_DOMAINS` entries because multiple services have different settings; only the `ssrf_proxy` service's effective value matters.

### 10.4 Validate the exact target service value

```bash
sudo docker compose -p pld-dify config --quiet
sudo docker compose -p pld-dify config --format json | python3 -c \
  'import json,sys; c=json.load(sys.stdin); print(c["services"]["ssrf_proxy"]["environment"].get("SSRF_PROXY_ALLOW_PRIVATE_DOMAINS"))'
```

**Observed:** `pld-scryer-prolog-mcp`.

### 10.5 Recreate ONLY Squid, then inspect the generated ACL

```bash
sudo docker compose -p pld-dify up -d --no-deps --force-recreate ssrf_proxy
sudo docker exec pld-dify-ssrf_proxy-1 cat /etc/squid/dify_allow_private.conf
```

**Observed generated content:**

```squidconf
# Generated by docker-entrypoint.sh.
# Allows selected private targets before the default private-network deny rule.
acl dify_allowed_private_domains dstdomain pld-scryer-prolog-mcp
http_access allow client_localnet dify_allowed_private_domains
```

Only the SSRF proxy container was recreated. Other Dify containers, Redis, PostgreSQL, Ollama, and the MCP service were not deliberately restarted. There can be a brief interruption to **requests relying on this proxy** while it is recreated.

**Residual security caveat:** this allowlist matches a destination hostname, but is **not port-8000-only**. It allows the eligible proxy clients to contact that hostname on Squid's permitted ports. Restrict further in a controlled hardening change if required. Hostname-based allowlisting is not equivalent to secure identity verification, especially if Docker DNS or attached container identities change.

## 11. Resolve Dify authentication and OAuth fallback errors

Once the SSRF exception was active, the Dify error changed to:

```text
Failed to discover OAuth metadata from server
```

![OAuth metadata discovery failure](assets/10-dify-oauth-error.jpg)

*Figure 9. The OAuth metadata error was a consequence of a 401 response from the key-protected gateway; it was not evidence that an OAuth server was required.*

Read the logs:

```bash
sudo docker logs --since 5m pld-dify-ssrf_proxy-1 2>&1 \
  | grep -E 'pld-scryer|TCP_'
sudo docker logs --since 5m pld-dify-api-1 2>&1 \
  | grep -iE 'mcp|oauth|unauthorized|401' | tail -20
```

**Observed change:**

```text
TCP_MISS/401 ... POST http://pld-scryer-prolog-mcp:8000/mcp ... HIER_DIRECT/172.21.0.15
TCP_MISS/401 ... GET http://pld-scryer-prolog-mcp:8000/.well-known/oauth-protected-resource/mcp
ValueError: Failed to discover OAuth metadata from server
```

This is diagnostically distinct from `TCP_DENIED/403`:

| Proxy code | Interpretation | What to fix |
|---|---|---|
| `TCP_DENIED/403` | Squid refused routing to private destination | Targeted SSRF allowlist |
| `TCP_MISS/401` | Squid forwarded request; upstream returned 401 | MCP API key/header |
| `TCP_MISS/200` | Upstream accepted and returned 200 | Proceed to MCP protocol validation |

Review Dify's **Headers** tab and ensure:

```text
Header Name:  X-API-Key
Header Value: <64 hexadecimal characters, value only>
```

The actual problem was resolved after correcting the header value. In the screenshot, the masked value began with `MC...`, suggesting the whole assignment beginning `MCP_API_KEY=...` had been pasted instead of the secret value. That was a diagnostic inference from the UI; the successful outcome after correction verifies that the final Dify header was accepted, **not** the original contents of the masked field.

![Dify header editor with value masked](assets/11-dify-masked-api-key.jpg)

*Figure 10. Header Name is `X-API-Key`. The header value is masked; never include the actual API key in published documentation.*

After saving the corrected header, Dify showed:

- Green **Authorized** status.
- **5 tools included**.
- All expected names: `runProgramQuery`, `loadProgram`, `runPrologQuery`, `saveSession`, `loadSession`.

![Dify showing authorized server and five tools](assets/12-dify-authorized-five-tools.jpg)

*Figure 11. The final successful Dify MCP integration; an actual Dify workflow invocation remains a separate final test.*

## 12. Final verification matrix

| Test or capability | Result | Grounding |
|---|---|---|
| Git clone + source inspection | **PASS** | Repo structure and package.json shown |
| Rust/Cargo Scryer build | **PASS** | Docker build logs |
| Runtime OpenSSL dependency | **PASS after fix** | Missing `libssl.so.3`, then `cargo:0.10.0` |
| Node.js + Supergateway CLI | **PASS** | Help output screenshot |
| Independent Docker Compose service | **PASS** | `pld-scryer-prolog-mcp` `Up` |
| HTTP gateway startup | **PASS** | Gateway listening on 8000 |
| HTTP health endpoint | **PASS** | `GET /healthz` → HTTP 200 |
| Reject unauthenticated MCP | **PASS** | `GET /mcp` → HTTP 401 |
| Authenticated MCP initialize | **PASS** | HTTP 200, MCP serverInfo, session ID |
| MCP tool discovery | **PASS** | Five named tools returned |
| Native CLP(Z) execution via MCP | **PASS** | `X #= 2 + 3` → `X = 5` |
| SSRF exception generated by Dify | **PASS** | Squid ACL file content |
| Dify authorizes MCP and shows five tools | **PASS** | Final Dify screenshot |
| Dify workflow/agent invokes Prolog | **NOT YET TESTED** | No corresponding run output |
| Automatic recovery after MCP container restart | **NOT YET TESTED** | Policy present, no restart test recorded |
| Recovery after Fedora reboot | **NOT YET TESTED** | No post-deployment reboot test recorded |
| Persistence of `saveSession` through restart | **NOT SUPPORTED as configured** | `/sessions` is tmpfs |
| MCP network egress isolation against Dify internals | **NOT COMPLETE** | Shared `pld-dify_default` network |
| Strong untrusted-code execution sandbox | **NOT COMPLETE** | Time/resource limits and non-root are not sufficient |
| Raspberry watchdog MCP-specific check | **NOT CONFIGURED/VERIFIED** | Existing watchdog checks Dify/Ollama, not this MCP tool |

## 13. Finish the installation safely: open operational checks

These are the **next steps**, **not claimed completed**. Perform them from the Fedora host with explicit control over any maintenance-related interruption.

### 13.1 First: end-to-end execution from Dify (low risk)

In Dify Studio, use an existing **trusted test** workflow or a small new workflow with the **Scryer Prolog MCP → runProgramQuery** tool. Supply:

```text
program:  :- use_module(library(clpz)).
query:    X #= 2 + 3
template: X
```

Expected inner engine result: `status = success`, binding `X = 5`. Confirm the Dify node actually records a tool call and parses the MCP `content[].text` result correctly. Dify can list tools while still having workflow-specific configuration issues, so this check matters.

**Do not enable unrestricted LLM-authored Prolog on production data yet.** Use a fixed, reviewed test program.

For an optional independent automated smoke test, copy `tests/mcp_smoke.py` into the MCP repository's `tests/` directory, then run from its root:

```bash
sudo docker run --rm --network pld-dify_default --env-file .env \
  -v "$PWD/tests/mcp_smoke.py:/tests/mcp_smoke.py:ro" \
  python:3.12-alpine python /tests/mcp_smoke.py
```

This script is supplied as a **new, not-yet-field-run helper**. It checks HTTP health, unauthenticated rejection, MCP initialization, the five tools, and an atomic CLP(Z) call. The first run may download the Python image; it does not restart existing services.

### 13.2 Second: inspect actual security settings and restart policy (no interruption)

```bash
sudo docker inspect pld-scryer-prolog-mcp \
  --format 'Status={{.State.Status}} Restart={{.HostConfig.RestartPolicy.Name}} ReadOnly={{.HostConfig.ReadonlyRootfs}}'
sudo docker inspect pld-scryer-prolog-mcp \
  --format '{{range $name,$settings := .NetworkSettings.Networks}}{{println $name}}{{end}}'
sudo docker compose -p pld-scryer ps
```

Expected values according to the **configuration**: `Restart=unless-stopped`, `ReadOnly=true`, `pld-dify_default` in networks. **Inspect** verifies actual state.

### 13.3 Third: controlled container restart (brief MCP interruption)

> Perform while no important Dify workflow is running. Any in-memory `loadProgram` state or temporary `saveSession` files can be lost.

```bash
sudo docker restart pld-scryer-prolog-mcp
sudo docker logs --tail 30 pld-scryer-prolog-mcp
sudo docker run --rm --network pld-dify_default \
  curlimages/curl:8.12.1 \
  -sS -i --max-time 5 \
  http://pld-scryer-prolog-mcp:8000/healthz
```

Confirm health returns 200, then refresh the MCP integration in Dify and repeat a fixed Prolog test. Document the result and date. This validates app recovery after an explicit container restart, **not** after a full host reboot.

### 13.4 Fourth: host reboot validation (maintenance window only)

> **Do not casually reboot the HP from a remote-only session.** The HP also runs Dify, Ollama, the watchdog network bridge and other services. A failed network autoconnect or startup dependency may leave it inaccessible. Plan for physical or otherwise verified recovery.

At a scheduled maintenance window:

1. Record running container/service inventory and Dify health.
2. Verify that `docker.service` is enabled (`systemctl is-enabled docker`).
3. Restart Fedora using the normal shutdown/reboot procedure.
4. Reconnect through VPN/SSH and verify `pld-scryer-prolog-mcp` is `Up`.
5. Verify Dify still shows **Authorized — 5 tools** and repeat the atomic CLP(Z) tool call.
6. Record the actual test outcome; if failed, diagnose before marking as stable.

### 13.5 Fifth: add a real container healthcheck (recommended, not yet installed)

The field image has a health endpoint but **no proved Docker HEALTHCHECK**. `restart: unless-stopped` helps after the main container process exits; Docker's health status alone does **not** automatically restart an unhealthy container.

A minimal healthcheck can be added to the image, for example using Node's built-in HTTP client (no curl package required):

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r => { if(!r.ok) process.exit(1) }).catch(() => process.exit(1))"
```

But this checks **only the gateway HTTP endpoint**. A stronger external supervisor should periodically perform an authenticated MCP `initialize`, `tools/list`, and a harmless `runProgramQuery` call. Build, verify, and deploy any healthcheck change under change control; do not treat the illustrative snippet as already applied.

### 13.6 Sixth: controlled logging and monitoring

Check current disk usage:

```bash
sudo docker system df
sudo docker inspect pld-scryer-prolog-mcp --format '{{.HostConfig.LogConfig.Type}}'
```

Consider a logging policy such as the following in `compose.yaml`, **after** inspecting existing Docker daemon logging defaults and any central log collectors:

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"
    max-file: "3"
```

Changes to container settings require recreation, not just `docker compose restart`. Avoid putting API keys, full user programs or private schedules in the logs.

### 13.7 Seventh: watchdog integration

The Raspberry Pi 1 already monitors host SSH, Dify, Ollama and Docker. A PLD MCP-specific check should be added later using a restricted server-side health endpoint or a dedicated monitored script. The current `/healthz` check is not enough to prove native Prolog functionality. Never let a watchdog repeatedly reboot the HP because a single MCP tool fails. Use rate-limited alerts, staged service-only recovery and manual escalation before host resets.

## 14. Hardening roadmap and threat model

### 14.1 Threat: Prolog tool is arbitrary code execution

`runProgramQuery` accepts user-supplied Prolog program text and evaluates it in a native process. This is powerful for Timely, scheduling, search and CLP(Z), but a model hallucination or a malicious user can cause excessive resource use, filesystem access where permitted, or network operations (subject to runtime libraries and OS policy).

Current mitigations: non-root container user, read-only image, `cap_drop: ALL`, `no-new-privileges`, CPU/memory/PID limits, 15-second engine timeout, output cap, temporary program directories and an authenticated gateway. **These do not amount to a complete isolation guarantee.**

### 14.2 Network isolation is currently the largest open concern

The MCP container shares `pld-dify_default` with Dify's API and several internal services. An authenticated Prolog request can create a process within this network-attached container. Even if the filesystem is read-only, network connectivity to private services may exist. The SSRF proxy's *inbound* allowance does not prevent *outbound* networking from the MCP container.

**Recommended production redesign:** place the MCP HTTP gateway in a narrowly scoped ingress network and execute Prolog in a **separate process/container/VM isolated from Dify internals**, without general network egress. Define a minimal data-exchange protocol for source/query/result; allow only required transport connections. Evaluate rootless runtimes, seccomp/AppArmor/SELinux, network policies and per-job ephemeral workers. A basic `network_mode: none` cannot be applied to the current single combined container without disconnecting Dify from Supergateway; separating the gateway and executor is necessary.

### 14.3 Secrets and authentication

- `.env` is gitignored and mode `0600`; review file permissions on the repository and backups.
- Dify's stored static header is a **workspace-level credential**, not an automatically scoped per-user identity.
- Restrict who can modify Dify workflows or MCP integrations.
- Rotate keys after any suspected disclosure. Verify the new key is active before removing the old one; the gateway supports multiple keys via supported settings.
- Avoid public host port publishing. If remote exposure is ever needed, use HTTPS, policy-controlled access and authentication; internal Docker HTTP is not encrypted.

### 14.4 Reproducible and auditable builds

- The build pins the Cargo release and npm Supergateway version, but base image tags can move.
- Pin `rust` and `node` stages to known image digests after reviewing updates and vulnerability advisories.
- Record source revision: `git rev-parse HEAD`.
- Record image identifier: `sudo docker image inspect pld-scryer-mcp:0.1 --format '{{.Id}}'`.
- Rebuild deliberately after security updates. Re-run native Scryer and end-to-end MCP tests.
- Consider pinning Supergateway through a dependency manifest/lockfile or internal image registry rather than relying only on a global npm install.
- Do not automatically git-pull/rebuild a tool that accepts executable code while agent workflows are running.

### 14.5 Session persistence policy

`saveSession` and `loadSession` operate on `/sessions`. The current tmpfs clears saved sessions after recreation or reboot. That is reasonable for ephemeral tests and reduces persistent sensitive data. If long-lived user sessions are a requirement, use an explicitly permission-controlled volume **and** introduce workspace/user isolation; a single shared directory used by multiple clients is not a secure multi-tenant store. Also distinguish source-file persistence from `Engine.program` in-memory state.

## 15. Operations, diagnostics, updates, rollback, and backup

### 15.1 Operational commands

Run from `/mnt/data/personal-life-director/services/scryer-prolog-mcp`:

```bash
# Status and logs
sudo docker compose -p pld-scryer ps
sudo docker logs --tail 100 pld-scryer-prolog-mcp
sudo docker logs -f pld-scryer-prolog-mcp

# Local config validation
sudo docker compose -p pld-scryer config --quiet

# Stop/start MCP only (affects MCP users; does NOT stop Dify)
sudo docker compose -p pld-scryer stop
sudo docker compose -p pld-scryer up -d

# Recreate MCP after deliberate configuration changes
sudo docker compose -p pld-scryer up -d --no-deps --force-recreate
```

The Dify proxy exception is in the *separate* Dify Compose project; do **not** run `docker compose up` for all Dify services to update just the MCP.

### 15.2 Changing Compose variables or image

```bash
# Validate and then recreate only the necessary service.
sudo docker compose -p pld-scryer config --quiet
sudo docker compose -p pld-scryer up -d --no-deps --force-recreate
```

`docker compose restart` alone does **not** apply newly edited environment variables or other container configuration changes. Use deliberate recreate after confirming the configuration.

### 15.3 Upgrade procedure

1. Back up your `Dockerfile`, `compose.yaml`, relevant Dify override, version notes, and securely managed secrets.
2. `git fetch` and inspect changes; record old commit SHA.
3. Review security advisories for Scryer, Node, MCP SDK, Supergateway and Docker base images.
4. Build **a new tag**, e.g. `pld-scryer-mcp:0.2` (avoid overwriting a known-good release when possible).
5. Run native binary and MCP tests against the candidate.
6. Update the Compose image reference to the new tag, validate and recreate only the MCP container.
7. Verify authorized Dify tool discovery and workflow execution.
8. Roll back to the previous tag if checks fail.

### 15.4 Rollback of Dify proxy allowlist

The original override was backed up as `docker-compose.override.yaml.bak` in the Dify Docker directory. To remove MCP-specific private access later, edit **only** the `ssrf_proxy.environment` addition, validate, and recreate **only** `ssrf_proxy`. Confirm the generated ACL no longer contains the MCP hostname. Keep the existing `plugin_daemon` override.

### 15.5 Backups and data classification

- **Source:** tracked by Git; save the commit ID and image build manifest.
- **Secret:** `.env` contains a credential; keep in secure storage, not public Git or screenshots. If any system backup includes `.env`, treat that backup as sensitive.
- **Prolog sessions:** currently tmpfs and intentionally not durable.
- **Dify integration:** stored in Dify's database; back up Dify separately, with appropriate secret handling.
- **Screenshots:** review for metadata, addresses and masked secrets before making public.

## 16. Mac examples and Timely workflow recovery

The repository clone includes earlier experimental artifacts from the Mac. This is **source-code/workflow recovery**, not evidence that they have been executed successfully on the new Fedora Dify instance.

Discover them:

```bash
cd /mnt/data/personal-life-director/services/scryer-prolog-mcp
find examples -type f | sort
```

Relevant verified files:

```text
examples/dify/timetable-example/README.md
examples/dify/timetable-example/fixtures/requirements.pl
examples/dify/timetable-example/fixtures/simsttab.pl
examples/dify/timetable-example/fixtures/expected-extraction.json
examples/dify/timetable-example/fixtures/extraction_to_requirements.py
examples/dify/timetable-example/workflows/Timetable Image to Prolog.yml
examples/dify/timetable-example/workflows/Generate Timetable from Requirements.yml
examples/dify/timetable-example/images/*.png
examples/dify/screenshots/*.png
```

To copy workflow YAML files to a Mac over the university VPN, from a **Mac** terminal:

```bash
mkdir -p ~/Downloads/PLD-Timely-Workflows
scp 'jose@172.16.172.184:/mnt/data/personal-life-director/services/scryer-prolog-mcp/examples/dify/timetable-example/workflows/*.yml' \
  ~/Downloads/PLD-Timely-Workflows/
```

Then use **Dify Studio → Import DSL**. Rebind any imported MCP tool references to the now-authorized `scryer-prolog-mcp` server. The image-to-Prolog workflow requires a compatible **vision model** in Dify/Ollama; this is outside the MCP deployment itself. Prefer `runProgramQuery` for independent workflow runs; shared in-memory sessions may otherwise produce surprising results.

## 17. Troubleshooting reference

| Symptom | Diagnosis | Reproduction / resolution |
|---|---|---|
| `node: command not found` on Fedora | Node was not installed on host | Expected; use the containerized runtime |
| Interactive package install fails to authenticate | PackageKit authorization issue | Do not rely on host Node; Docker approach succeeded |
| `permission denied ... docker.sock` | User lacks Docker socket access | Use `sudo docker`; don't grant blanket Docker privilege unnecessarily |
| Docker build succeeds but Scryer won't start | Runtime dynamic library missing | Add `libssl3`, rebuild, verify `cargo:0.10.0` |
| `curl /healthz` fails | Gateway not listening, container/DNS/network issue | `sudo docker logs`, inspect network; check container Up |
| `401` from `/mcp` without key | Expected authentication | Add valid `X-API-Key` value |
| `TCP_DENIED/403` in Squid logs | Private-network SSRF block | Add **specific** domain allowlist to Dify proxy environment |
| `TCP_MISS/401` in Squid logs | Request forwarded; upstream rejected | Check `X-API-Key`, avoid passing `MCP_API_KEY=` prefix |
| `Failed to discover OAuth metadata` | Dify fallback after 401 | Correct static header; do not invent OAuth metadata |
| MCP `initialize` succeeds but tool call fails | MCP session, permissions or native engine | Use fresh session ID; check `docker logs` and `tools/list` |
| `loadProgram` followed by query sees old state | Different MCP sessions/stdio engines | Prefer `runProgramQuery` atomic call |
| Saved Prolog session disappears after restart | `/sessions` is tmpfs | Expected; use an intentionally durable isolated volume if required |
| Dify cannot resolve MCP hostname | Wrong Docker network or name | Inspect `pld-dify_default`, container names and DNS |
| Container Up but Prolog nonfunctional | Gateway health doesn't test native engine | Perform an authenticated `runProgramQuery` smoke test |
| Dify MCP works, Timely YAML fails | Stale tool/provider references or missing vision model | Rebind tools/models and inspect workflow node payloads |
| Changes to Compose do not take effect | Only `docker compose restart` was used | Recreate affected service after config validation |

## 18. Reference files, sources, and provenance

### 18.1 Files bundled with this report

The archive accompanying this Markdown includes:

```text
docs/
  SCRYER_PROLOG_MCP_FEDORA_DIFY_DEPLOYMENT.md
  assets/
    01-docker-build-success.jpg
    02-libssl-missing.jpg
    03-docker-build-with-libssl.jpg
    04-supergateway-help.jpg
    05-mcp-auth-initialize.jpg
    06-clpz-success.jpg
    07-dify-add-mcp.jpg
    08-dify-403-ssrf.jpg
    09-dify-edit-settings.jpg
    10-dify-oauth-error.jpg
    11-dify-masked-api-key.jpg
    12-dify-authorized-five-tools.jpg
deployment/
  Dockerfile
  compose.yaml
  docker-compose.dify.override.example.yaml
tests/
  mcp_smoke.py
```

### 18.2 Canonical upstream references

- **MCP implementation and examples:** https://github.com/jcarpio/scryer-prolog-mcp
- **Scryer Prolog:** https://github.com/mthom/scryer-prolog
- **Supergateway options and authentication:** https://github.com/supercorp-ai/supergateway
- **Docker Compose service definitions and restart policies:** https://docs.docker.com/reference/compose-file/services/
- **Docker Compose `restart` versus recreation:** https://docs.docker.com/reference/cli/docker/compose/restart/
- **Dify project:** https://github.com/langgenius/dify

These external sources provide general upstream behavior. **Field-specific statements in this document come from the Fedora terminal outputs and Dify screenshots gathered during the deployment.**

### 18.3 Final statement

As of the recorded session, **Scryer Prolog MCP was operational on the Fedora host, authenticated via Supergateway, allowed through the Dify SSRF proxy for its specific hostname, and displayed as Authorized with five tools in Dify.** The server successfully executed a CLP(Z) query through MCP. The separate tasks of Dify workflow invocation, host reboot validation, long-term monitoring, and untrusted-code isolation remain open and should be completed before describing the service as production-hardened.
