/// <reference lib="esnext.disposable" preserve="true" />
/// <reference types="node" preserve="true" />
// The development relay for remote inspection (Node). The phone or headset page (target) and the desktop page
// (viewer) cannot reach each other directly, so both reach this server: POST /send forwards one message to every
// open stream of the other role, GET /events is a stream of the other role's messages, one per line. Every request
// carries the relay's token in its Authorization header (never in a URL); CORS lets pages of any origin call it with
// that token. HTTP/1.1 per RFC 9110 and RFC 9112; the CORS preflight per the WHATWG Fetch standard.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';

/** `createRemoteRelay` options. */
export interface RemoteRelayOptions {
  /** Interface to listen on. Default `127.0.0.1` (this machine only); `0.0.0.0` lets a phone on the LAN reach it. */
  host?: string;
  /** Port, 0 for any free one. Default 0. */
  port?: number;
  /** The secret both pages pass. Default 32 random bytes, base64url. At least 16 characters. */
  token?: string;
  /** Largest message in bytes, 1 to 16,000,000. Default 16,000,000 (a canvas PNG fits). */
  maxBytes?: number;
}
/** A running relay. */
export interface RemoteRelay extends AsyncDisposable {
  /** The URL to give `relayTransport` (a LAN address when listening on every interface). */
  readonly url: string;
  readonly token: string;
  readonly port: number;
  /** Open streams per role. */
  streams(role: 'target' | 'viewer'): number;
  close(): Promise<void>;
}

const roles = ['target', 'viewer'] as const;
type Role = (typeof roles)[number];

/** Starts the relay. Development only: anyone with the token can read and edit the target's scene. */
export async function createRemoteRelay(options: RemoteRelayOptions = {}): Promise<RemoteRelay> {
  const {
    host = '127.0.0.1',
    port = 0,
    token = randomBytes(32).toString('base64url'),
    maxBytes = 16_000_000,
  } = options;
  if (typeof token !== 'string' || token.length < 16)
    throw new TypeError('createRemoteRelay token must be 16 or more characters; pass a longer secret or omit it');
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new RangeError('createRemoteRelay port must be 0 to 65535; pass a port number or 0');
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_000_000)
    throw new RangeError('createRemoteRelay maxBytes must be 1 to 16000000; pass a byte count in range');
  const expected = Buffer.from(`Bearer ${token}`),
    open: Record<Role, Set<ServerResponse>> = { target: new Set(), viewer: new Set() };
  const cors = (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader('Access-Control-Allow-Origin', request.headers.origin ?? '*');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Margo-Role');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  };
  const server = createServer((request, response) => {
    cors(request, response);
    const end = (status: number, text = '') => response.writeHead(status, { 'Content-Type': 'text/plain' }).end(text);
    if (request.method === 'OPTIONS') return end(204);
    const given = Buffer.from(String(request.headers.authorization ?? ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return end(401, 'Wrong or missing token; pass the relay token in the Authorization header');
    const role = request.headers['x-margo-role'] as Role;
    if (!roles.includes(role)) return end(400, 'Missing role; send X-Margo-Role: target or viewer');
    const path = new URL(request.url ?? '/', 'http://relay').pathname;
    if (request.method === 'GET' && path === '/events') {
      response.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      response.flushHeaders();
      open[role].add(response);
      // An empty line now and then keeps idle phone and proxy connections open; readers skip empty lines.
      const beat = setInterval(() => response.write('\n'), 15000);
      response.on('close', () => {
        clearInterval(beat);
        open[role].delete(response);
      });
      return;
    }
    if (request.method === 'POST' && path === '/send') {
      const parts: Buffer[] = [];
      let size = 0;
      request.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          end(413, `Message over ${maxBytes} bytes; lower the canvas resolution or raise maxBytes`);
          request.destroy();
        } else parts.push(chunk);
      });
      request.on('end', () => {
        if (size > maxBytes) return;
        // One message per line: JSON text has no raw line breaks, so any are removed rather than split.
        const line = Buffer.concat(parts)
          .toString('utf8')
          .replace(/[\r\n]+/g, ' ');
        for (const stream of open[role === 'target' ? 'viewer' : 'target']) stream.write(`${line}\n`);
        end(204);
      });
      return;
    }
    end(404, 'Use GET /events or POST /send');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const bound = (server.address() as { port: number }).port,
    lan =
      host === '0.0.0.0'
        ? Object.values(networkInterfaces())
            .flat()
            .find((a) => a && a.family === 'IPv4' && !a.internal)?.address
        : undefined,
    url = `http://${lan ?? (host === '0.0.0.0' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host)}:${bound}`;
  const close = async () => {
    for (const role of roles) for (const stream of open[role]) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return {
    url,
    token,
    port: bound,
    streams: (role) => open[role].size,
    close,
    [Symbol.asyncDispose]: close,
  };
}
