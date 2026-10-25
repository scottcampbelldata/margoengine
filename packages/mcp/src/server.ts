import { fault } from '../../shared/errors.js';
import { errorCode, helpLink } from './errors.js';

/** The protocol revisions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** The package version, reported to clients in `serverInfo`. */
export const VERSION = '1.0.0';

/** A JSON value. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A JSON-RPC 2.0 request or notification (a notification has no `id`). */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/** A JSON-RPC 2.0 response. */
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: Json }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string; data?: Json } };

/** The JSON-RPC error codes the server answers with. */
export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** What a tool returns: text for the model, and the same data as JSON for programs. */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  structuredContent?: { [key: string]: Json };
  isError?: boolean;
}

/** What a running tool is given. */
export interface ToolContext {
  /** Aborted when the client cancels the request or the server is disposed. */
  signal: AbortSignal;
}

/** A tool the server offers. */
export interface ToolDefinition {
  /** Machine name, `search_docs`. */
  name: string;
  /** Short display name. */
  title: string;
  /** What it does and when to call it; the model reads this to choose tools. */
  description: string;
  /** JSON Schema of the arguments object. */
  inputSchema: {
    type: 'object';
    properties: Record<string, Json>;
    required?: string[];
    additionalProperties?: boolean;
  };
  /** Hints for clients: whether the tool only reads, and whether it reaches outside the process. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Runs the tool. Throw for a bad argument or a failure; the server turns it into an `isError` result with the code. */
  run(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> | ToolResult;
}

/** Options of {@link createMcpServer}. */
export interface McpServerOptions {
  /** The tools to offer. */
  tools: readonly ToolDefinition[];
  /** Text for the client's model about what the server is for (the `instructions` of `initialize`). */
  instructions?: string;
  /** `serverInfo.name` (default `margoengine`). */
  name?: string;
}

/** A Model Context Protocol server, independent of the transport: feed it messages, it answers them. */
export interface McpServer extends Disposable {
  /**
   * Handles one JSON-RPC message (already parsed). Resolves with the response to send, or undefined for a
   * notification. Never rejects: failures become JSON-RPC errors.
   */
  handle(message: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | undefined>;
  /** True once the client sent `notifications/initialized`. */
  readonly initialized: boolean;
  /** Cancels every request still running; later messages get a `state` error. */
  dispose(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rpcError = (id: string | number | null, code: number, message: string, data?: Json): JsonRpcResponse => ({
  jsonrpc: '2.0',
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});

/** Converts a thrown value into a tool result the model can read and act on. */
function failure(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = errorCode(error),
    help = helpLink(error);
  return {
    content: [{ type: 'text', text: `${code}: ${message}` }],
    structuredContent: { error: { code, message, ...(help ? { help } : {}) } },
    isError: true,
  };
}

/**
 * Creates a server that answers `initialize`, `ping`, `tools/list` and `tools/call`, and honours
 * `notifications/cancelled`. Follows the Model Context Protocol specification (2025-11-25, and the three
 * revisions before it) with JSON-RPC 2.0 messages.
 */
export function createMcpServer(options: McpServerOptions): McpServer {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  const running = new Map<string | number, AbortController>();
  const lifetime = new AbortController();
  let initialized = false;

  async function request(message: JsonRpcRequest, id: string | number): Promise<JsonRpcResponse> {
    const params = isRecord(message.params) ? message.params : {};
    switch (message.method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        const version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name ?? 'margoengine', title: 'Margo Engine', version: VERSION },
            ...(options.instructions ? { instructions: options.instructions } : {}),
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...tools.values()].map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: tool.inputSchema as unknown as Json,
              ...(tool.annotations ? { annotations: tool.annotations as Json } : {}),
            })),
          },
        };
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? tools.get(params.name) : undefined;
        if (!tool) return rpcError(id, RPC.invalidParams, `Unknown tool: ${String(params.name)}`);
        if (params.arguments !== undefined && !isRecord(params.arguments))
          return rpcError(id, RPC.invalidParams, 'arguments must be an object');
        const controller = new AbortController();
        const abort = () => controller.abort();
        lifetime.signal.addEventListener('abort', abort, { once: true });
        running.set(id, controller);
        try {
          const result = await tool.run(params.arguments ?? {}, { signal: controller.signal });
          return { jsonrpc: '2.0', id, result: result as unknown as Json };
        } catch (error) {
          // A tool failure is a result the model can read (isError), not a protocol error.
          return { jsonrpc: '2.0', id, result: failure(error) as unknown as Json };
        } finally {
          running.delete(id);
          lifetime.signal.removeEventListener('abort', abort);
        }
      }
      default:
        return rpcError(id, RPC.methodNotFound, `Method not found: ${message.method}`);
    }
  }

  async function one(message: unknown): Promise<JsonRpcResponse | undefined> {
    if (lifetime.signal.aborted) {
      const id =
        isRecord(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null;
      return rpcError(id, RPC.internal, fault('disposed', 'The server was disposed', 'mcp').message);
    }
    if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return rpcError(
        isRecord(message) && (typeof message.id === 'string' || typeof message.id === 'number') ? message.id : null,
        RPC.invalidRequest,
        'Not a JSON-RPC 2.0 request',
      );
    const request_ = message as unknown as JsonRpcRequest;
    if (request_.id === undefined) {
      // Notifications get no response.
      if (request_.method === 'notifications/initialized') initialized = true;
      else if (request_.method === 'notifications/cancelled') {
        const target = isRecord(request_.params) ? request_.params.requestId : undefined;
        if (typeof target === 'string' || typeof target === 'number') running.get(target)?.abort();
      }
      return undefined;
    }
    if (typeof request_.id !== 'string' && typeof request_.id !== 'number')
      return rpcError(null, RPC.invalidRequest, 'id must be a string or a number');
    try {
      return await request(request_, request_.id);
    } catch (error) {
      return rpcError(request_.id, RPC.internal, error instanceof Error ? error.message : String(error));
    }
  }

  return {
    get initialized() {
      return initialized;
    },
    async handle(message) {
      if (Array.isArray(message)) {
        if (!message.length) return rpcError(null, RPC.invalidRequest, 'An empty batch is not a request');
        const answers = (await Promise.all(message.map(one))).filter(
          (answer): answer is JsonRpcResponse => answer !== undefined,
        );
        return answers.length ? answers : undefined;
      }
      return one(message);
    },
    dispose() {
      lifetime.abort();
    },
    [Symbol.dispose]() {
      lifetime.abort();
    },
  };
}
