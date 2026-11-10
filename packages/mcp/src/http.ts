/// <reference lib="esnext.disposable" preserve="true" />
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fault, rangeError, typeError } from '../../shared/errors.js';
import { PROTOCOL_VERSIONS, type Json, type JsonRpcResponse, type McpServer } from './server.js';

/** Streamable HTTP options. Each client session receives a separate server from the factory. */
export interface HttpTransportOptions {
  /** Same tools as stdio; once per legacy session or current-protocol request. Honour the abort signal. */
  createServer: (signal: AbortSignal) => McpServer | Promise<McpServer>;
  /** Exact Host header values permitted by the deployment (including port). Required for embedded handlers. */
  allowedHosts: readonly string[];
  /** Exact allowed browser origins, default none. Non-browser requests can omit Origin. */
  allowedOrigins?: readonly string[];
  /** Returns a stable authenticated principal, or false. Sessions are bound to that principal. */
  authorize: (request: IncomingMessage, signal: AbortSignal) => string | false | Promise<string | false>;
  /** Endpoint path, default /mcp. */
  path?: string;
  /** Complete request deadline, default 120000 ms. */
  timeoutMs?: number;
  /** Idle session lifetime, default 1800000 ms; active requests prevent idle expiry. */
  sessionTimeoutMs?: number;
  /** Maximum live/initializing legacy sessions plus current requests, default 128. */
  maxSessions?: number;
  /** Maximum request bytes, default 1 MiB. */
  maxBodyBytes?: number;
  /** Maximum serialized response bytes, default 32 MiB. */
  maxResponseBytes?: number;
  /** Abort shuts down sessions and pending requests. */
  signal?: AbortSignal;
}
/** A transport that can be mounted on an existing Node HTTP(S) server. Importing it starts nothing. */
export interface HttpTransport extends Disposable {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  dispose(): void;
}
/** Listener options; loopback with a generated bearer token is the default. */
export interface HttpListenOptions extends Omit<HttpTransportOptions, 'allowedHosts' | 'authorize'> {
  /** Bind address, default 127.0.0.1. Remote bindings require explicit authorization and allowedHosts. */
  host?: string;
  /** Port, default 0 (OS-assigned). */
  port?: number;
  allowedHosts?: readonly string[];
  authorize?: HttpTransportOptions['authorize'];
  /** Local bearer token, default cryptographically random per listener. */
  token?: string;
}
/** A running HTTP listener. TLS deployments can mount createHttpTransport on their HTTPS server. */
export interface HttpListener extends AsyncDisposable {
  readonly url: string;
  /** Generated/local token, absent when authorize is supplied. */
  readonly token?: string;
  close(): Promise<void>;
}
const MODERN = '2026-07-28';
const versions: readonly string[] = [MODERN, ...PROTOCOL_VERSIONS.filter((version) => version !== '2024-11-05')];
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const idValue = (v: unknown): v is string | number =>
  typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v));

function headerValue(raw: string | string[] | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (raw.startsWith('=?base64?') && raw.endsWith('?=')) {
    const value = raw.slice(9, -2);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value) return undefined;
    try {
      return new TextDecoder('utf8', { fatal: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  return raw === raw.trim() && /^[\x09\x20-\x7e]*$/.test(raw) ? raw : undefined;
}

function matchingParameters(schema: unknown, value: unknown, req: IncomingMessage, depth = 0): boolean {
  if (!object(schema) || depth > 32) return depth <= 32;
  const name = schema['x-mcp-header'];
  if (typeof name === 'string') {
    if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name) || !['string', 'integer', 'boolean'].includes(String(schema.type)))
      return false;
    const raw = req.headers[`mcp-param-${name.toLowerCase()}`];
    if (value === undefined || value === null) {
      if (raw !== undefined) return false;
    } else {
      const decoded = headerValue(raw);
      if (
        decoded === undefined ||
        (schema.type === 'integer'
          ? !/^-?(?:0|[1-9]\d*)(?:\.0+)?$/.test(decoded) || !Number.isSafeInteger(value) || Number(decoded) !== value
          : decoded !== String(value))
      )
        return false;
    }
  }
  if (!object(schema.properties)) return true;
  for (const [key, child] of Object.entries(schema.properties))
    if (!matchingParameters(child, object(value) && Object.hasOwn(value, key) ? value[key] : undefined, req, depth + 1))
      return false;
  return true;
}

function bounded<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) late?.(value);
        else resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

/** Implements current and legacy Streamable HTTP with JSON replies; standalone SSE listening is declined. */
export function createHttpTransport(options: HttpTransportOptions): HttpTransport {
  const path = options.path ?? '/mcp',
    timeout = options.timeoutMs ?? 120000,
    ttl = options.sessionTimeoutMs ?? 1800000,
    maxSessions = options.maxSessions ?? 128,
    maxBody = options.maxBodyBytes ?? 1024 * 1024,
    maxResponse = options.maxResponseBytes ?? 32 * 1024 * 1024;
  if (
    !/^\/[^?#\s]*$/.test(path) ||
    !options.allowedHosts.length ||
    typeof options.authorize !== 'function' ||
    typeof options.createServer !== 'function'
  )
    throw typeError('Supply an endpoint path, allowedHosts and an authorize function', 'mcp');
  for (const n of [timeout, ttl, maxSessions, maxBody, maxResponse])
    if (!Number.isSafeInteger(n) || n < 1) throw rangeError('HTTP limits must be positive safe integers', 'mcp');
  const lifetime = new AbortController();
  type Session = {
    server: McpServer;
    principal: string;
    version: string;
    expires: number;
    active: Set<string | number>;
  };
  const sessions = new Map<string, Session>();
  let creating = 0;
  const expire = () => {
    for (const [id, session] of sessions)
      if (!session.active.size && session.expires <= Date.now()) {
        session.server.dispose();
        sessions.delete(id);
      }
  };
  const timer = setInterval(expire, Math.min(ttl, 60000));
  timer.unref();
  const dispose = () => {
    lifetime.abort(fault('disposed', 'HTTP transport closed; start a new listener', 'mcp'));
    clearInterval(timer);
    options.signal?.removeEventListener('abort', dispose);
    for (const session of sessions.values()) session.server.dispose();
    sessions.clear();
  };
  options.signal?.addEventListener('abort', dispose, { once: true });
  if (options.signal?.aborted) dispose();
  return {
    dispose,
    [Symbol.dispose]: dispose,
    async handle(req, res) {
      let session: Session | undefined,
        requestId: string | number | undefined,
        ownsRequest = false;
      const active = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeout)]);
      const reply = (status: number, value?: unknown) => {
        if (res.destroyed || res.writableEnded) return;
        const body = value === undefined ? '' : JSON.stringify(value);
        if (Buffer.byteLength(body) > maxResponse) {
          res.writeHead(500, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: requestId ?? null,
              error: { code: -32000, message: 'Response exceeds maxResponseBytes; request a smaller result' },
            }),
          );
          return;
        }
        res.writeHead(status, { 'Content-Type': 'application/json' }).end(body);
      };
      const error = (status: number, message: string, code = -32600) =>
        reply(status, { jsonrpc: '2.0', id: requestId ?? null, error: { code, message } });
      const cancel = () => {
        if (session && requestId !== undefined)
          void session.server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } });
      };
      active.addEventListener('abort', cancel, { once: true });
      try {
        if (lifetime.signal.aborted) {
          error(503, 'HTTP transport closed');
          return;
        }
        const origin = req.headers.origin;
        if (
          !options.allowedHosts.includes(req.headers.host ?? '') ||
          (origin !== undefined && !(options.allowedOrigins ?? []).includes(origin))
        ) {
          error(403, 'Host or Origin is not allowed');
          return;
        }
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Vary', 'Origin');
        if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
        if (req.url !== path) {
          error(404, 'Unknown MCP endpoint');
          return;
        }
        if (req.method === 'OPTIONS') {
          res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
          res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version',
          );
          reply(204);
          return;
        }
        const principal = await bounded(Promise.resolve(options.authorize(req, active)), active);
        if (!principal || typeof principal !== 'string') {
          res.setHeader('WWW-Authenticate', 'Bearer');
          error(401, 'Authentication required');
          return;
        }
        if (req.method === 'GET' || !['POST', 'DELETE'].includes(req.method ?? '')) {
          res.setHeader('Allow', 'POST, DELETE, OPTIONS');
          error(405, 'SSE listening is not offered; use JSON POST replies');
          return;
        }
        const protocol = req.headers['mcp-protocol-version'];
        if (protocol !== undefined && (typeof protocol !== 'string' || !versions.includes(protocol))) {
          reply(400, {
            jsonrpc: '2.0',
            error: {
              code: -32022,
              message: 'Unsupported MCP-Protocol-Version',
              data: { supported: versions, requested: protocol },
            },
          });
          return;
        }
        expire();
        const sid = req.headers['mcp-session-id'];
        if (sid !== undefined && protocol !== MODERN) {
          if (typeof sid !== 'string' || !sessions.has(sid)) {
            error(404, 'Session expired or unknown; initialize again');
            return;
          }
          session = sessions.get(sid)!;
          if (session.principal !== principal) {
            error(404, 'Session expired or unknown; initialize again');
            return;
          }
          if (protocol !== undefined && protocol !== session.version) {
            error(400, 'Protocol header differs from the negotiated version');
            return;
          }
          session.expires = Date.now() + ttl;
        }
        if (req.method === 'DELETE') {
          if (protocol === MODERN) {
            res.setHeader('Allow', 'POST, OPTIONS');
            error(405, 'Protocol sessions are not used in this version');
            return;
          }
          if (!session) {
            error(400, 'Mcp-Session-Id is required');
            return;
          }
          session.server.dispose();
          sessions.delete(sid as string);
          reply(200, {});
          return;
        }
        const accept = (req.headers.accept ?? '')
          .split(',')
          .filter((part) => !/;\s*q=0(?:\.0*)?(?:;|$)/i.test(part))
          .map((part) => part.trim().split(';')[0].toLowerCase());
        if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
          error(406, 'Accept must include application/json and text/event-stream');
          return;
        }
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          error(415, 'Content-Type must be application/json');
          return;
        }
        if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
          error(415, 'Send uncompressed JSON');
          return;
        }
        if (Number(req.headers['content-length']) > maxBody) {
          error(413, 'Request exceeds maxBodyBytes');
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const read = async () => {
          for await (const chunk of req) {
            size += chunk.length;
            if (size > maxBody) throw rangeError('Request exceeds maxBodyBytes', 'mcp');
            chunks.push(chunk);
          }
        };
        try {
          await bounded(read(), active);
        } catch (reason) {
          if (active.aborted) req.destroy();
          else if (reason instanceof RangeError) {
            error(413, reason.message);
            return;
          }
          throw reason;
        }
        let message: unknown;
        try {
          message = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)));
        } catch {
          error(400, 'Parse error', -32700);
          return;
        }
        if (!object(message) || message.jsonrpc !== '2.0' || (message.id !== undefined && !idValue(message.id))) {
          error(400, 'A single JSON-RPC object with a valid id is required');
          return;
        }
        const params = object(message.params) ? message.params : {};
        const meta = object(params._meta) ? params._meta : {};
        const declared = meta['io.modelcontextprotocol/protocolVersion'];
        if (protocol === MODERN || (typeof declared === 'string' && declared >= MODERN)) {
          requestId = idValue(message.id) ? message.id : undefined;
          if (typeof message.method !== 'string' || requestId === undefined) {
            error(400, 'Modern HTTP accepts client requests only');
            return;
          }
          if (declared === undefined || !object(meta['io.modelcontextprotocol/clientCapabilities'])) {
            error(400, 'Per-request protocolVersion and clientCapabilities metadata are required', -32602);
            return;
          }
          if (
            protocol !== declared ||
            req.headers['mcp-method'] !== message.method ||
            (['tools/call', 'prompts/get', 'resources/read'].includes(message.method) &&
              headerValue(req.headers['mcp-name']) !== (message.method === 'resources/read' ? params.uri : params.name))
          ) {
            error(400, 'HeaderMismatch: required HTTP metadata differs from the request body', -32020);
            return;
          }
          if (declared !== MODERN) {
            reply(400, {
              jsonrpc: '2.0',
              id: requestId,
              error: {
                code: -32022,
                message: 'Unsupported protocol version',
                data: { supported: versions, requested: declared },
              },
            });
            return;
          }
          if (sessions.size + creating >= maxSessions) {
            error(503, 'Request capacity reached; wait for active requests');
            return;
          }
          creating++;
          const disconnected = new AbortController();
          const closed = () => {
            if (!res.writableEnded)
              disconnected.abort(fault('state', 'HTTP client disconnected; issue a new request', 'mcp'));
          };
          res.once('close', closed);
          const current = AbortSignal.any([active, disconnected.signal]);
          let server: McpServer | undefined;
          const stop = () => server?.dispose();
          current.addEventListener('abort', stop, { once: true });
          try {
            server = await bounded(Promise.resolve(options.createServer(current)), current, (late) => late.dispose());
            const initialized = await bounded(
              server.handle({
                jsonrpc: '2.0',
                id: 'http:initialize',
                method: 'initialize',
                params: {
                  protocolVersion: '2025-11-25',
                  capabilities: meta['io.modelcontextprotocol/clientCapabilities'],
                },
              }),
              current,
            );
            await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
            const info =
              initialized && !Array.isArray(initialized) && 'result' in initialized && object(initialized.result)
                ? initialized.result
                : {};
            if (message.method === 'tools/call') {
              const listed = await bounded(
                server.handle({ jsonrpc: '2.0', id: 'http:tools', method: 'tools/list' }),
                current,
              );
              const tools =
                listed &&
                !Array.isArray(listed) &&
                'result' in listed &&
                object(listed.result) &&
                Array.isArray(listed.result.tools)
                  ? listed.result.tools
                  : [];
              const tool = tools.find((tool) => object(tool) && tool.name === params.name);
              if (object(tool) && !matchingParameters(tool.inputSchema, params.arguments, req)) {
                error(400, 'HeaderMismatch: tool parameter headers differ from the request body', -32020);
                return;
              }
            }
            let answer: JsonRpcResponse | JsonRpcResponse[] | undefined;
            if (message.method === 'server/discover') {
              const capabilities = object(info.capabilities)
                ? Object.fromEntries(Object.keys(info.capabilities).map((key) => [key, {}]))
                : {};
              answer = {
                jsonrpc: '2.0',
                id: requestId,
                result: {
                  supportedVersions: [...versions],
                  capabilities,
                  ttlMs: 0,
                  cacheScope: 'private',
                  ...(typeof info.instructions === 'string' ? { instructions: info.instructions } : {}),
                },
              };
            } else if (message.method === 'initialize' || message.method.startsWith('notifications/')) {
              error(404, 'Method not found in the current HTTP protocol', -32601);
              return;
            } else answer = await bounded(server.handle(message), current);
            if (!answer || Array.isArray(answer)) {
              error(500, 'Server did not return one response', -32603);
              return;
            }
            if ('result' in answer && object(answer.result))
              answer.result = {
                ...answer.result,
                resultType: 'complete',
                _meta: {
                  ...(object(answer.result._meta) ? answer.result._meta : {}),
                  'io.modelcontextprotocol/serverInfo': info.serverInfo ?? {},
                },
              } as Json;
            if ('error' in answer && answer.error.code === -32002) answer.error.code = -32602;
            res.setHeader('Mcp-Protocol-Version', MODERN);
            reply('error' in answer && answer.error.code === -32601 ? 404 : 200, answer);
          } finally {
            current.removeEventListener('abort', stop);
            res.removeListener('close', closed);
            server?.dispose();
            creating--;
          }
          return;
        }
        if (typeof message.method !== 'string') {
          if (
            !Object.hasOwn(message, 'method') &&
            message.id !== undefined &&
            Object.hasOwn(message, 'result') !== Object.hasOwn(message, 'error') &&
            (!Object.hasOwn(message, 'error') ||
              (object(message.error) &&
                Number.isInteger(message.error.code) &&
                typeof message.error.message === 'string'))
          ) {
            reply(202);
            return;
          }
          error(400, 'Invalid JSON-RPC message');
          return;
        }
        if (message.params !== undefined && !object(message.params)) {
          error(400, 'MCP params must be an object');
          return;
        }
        requestId = message.id as string | number | undefined;
        if (!session) {
          if (message.method !== 'initialize' || requestId === undefined) {
            error(400, 'Initialize first, then send Mcp-Session-Id');
            return;
          }
          if (sessions.size + creating >= maxSessions) {
            error(503, 'Session capacity reached; close unused sessions');
            return;
          }
          creating++;
          let server: McpServer;
          try {
            server = await bounded(Promise.resolve(options.createServer(active)), active, (late) => late.dispose());
          } finally {
            creating--;
          }
          try {
            const answer = await bounded(server.handle(message), active);
            if (
              !answer ||
              Array.isArray(answer) ||
              !('result' in answer) ||
              !object(answer.result) ||
              typeof answer.result.protocolVersion !== 'string'
            ) {
              server.dispose();
              reply(400, answer);
              return;
            }
            if (!versions.includes(answer.result.protocolVersion)) {
              server.dispose();
              error(400, 'Use a Streamable HTTP protocol revision from 2025');
              return;
            }
            if (Buffer.byteLength(JSON.stringify(answer)) > maxResponse)
              throw rangeError('Initialize response exceeds maxResponseBytes', 'mcp');
            const id = randomUUID();
            session = {
              server,
              principal,
              version: answer.result.protocolVersion,
              expires: Date.now() + ttl,
              active: new Set(),
            };
            sessions.set(id, session);
            res.setHeader('Mcp-Session-Id', id);
            res.setHeader('Mcp-Protocol-Version', session.version);
            reply(200, answer);
            return;
          } catch (reason) {
            server.dispose();
            throw reason;
          }
        }
        if (message.method === 'initialize') {
          error(400, 'Session is already initialized');
          return;
        }
        if (
          !session.server.initialized &&
          message.method !== 'notifications/initialized' &&
          message.method !== 'ping'
        ) {
          error(400, 'Send notifications/initialized before tool requests');
          return;
        }
        if (requestId !== undefined) {
          if (session.active.has(requestId)) {
            error(409, 'Request id is already active in this session');
            return;
          }
          session.active.add(requestId);
          ownsRequest = true;
        }
        const answer = await bounded(session.server.handle(message), active);
        res.setHeader('Mcp-Protocol-Version', session.version);
        reply(answer === undefined ? 202 : 200, answer);
      } catch (reason) {
        error(active.aborted ? 504 : 500, reason instanceof Error ? reason.message : String(reason), -32000);
      } finally {
        active.removeEventListener('abort', cancel);
        if (ownsRequest && requestId !== undefined) session?.active.delete(requestId);
      }
    },
  };
}

/** Starts a loopback MCP endpoint, or an explicitly authenticated remote listener. No global or CLI side effects. */
export async function serveHttp(options: HttpListenOptions): Promise<HttpListener> {
  options.signal?.throwIfAborted();
  const host = options.host ?? '127.0.0.1';
  const local = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!local && (!options.authorize || !options.allowedHosts?.length))
    throw typeError('Remote HTTP requires authorize and exact allowedHosts; mount on HTTPS for remote clients', 'mcp');
  const token = options.authorize ? undefined : (options.token ?? randomBytes(32).toString('base64url'));
  if (token !== undefined && token.length < 32)
    throw typeError('Local bearer token must contain at least 32 characters', 'mcp');
  let transport: HttpTransport | undefined;
  const server = createServer((req, res) => {
    if (transport) void transport.handle(req, res);
    else res.writeHead(503).end();
  });
  server.requestTimeout = options.timeoutMs ?? 120000;
  server.headersTimeout = Math.min(server.requestTimeout, 10000);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port,
    authority = host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
  try {
    transport = createHttpTransport({
      ...options,
      allowedHosts: options.allowedHosts ?? [authority, `localhost:${port}`],
      authorize:
        options.authorize ??
        ((request) => {
          const expected = Buffer.from(`Bearer ${token}`),
            actual = Buffer.from(request.headers.authorization ?? '');
          return expected.length === actual.length && timingSafeEqual(expected, actual) ? 'local' : false;
        }),
    });
  } catch (error) {
    server.close();
    server.closeAllConnections();
    throw error;
  }
  const close = async () => {
    options.signal?.removeEventListener('abort', abort);
    transport?.dispose();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  };
  const abort = () => {
    void close();
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) await close();
  return { url: `http://${authority}${options.path ?? '/mcp'}`, token, close, [Symbol.asyncDispose]: close };
}
