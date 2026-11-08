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
| `port_to_margo` | Maps a class, function or task of another 3D library (`OrbitControls`, `InstancedMesh`, `EffectComposer`, "shadow map") to the Margo package and calls that do the same job: status (COVERED, PARTIAL, MISSING, NOT PLANNED), limits, and that library's code next to the Margo code where the porting guide has a section. From `@margoengine/mcp/porting`. |
| `explain_error` | Explains a Margo error and its fix from the [error help page](https://margoengine.com/errors). Takes the whole message (each ends with `; see https://margoengine.com/errors#<id>`), that link, the id or the `MargoError` code. From `@margoengine/mcp/error-codes`. |
| `render_snippet` | Only with `--render`. Runs a snippet in Node on your GPU (through `@margoengine/headless` and the `webgpu` binding) and returns the picture as PNG image content. From `@margoengine/mcp/render`. |

## Render a snippet

`render_snippet` lets a model see what its code draws. It runs the snippet in a child Node process on the machine's
GPU, with no page: a headless stage from `@margoengine/headless/stage` on the project's own `webgpu` binding. The
snippet is a module whose default export takes that stage; the tool answers with the PNG as image content and the
snippet's console output.

```sh
npm i -D @margoengine/headless @margoengine/stage webgpu
claude mcp add margoengine -- npx -y @margoengine/mcp --render
```

The tool runs code with your rights, like `node` would, so the server offers it only when started with `--render`.
The snippet's imports resolve from the project (`--root`, or the folder the client starts the server in, or the
nearest folder above it with those packages), so stage feature entries such as `@margoengine/stage/sky` work. The run
folder lives in `node_modules/.cache/margoengine-mcp` and is removed after each run. The same call from code:

```ts
import { writeFile } from 'node:fs/promises';
import { renderSnippet } from '@margoengine/mcp/render';

const snippet = `export default (stage) => {
  stage.box({ color: '#84d6bd' });
  stage.fit(); // nothing is in view until the camera is placed
};`;
const result = await renderSnippet(snippet, { width: 320, height: 200, language: 'js' });
await writeFile('snippet.png', result.png);
console.log(result.drawnPixels, 'pixels drawn in', result.ms, 'ms');
```

| Option | Default | |
| --- | --- | --- |
| `projectRoot` | the current directory | Where the snippet's imports resolve: this folder or the nearest one above it whose `node_modules` has `@margoengine/headless`, `@margoengine/stage` and `webgpu`. |
| `width`, `height` | 512, 512 | Image size, 16 to 2048. |
| `language` | `ts` | `ts` has its types stripped (Node 22.13 or newer), not checked: run `check_snippet` first. `js` runs as written. |
| `timeoutMs` | 60000 | 1000 to 300000; the process is killed after it. |
| `gpuFlags` | none | Flags for the binding's `create`, for example `['adapter=Microsoft Basic Render Driver']`; `createMargoServer({ render: { gpuFlags } })` for the tool. |
| `signal` | none | Abort to kill the run. |

`result` holds `png`, `width`, `height`, `drawnPixels` (pixels whose colour differs from the top-left one; 0
means nothing in view, and the tool says so), `output` (the console, last 4,000 characters) and `ms`. A snippet that
throws, has no default export function or causes a WebGPU validation error fails with `failed` and the error text; a
project without the packages fails with `unsupported`.

## Porting guide

`port_to_margo` reads the parity matrix and the "Coming from" guide in the repository's `docs/` (one row per
feature of the other library, 195 rows today), copied into the package at build time, so a model converting code
gets the Margo package, the calls, the status and the worked code in one answer. The library the guide compares
comes from the docs: a docs page with a `## Matrix` table whose columns are `<library> | Status | Margo | Shows it |
Notes` is a guide, and the page titled `Coming from <library>` gives its code sections. The lookup is also an entry
of its own, `@margoengine/mcp/porting`:

```ts
import { formatPorting, loadPortingGuides, lookupPorting } from '@margoengine/mcp/porting';

const [guide] = await loadPortingGuides(); // the guides the package ships
const matches = lookupPorting(guide, 'OrbitControls', 2); // a class name, NS.ClassName or a task such as "shadow map"
for (const { row, section } of matches) console.log(row.status, row.from, '->', row.margo, section?.title ?? '');
console.log(formatPorting(guide, 'OrbitControls', matches)); // the text the tool returns
```

| Function | Default | |
| --- | --- | --- |
| `loadPortingGuides(file?, signal?)` | the guides the package ships (`dist/porting.json`) | Reads the guides; a missing file is a `failed` error. |
| `lookupPorting(guide, query, limit?)` | 5 rows (1 to 25) | Best rows first; a name in the row counts more than a word in its notes, the exact name most. |
| `parsePortingGuide(matrix, guide?, sources?)` | no guide sections, no paths | Parses one matrix page and its guide page. |
| `portingGuidesFromCorpus(corpus)` | | Every guide in a docs corpus. |
| `createPortingTool(guides)` | | The `port_to_margo` tool; the first guide is the default `from`. |
| `createMargoServer({ porting })` | the guides the package ships | Guides the server's tool answers from. |

Matching is by words and name parts, not meaning: ask with the other library's class name or a short task. A name
the matrix does not list gets no row, and the answer says so and points at `search_docs`.

## Error lookup

Every Margo error message ends with a link to its entry on the error help page, and every entry says what causes the
error and how to fix it. `explain_error` answers from a copy of that page made at package build, so a model can fix
a pasted error without a browser. It finds the entry by the `errors#<id>` link, by the id or `MargoError` code
(`disposed`, `unsupported`), by a message the page lists (with or without a `TypeError:` prefix), and failing that
by the listed messages that share the most words with it. The lookup is also an entry of its own:

```ts
import { formatError, loadErrorEntries, lookupError } from '@margoengine/mcp/error-codes';

const entries = await loadErrorEntries(); // the error help page the package ships
const matches = lookupError(entries, 'Mesh disposed; see https://margoengine.com/errors#disposed');
console.log(matches[0].entry.id, matches[0].by); // disposed link
console.log(formatError('Mesh disposed', matches)); // title, link, cause and fix: the text the tool returns
```

| Function | Default | |
| --- | --- | --- |
| `loadErrorEntries(file?, signal?)` | the entries the package ships (`dist/error-codes.json`) | Reads the entries; a missing file is a `failed` error. |
| `lookupError(entries, query, limit?)` | 3 entries (1 to 10) | A link, id or code gives its one entry; a listed message its entries; otherwise shared words. |
| `createErrorTool(entries)` | | The `explain_error` tool. |
| `createMargoServer({ errors })` | the entries the package ships | Entries the server's tool answers from. |

A message with values in it (a name, a number) that the page does not list word for word is matched by its words: it
needs at least half of its words in one listed message, so a message from outside Margo matches nothing.

## Resources and prompts

Besides tools, the server offers the docs as MCP resources, so a client can put a page into the model's context
without a tool call, and four starter prompts that a user picks from the client's menu (Claude Code lists them as
slash commands, `/mcp__margoengine__start_scene` and so on). Each prompt tells the model which tools to use and in
what order. From `@margoengine/mcp/resources`.

| Resource | What it holds |
| --- | --- |
| `margo://readme` | The engine README. |
| `margo://packages/<id>/readme` | A package README, by its short name (`sciviz`; `@margoengine/sciviz` works too). |
| `margo://packages/<id>/api` | Every export of a package with its declaration, one section per entry point. |
| `margo://docs/<path>` | A docs page by its path without `.md` (`margo://docs/limits`, `margo://docs/guides/kits`). |

| Prompt | Arguments | What it asks for |
| --- | --- | --- |
| `start_scene` | `idea` | A first scene with the stage, started from the closest example and checked with `check_snippet`. |
| `port_code` | `code` (required), `from` | The code converted class by class with `port_to_margo`, then checked. |
| `fix_error` | `error` (required), `code` | The cause and fix from `explain_error`, then the fixed code. |
| `add_feature` | `feature` (required), `code` | The optional package that provides the feature, added to the code. |

Any server made with `createMcpServer` can offer them:

```ts
import { createMcpServer, loadCorpus } from '@margoengine/mcp';
import { createDocResources, createStarterPrompts } from '@margoengine/mcp/resources';

const server = createMcpServer({
  tools: [],
  resources: createDocResources(await loadCorpus()),
  prompts: createStarterPrompts(),
});
const listed = await server.handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
console.log(listed); // the first 100 resources and a nextCursor for the rest
const page = await server.handle({
  jsonrpc: '2.0',
  id: 2,
  method: 'resources/read',
  params: { uri: 'margo://packages/stage/readme' },
});
console.log(page); // { contents: [{ uri, mimeType: 'text/markdown', text }] }
const prompt = await server.handle({
  jsonrpc: '2.0',
  id: 3,
  method: 'prompts/get',
  params: { name: 'fix_error', arguments: { error: 'Mesh disposed; see https://margoengine.com/errors#disposed' } },
});
console.log(prompt); // one user message that names explain_error and check_snippet
server.dispose();
```

| Option | Default | |
| --- | --- | --- |
| `createMcpServer({ resources })` | none | A `ResourceProvider` (`list`, `templates`, `read`); the `resources` capability is declared only when given. |
| `createMcpServer({ prompts })` | none | `PromptDefinition`s; the `prompts` capability is declared only when given. |
| `createMcpServer({ pageSize })` | 100 | Items per page of `resources/list`, `resources/templates/list` and `prompts/list`. |
| `createMargoServer()` | both offered | The command always offers the docs resources and the starter prompts. |

Resources come only from the shipped snapshot: an address it does not list (a file path, another scheme) is `-32002`
Resource not found. Lists are paged with an opaque `cursor`; a cursor the server did not hand out is `-32602`.
Subscriptions and list-change notifications are not offered, since the snapshot does not change while the server runs.

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
| `createMargoServer({ projectRoot })` | the current directory | Where `check_snippet` finds `typescript` and the Margo packages, and where `render_snippet` resolves imports. |
| `createMargoServer({ render })` | `false` | `true` (or `{ gpuFlags }`) offers `render_snippet`; the command's `--render`. |
| `serveStdio(server, { input, output, signal })` | `process.stdin`, `process.stdout`, none | Streams to use; abort the signal to stop. |
| `checkSnippet(code, { language, strict, timeoutMs, signal })` | `ts`, `true`, 60000, none | The type check on its own. |

## Errors

A failed tool call is a normal result with `isError: true`, a `structuredContent.error` with a `code`
(`argument`, `range`, `unsupported`, `failed`, `disposed`) and a message that ends with a link to the
[error help](https://margoengine.com/errors#mcp). Protocol faults are JSON-RPC errors (`-32700` to `-32603`, and `-32002` for an unknown resource).

## Protocol

Implemented from the published specification: JSON-RPC 2.0, one message per line over stdio, `initialize` (versions
2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05), `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/templates/list`, `resources/read`, `prompts/list`, `prompts/get` (paged with a cursor)
and `notifications/cancelled`. Requests run side by side. Nothing but protocol messages goes to stdout.
