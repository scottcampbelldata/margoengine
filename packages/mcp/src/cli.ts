import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { loadCorpus, type Corpus } from './corpus.js';
import { createMcpServer, VERSION, type McpServer } from './server.js';
import { serveStdio, type StdioOptions } from './stdio.js';
import { createTools } from './tools.js';
import type { PortingGuide } from './porting.js';

/** What the server tells the client's model about itself. */
export const INSTRUCTIONS =
  'Margo Engine is a WebGPU 3D engine. Its core is small and frozen; every feature is a separate optional package. Before writing Margo code, call search_docs (a task or an exact name) or list_packages, then get_package for the README of the package you will use. After writing code, call check_snippet with it: it type-checks against the real package types in the project. Use list_examples to find a working example first. When the user brings code from another 3D library or names one of its APIs, call port_to_margo for the Margo package and calls that replace it.';

/** Options of {@link createMargoServer}. */
export interface MargoServerOptions {
  /** The documentation to serve (default: the corpus the package ships). */
  corpus?: Corpus;
  /** Folder with `typescript` and the Margo packages in `node_modules`, for `check_snippet` (default: the current directory). */
  projectRoot?: string;
  /** The porting guides for `port_to_margo` (default: the guides the package ships). */
  porting?: readonly PortingGuide[];
}

/** The Margo MCP server: its tools over the shipped documentation. Pass it to {@link serveStdio}. */
export async function createMargoServer(options: MargoServerOptions = {}): Promise<McpServer> {
  const corpus = options.corpus ?? (await loadCorpus());
  // The other tools live in their own entries; loading them by the package's name keeps each one a separate module.
  const { createPortingTool, loadPortingGuides } = await import('@margoengine/mcp/porting');
  return createMcpServer({
    tools: [
      ...createTools({ corpus, projectRoot: options.projectRoot }),
      createPortingTool(options.porting ?? (await loadPortingGuides())),
    ],
    instructions: INSTRUCTIONS,
  });
}

const HELP = `margoengine-mcp: a Model Context Protocol server for Margo Engine, over stdio.

Usage: margoengine-mcp [--root <folder>]

  --root <folder>  The project whose node_modules holds typescript and the @margoengine packages,
                   used by check_snippet (default: the current directory).
  --version        Print the version.
  --help           Print this text.

Tools: search_docs, list_packages, get_package, list_examples, check_snippet, port_to_margo.
Setup for Claude Code, Claude Desktop and Cursor: https://margoengine.com/llms/docs/ai-tools.md
`;

/** Streams of {@link runCli}; the defaults are the process's. */
export interface CliOptions extends StdioOptions {
  /** Where `--help`, `--version` and usage errors go (default `process.stderr`). */
  messages?: { write(text: string): unknown };
}

/**
 * The `margoengine-mcp` command: parses `argv` (without the node and script names), serves MCP over stdio until the
 * input ends, and resolves with the exit code (0, or 2 for a usage error).
 */
export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const messages = options.messages ?? process.stderr;
  let values: { root?: string; help?: boolean; version?: boolean };
  try {
    values = parseArgs({
      args: [...argv],
      options: { root: { type: 'string' }, help: { type: 'boolean' }, version: { type: 'boolean' } },
      strict: true,
    }).values;
  } catch (error) {
    messages.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (values.help) return messages.write(HELP), 0;
  if (values.version) return messages.write(`${VERSION}\n`), 0;
  using server = await createMargoServer({ projectRoot: values.root === undefined ? undefined : resolve(values.root) });
  await serveStdio(server, options);
  return 0;
}
