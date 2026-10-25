# @margoengine/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for Margo Engine. It lets AI coding tools (Claude
Code, Claude Desktop, Cursor, Copilot, any MCP client) read Margo correctly and check the code they write for it.
It runs on your machine over stdio, has no dependencies, and is separate from core (core grows by zero bytes).

```sh
npm i -D @margoengine/mcp typescript
```

The server serves a snapshot of the READMEs, API reports, docs and example list from the version you installed, so
the answers match your code, not the latest page on the web. The same material is at
[margoengine.com/llms.txt](https://margoengine.com/llms.txt) and
[llms-full.txt](https://margoengine.com/llms-full.txt) for tools that read a URL instead.

## Tools

| Tool | What it does |
| --- | --- |
| `search_docs` | Ranked full-text search over READMEs, API declarations, docs and examples. Takes a task ("orbit camera") or an exact name (`createStage`). Filters: `kind`, `package`, `limit`. |
| `list_packages` | Every package with its layer and a one-line description. Core is frozen; features live in optional packages, so this is how a model finds the right one. |
| `get_package` | One package's README, its API report (every export with its declaration, per entry point) or both. Accepts `sciviz`, `@margoengine/sciviz` or `margoengine/sciviz`. |
| `list_examples` | The runnable example pages and starter projects, with what each shows. |
| `check_snippet` | Type-checks TypeScript, TSX or JavaScript against the real package types in your project, strict, with your own `typescript`. The snippet is compiled, never run. Returns line, column, code and message for each problem. |

Rendering a scene to a PNG is not a tool. The repository's browser harness needs Playwright, a Vite dev server and a
real GPU behind the shared GPU lock, none of which a published package can bring along, and a scene needs a bundler
step before any browser can load it. Use the visual checks in the repository (`npm run visual:check`) for pictures.

## Set up

Every client starts the same command. `--root` names the project whose `node_modules` has `typescript` and the
`@margoengine` packages; `check_snippet` type-checks against those. It defaults to the folder the client starts the
server in.

### Claude Code

```sh
claude mcp add margoengine -- npx -y @margoengine/mcp
```

Or share it with the team in `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "margoengine": { "command": "npx", "args": ["-y", "@margoengine/mcp"] }
  }
}
```

### Claude Desktop

Open Settings, Developer, Edit Config, and add the server to `claude_desktop_config.json`. Claude Desktop does not
start servers in your project, so name it with `--root`:

```json
{
  "mcpServers": {
    "margoengine": {
      "command": "npx",
      "args": ["-y", "@margoengine/mcp", "--root", "/path/to/your/project"]
    }
  }
}
```

On Windows, write the path with forward slashes or doubled backslashes. Restart Claude Desktop.

### Cursor

Add the same block to `.cursor/mcp.json` in the project (or `~/.cursor/mcp.json` for every project), then enable
`margoengine` under Settings, MCP:

```json
{
  "mcpServers": {
    "margoengine": { "command": "npx", "args": ["-y", "@margoengine/mcp"] }
  }
}
```

### Copilot and other clients

Any client that starts a stdio server works: command `npx`, arguments `-y @margoengine/mcp`. In VS Code, put the
block in `.vscode/mcp.json` under the key `servers` instead of `mcpServers`.

## Use it from code

The server is a plain function from messages to responses, so you can embed it or test against it.

```ts
import { createMargoServer, serveStdio } from '@margoengine/mcp';

const server = await createMargoServer({ projectRoot: '.' });
await serveStdio(server); // reads JSON-RPC lines from stdin, writes responses to stdout
```

```ts
import { createMcpServer, createTools, loadCorpus } from '@margoengine/mcp';

const server = createMcpServer({ tools: createTools({ corpus: await loadCorpus() }) });
const answer = await server.handle({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'search_docs', arguments: { query: 'orbit camera', limit: 3 } },
});
console.log(answer);
server.dispose();
```

Options and defaults:

| Option | Default | |
| --- | --- | --- |
| `createMargoServer({ corpus })` | the corpus the package ships | Documentation to serve. |
| `createMargoServer({ projectRoot })` | the current directory | Where `check_snippet` finds `typescript` and the Margo packages. |
| `serveStdio(server, { input, output, signal })` | `process.stdin`, `process.stdout`, none | Streams to use; abort the signal to stop. |
| `checkSnippet(code, { language, strict, timeoutMs, signal })` | `ts`, `true`, 60000, none | The type check on its own. |

## Errors

A failed tool call is a normal result with `isError: true`, a `structuredContent.error` with a `code`
(`argument`, `range`, `unsupported`, `failed`, `disposed`) and a message that ends with a link to the
[error help](https://margoengine.com/errors#mcp). Protocol faults are JSON-RPC errors (`-32700` to `-32603`).

## Protocol

Implemented from the published specification: JSON-RPC 2.0, one message per line over stdio, `initialize` (versions
2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05), `ping`, `tools/list`, `tools/call` and
`notifications/cancelled`. Requests run side by side. Nothing but protocol messages goes to stdout.
