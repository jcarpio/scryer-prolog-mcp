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

## References

- Original MCP project: https://github.com/adamrybinski/prolog-mcp
- Scryer Prolog documentation and downloads: https://www.scryer.pl/
- Scryer Prolog source: https://github.com/mthom/scryer-prolog
