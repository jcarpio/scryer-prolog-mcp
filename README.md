# Scryer Prolog MCP

A general-purpose Model Context Protocol (MCP) server for running native
[Scryer Prolog](https://www.scryer.pl/) programs from compatible AI assistants.
Use Prolog for symbolic reasoning, knowledge-base queries, constraint solving,
planning, scheduling, and educational exercises.

This local prototype adapts the four-tool interface of
[Adam Rybinski's prolog-mcp](https://github.com/adamrybinski/prolog-mcp).
The implementation is rewritten to replace the Trealla/WebAssembly backend with
native Scryer processes. It is not an upstream release.

## Requirements

- Node.js 20 or later and npm.
- Scryer Prolog installed locally. Tested with Scryer 0.10.0.
- An MCP client supporting the stdio transport.

Scryer includes CLP(Z) for integer constraints and CLP(B) for Boolean constraints.
Individual programs must explicitly import the libraries they need.

## Installation

Download Scryer from https://www.scryer.pl/ and select the binary for your operating
system and architecture. Put it on PATH or set SCRYER_PROLOG to its absolute path.
Extract this project into your home directory, then run:

```bash
cd ~/scryer-prolog-mcp
npm install
scryer-prolog --version
npm test
```

If Scryer is outside PATH:

```bash
export SCRYER_PROLOG="/absolute/path/to/scryer-prolog"
npm test
```

No TypeScript compilation is required. `npm start` starts the stdio MCP server;
it waits for MCP messages rather than opening a website or conversational terminal.
An MCP client normally starts the server automatically.

## Client configuration

Merge this entry into your MCP client's existing configuration. Replace all paths
with actual absolute paths. The outer configuration format and file location depend
on your client.

```json
{
  "mcpServers": {
    "scryer-prolog": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/scryer-prolog-mcp/index.mjs"],
      "env": {
        "SCRYER_PROLOG": "/absolute/path/to/scryer-prolog"
      }
    }
  }
}
```

Use `command -v node` and `command -v scryer-prolog` to find executable paths.
Do not start a second server manually when the client already manages it.

## Tools

| Tool | Arguments | Behavior |
| --- | --- | --- |
| `loadProgram` | `program` | Validate and replace the current Prolog source. |
| `runPrologQuery` | `query`, optional `template` | Execute a query in a fresh Scryer process and return its first solution. |
| `saveSession` | `filename` | Save the current source under a simple session name. |
| `loadSession` | `filename` | Validate and replace the current source with a saved program. |

Tool results are JSON objects carried in MCP text content. Query bindings are
represented as Prolog text, rather than the JSON substitutions returned by the
original Trealla implementation. The optional template adds an explicit term to
the result; named query variables are included automatically.

## Example: integer constraints

Call `loadProgram` with this source:

```prolog
:- use_module(library(clpz)).

ascending_pair(X, Y) :-
    [X,Y] ins 1..3,
    X #< Y,
    labeling([], [X,Y]).
```

Then call `runPrologQuery` with:

```json
{"query":"findall([X,Y], ascending_pair(X,Y), Pairs)."}
```

The result includes:

```prolog
Pairs = [[1,2], [1,3], [2,3]]
```

The server returns only the first solution of the outer query. Use `findall/3`
when you want to collect multiple ground solutions. Large or unbounded collections
may reach the time or output limit.

## Example: knowledge-base queries

Replace the current program using `loadProgram`:

```prolog
parent(alex, blair).
parent(blair, casey).

grandparent(X, Z) :-
    parent(X, Y),
    parent(Y, Z).
```

Query `grandparent(alex, Who).` to obtain `Who = casey`.

## State and execution model

The server stores source code between tool calls. Each query starts a new native
Scryer process and reloads that source. Changes made by `assertz/1` or `retract/1`
inside a query, and residual constraints, do not persist to later calls.
`saveSession` saves source code, not the runtime heap.

Each server process has one active program. Run separate server processes for
independent projects; this prototype is not a multiuser service.

Sessions are stored in `~/.scryer-prolog-mcp-sessions` by default. Override the
location with SCRYER_SESSIONS. Session names allow letters, digits, `_`, and `-`.
Existing session files with the same name are overwritten.

Previous prototype sessions are not migrated automatically. Set SCRYER_SESSIONS to
an existing session directory if you want to reuse saved source files.

## Results and limits

- `success`: the query produced a solution.
- `failure`: the query finitely failed.
- `error`: parsing, execution, or process failure.
- `timeout`: the process exceeded the time budget; this does not prove unsatisfiability.
- `output_limit`: captured output exceeded the output budget.

The default execution timeout is 15 seconds. Captured output is limited to 1 MiB.
These limits are not a complete CPU, memory, or process isolation mechanism.

## Security and deployment

Run only trusted local Prolog code. Programs and directives can access files and
perform system effects. This server is not a security sandbox. Before accepting
untrusted programs or remote users, add operating-system isolation, resource limits,
access controls, and project separation.

The SDK dependency is pinned to 1.0.1 to preserve the original project's tested
interface. Dependencies have not been security-audited here. Update and validate
them before deployment.

## Tests

```bash
npm test
```

The suite exercises CLP(Z), labeling, variable bindings, finite failure, exceptions,
missing predicates, saving/restoring source, session-name validation, timeouts, and
a real stdio MCP client/server exchange (initialize, listTools, and callTool).

Verified with Scryer 0.10.0 and Node.js 24 on Linux. macOS execution and larger
application-specific solvers still require validation.

## Project layout

| File | Purpose |
| --- | --- |
| `index.mjs` | MCP tool registration and stdio transport. |
| `engine.mjs` | Native process execution and source/session management. |
| `smoke.mjs` | Scryer backend integration tests. |
| `mcp-test.mjs` | MCP client/server integration test. |

# README update: atomic program-and-query execution

Repository: `scryer-prolog-mcp`. This document provides ready-to-paste README sections for the new `runProgramQuery` capability. The request also referred to `scryer-prolog-cmd`; this guide uses the repository name and implementation demonstrated in the session, `scryer-prolog-mcp`. If `scryer-prolog-cmd` is a separate repository, review its API before applying these sections there.

This is an additive README update, not a full replacement of an unseen current README. Retain existing installation, licensing and other tool documentation. Update any references to “four tools” to “five tools”, and add the following sections to the tool/API and examples portions of the README.

---

## Run a program and query in one request

`runProgramQuery` executes supplied Prolog source and a query together in one fresh native Scryer process. It is useful for workflow systems and clients that do not preserve the same MCP backend state across separate calls.

For example, a scheduling workflow can submit the Simsttab solver, reviewed teaching requirements and its solving goal as one tool invocation. No previous `loadProgram` call is required.

### Why this tool was added

The original interface uses `loadProgram` to validate and store source in an Engine instance, followed by `runPrologQuery` to execute against that stored source. This works when both calls reach the same Engine.

During a Dify integration through Supergateway, loading `dify_test(ready).` returned success, but a later query for `dify_test(X)` returned:

```prolog
error(existence_error(procedure,dify_test/1),dify_test/1)
```

The evidence points to source state not being shared across those calls; the exact transport/session lifecycle was not established. Increasing a gateway session timeout does not establish application-level source continuity. The new tool removes the dependency by carrying source and goal in the same request.

### Tool inventory

| Tool | Purpose | Source-state effect |
| --- | --- | --- |
| `loadProgram` | Validate and replace stored source | Replaces source in the current Engine on success |
| `runPrologQuery` | Query stored source in a fresh Scryer process | Does not retain query mutations |
| `runProgramQuery` | Execute supplied source and query together | Does not replace stored source |
| `saveSession` | Save stored source under a validated name | Writes source to the session directory |
| `loadSession` | Load and validate saved source | Replaces current stored source on success |

Session saving concerns source text, not a snapshot of the running Prolog database. Runtime mutations from one query are not carried into later queries.

### Input contract

```json
{
  "program": "dify_test(ready).",
  "query": "dify_test(X).",
  "template": "X"
}
```

| Parameter | Required | Meaning |
| --- | --- | --- |
| `program` | Yes | Complete trusted Prolog source, including required library imports |
| `query` | Yes | One Prolog goal, optionally ending with a period |
| `template` | No | Prolog term returned alongside bindings; defaults to `true` |

Current input validation checks strings and rejects program strings longer than 1,000,000 JavaScript string units and queries longer than 100,000. Although the error text says “maximum 1 MB”, the source limit is a string-length check, not an exact UTF-8 byte count. The optional template is type-checked; no separate template-length limit is implemented in the shown handler.

Do not put program clauses into `query`. Include facts/rules in `program` and use `query` for the goal to solve.

### MCP client example

Using an already connected MCP SDK client:

```javascript
const response = await client.callTool({
  name: 'runProgramQuery',
  arguments: {
    program: 'dify_test(ready).',
    query: 'dify_test(X).',
    template: 'X'
  }
});

if (response.isError) {
  throw new Error(response.content[0].text);
}
const result = JSON.parse(response.content[0].text);
console.log(result);
```

Expected successful engine payload:

```json
{
  "status": "success",
  "result": "success:['X'=ready]-ready",
  "stdout": "",
  "stderr": ""
}
```

The MCP handler serializes the payload as JSON in a text content block. Clients may adapt it differently. In the tested Dify integration it became an element of `json`, while `text` was empty. Inspect the embedded status rather than relying solely on a workflow node’s green execution indicator.

### CLP(Z) example

```json
{
  "program": ":- use_module(library(clpz)).",
  "query": "X in 1..3, X #> 1, labeling([], [X])",
  "template": "X"
}
```

The first solution returns `X=2`, represented in the observed engine format as `success:['X'=2]-2`. Only the first solution is returned. To collect multiple solutions explicitly, use a bounded `findall/3` goal and return its list as the template. Resource limits still apply.

### Scheduling example

Read the solver and requirements in trusted server-side code:

```javascript
import {readFile} from 'node:fs/promises';

const solver = await readFile('examples/dify/timetable/fixtures/simsttab.pl', 'utf8');
const requirements = await readFile(
  'examples/dify/timetable/fixtures/requirements.pl', 'utf8'
);
const response = await client.callTool({
  name: 'runProgramQuery',
  arguments: {
    program: `${solver}\n${requirements}\n`,
    query: 'requirements_variables(Rs, Vs), labeling([ff], Vs), print_classes(Rs).',
    template: 'true'
  }
});
```

`stdout` contains the printed timetable. `result` still includes named query-variable bindings, even with template `true`. A public web application should receive validated structured requirements and serialize them itself rather than accept arbitrary Prolog from the browser.

## How execution works

The added handler validates arguments and calls:

```javascript
result = await engine.run(a.program, a.query, a.template);
```

It reuses the existing Engine execution path:

1. Create a unique temporary directory and a unique result marker.
2. Write the supplied source plus an execution wrapper to `program.pl`.
3. Start a fresh `scryer-prolog` process with that source.
4. Parse the goal and template after loading source, so source-declared operators are available.
5. Call the goal, return the first solution, and write a marker containing bindings and template.
6. Collect output, classify the outcome, and remove temporary files in a `finally` block.

No assignment to `engine.program` occurs in this path. Concurrent calls therefore do not share a mutable loaded source through this tool. This is source-state isolation, not operating-system isolation: source can still access external files and other resources with the server’s privileges.

## Outcomes and limits

| Status | Meaning |
| --- | --- |
| `success` | The goal produced its first solution |
| `failure` | The goal had no solution |
| `error` | Parsing/loading/execution failed or no valid result marker was found |
| `timeout` | The process exceeded its time limit |
| `output_limit` | Combined captured output exceeded its limit |

The default Engine timeout is 15,000 ms. Combined stdout/stderr is capped at 1 MiB; the process is killed when the cap is exceeded. The temporary directory is removed after execution. Native process errors and validation errors may instead be returned as MCP error text rather than the normal engine JSON object; clients should handle both forms.

A zero process exit code alone does not prove success. Scryer may print a syntax error and fail to define the wrapper predicate, yielding an error payload even when the process exits with code 0.

This service executes trusted local code only. Source directives and queries are executable code. Timeouts and output limits are not a sandbox, and the tool must not be exposed directly as unrestricted code execution to public web users.

## Dify setup and tool refresh

`npm start` uses MCP stdio, not HTTP. Dify can connect through a bridge such as the Supergateway setup documented in the timetable example. Restart that bridge after modifying server code, then refresh the provider’s tool list in Dify. Updating the UI alone does not restart an old child process.

For workflows, prefer:

**Input → compose complete program → runProgramQuery → inspect JSON outcome**

This removes the need to rely on `loadProgram` followed by `runPrologQuery` sharing the same backend source state.

## Tests

Run:

```bash
node --check index.mjs
npm test
```

The updated MCP test should verify the five expected tool names, existing CLP(Z) execution, a `runProgramQuery` request that returns `ready`, and that a later `runPrologQuery` still sees the source previously loaded into the Engine. Existing engine tests cover bindings, failure, exceptions, sessions, path validation and timeout.

Observed passing output:

```text
PASS: CLP(Z), bindings, failure, exceptions, sessions, path validation, timeout
PASS: MCP tools, CLP(Z), program+query, stored program isolation
```

When testing exact output, account for quoted variable-name atoms: the actual output is `success:['X'=2]-2`, not `success:[X=2]-2`.

## New example

See [Image to requirements to timetable](examples/dify/timetable/README.md) for the complete two-workflow walkthrough, screenshots, exported DSL, reference data and Simsttab attribution. Adjust this relative link if the README section is placed somewhere other than the repository root.


## References

- Original MCP project: https://github.com/adamrybinski/prolog-mcp
- Scryer Prolog documentation and downloads: https://www.scryer.pl/
- Scryer Prolog source: https://github.com/mthom/scryer-prolog
