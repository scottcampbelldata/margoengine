/// <reference lib="esnext.disposable" preserve="true" />
// @margoengine/mcp: a Model Context Protocol server that lets AI coding tools read Margo and check code against it.
// Optional and separate from core (adds nothing to it). No dependencies: JSON-RPC over stdio, written from the
// published MCP specification. Importing this module starts nothing; the `margoengine-mcp` command does.
export { INSTRUCTIONS, createMargoServer, runCli } from './cli.js';
export type { CliOptions, MargoServerOptions } from './cli.js';
export { PROTOCOL_VERSIONS, RPC, VERSION, createMcpServer } from './server.js';
export type {
  Json,
  JsonRpcRequest,
  JsonRpcResponse,
  McpServer,
  McpServerOptions,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from './server.js';
export { serveStdio } from './stdio.js';
export type { StdioOptions } from './stdio.js';
export { createTools } from './tools.js';
export type { ToolsOptions } from './tools.js';
export { checkSnippet, formatReport } from './check.js';
export type { CheckOptions, SnippetDiagnostic, SnippetReport } from './check.js';
export { createIndex, loadCorpus, packageId, searchCorpus } from './corpus.js';
export type {
  Corpus,
  CorpusDoc,
  CorpusExample,
  CorpusIndex,
  CorpusPackage,
  HitKind,
  SearchHit,
  SearchOptions,
} from './corpus.js';
