/// <reference lib="esnext.disposable" preserve="true" />
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import { fault, rangeError } from '../../shared/errors.js';
import type { Json } from './server.js';
import type { LiveConnection, LiveOperation } from './live.js';

/** Options for the loopback-only dev relay. */
export interface LiveHostOptions {
  /** Port, default 0 (OS-assigned). */
  port?: number;
  /** Exact browser origins allowed to connect, required. */
  origins: readonly string[];
  /** Request deadline in milliseconds, default 30000, range 100 to 300000. */
  timeoutMs?: number;
  /** Abort closes the host and rejects outstanding tools. */
  signal?: AbortSignal;
}
/** An authenticated relay for one page, with bounded pending commands. */
export interface LiveHost extends LiveConnection, AsyncDisposable {
  readonly endpoint: string;
  readonly token: string;
  close(): Promise<void>;
}

/** Starts a dev relay bound to 127.0.0.1. The token is generated per host and never placed in a URL. */
export async function createLiveHost(options: LiveHostOptions): Promise<LiveHost> {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000)
    throw rangeError('timeoutMs must be 100 to 300000', 'mcp');
  options.signal?.throwIfAborted();
  const token = randomBytes(32).toString('base64url');
  const lifetime = new AbortController();
  type Pending = {
    operation: LiveOperation;
    args: Record<string, unknown>;
    resolve(value: Json): void;
    reject(error: unknown): void;
    sent: boolean;
  };
  const pending = new Map<string, Pending>();
  let poll: ServerResponse | undefined;
  const flush = () => {
    if (!poll) return;
    for (const [id, item] of pending)
      if (!item.sent) {
        item.sent = true;
        poll.end(JSON.stringify({ id, operation: item.operation, args: item.args, timeoutMs }));
        poll = undefined;
        break;
      }
  };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    if ((origin && !options.origins.includes(origin)) || req.headers.host !== new URL(endpoint).host) {
      res.writeHead(403).end();
      return;
    }
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.writeHead(204).end();
      return;
    }
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/poll' && req.method === 'GET') {
      if (poll) {
        res.writeHead(409).end();
        return;
      }
      poll = res;
      const timer = setTimeout(() => {
        if (poll === res) poll = undefined;
        res.writeHead(204).end();
      }, 20000);
      res.on('close', () => {
        clearTimeout(timer);
        if (poll === res) poll = undefined;
      });
      flush();
      return;
    }
    if (req.url === '/result' && req.method === 'POST') {
      try {
        let body = '';
        for await (const chunk of req) {
          body += chunk.toString();
          if (Buffer.byteLength(body) > 17_000_000) {
            res.writeHead(413).end();
            return;
          }
        }
        const result = JSON.parse(body);
        const item = pending.get(result.id);
        if (item) {
          if (typeof result.error === 'string') item.reject(fault('failed', result.error, 'mcp'));
          else if ('value' in result) item.resolve(result.value);
          else {
            res.writeHead(400).end();
            return;
          }
        }
        res.writeHead(204).end();
      } catch (error) {
        if (!res.headersSent) res.writeHead(400).end(JSON.stringify({ error: String(error) }));
      }
      return;
    }
    res.writeHead(404).end();
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  let endpoint = '';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = async () => {
    lifetime.abort(fault('disposed', 'Live host closed; create another host', 'mcp'));
    options.signal?.removeEventListener('abort', abort);
    for (const item of pending.values()) item.reject(lifetime.signal.reason);
    poll?.end();
    poll = undefined;
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
  return {
    endpoint,
    token,
    close,
    [Symbol.asyncDispose]: close,
    async request(operation, args, signal) {
      const active = AbortSignal.any([lifetime.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      active.throwIfAborted();
      if (pending.size >= 64) throw fault('state', 'Live command queue is full; wait for the page to answer', 'mcp');
      const id = randomUUID();
      return new Promise<Json>((resolve, reject) => {
        const done = () => {
          pending.delete(id);
          active.removeEventListener('abort', cancelled);
        };
        const cancelled = () => {
          done();
          reject(active.reason);
        };
        pending.set(id, {
          operation,
          args,
          sent: false,
          resolve: (value) => {
            done();
            resolve(value);
          },
          reject: (error) => {
            done();
            reject(error);
          },
        });
        active.addEventListener('abort', cancelled, { once: true });
        flush();
      });
    },
  };
}
