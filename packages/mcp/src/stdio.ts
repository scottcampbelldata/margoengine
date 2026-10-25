import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { RPC, type McpServer } from './server.js';

/** Options of {@link serveStdio}. */
export interface StdioOptions {
  /** Where messages come from (default `process.stdin`). */
  input?: Readable;
  /** Where responses go (default `process.stdout`). Nothing else is ever written there. */
  output?: Writable;
  /** Stops serving when aborted: the promise resolves after the requests already running finish or are cancelled. */
  signal?: AbortSignal;
}

/**
 * Serves `server` over the MCP stdio transport: one JSON message per line in, one per line out (UTF-8, no
 * embedded newlines). Requests run side by side, so a slow type check does not hold up a search. Resolves when the
 * input ends or `signal` aborts, after every request already started has been answered.
 */
export async function serveStdio(server: McpServer, options: StdioOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin,
    output = options.output ?? process.stdout;
  const pending = new Set<Promise<void>>();
  const send = (message: unknown) =>
    new Promise<void>((done) => {
      output.write(`${JSON.stringify(message)}\n`, () => done());
    });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const stop = () => lines.close();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        await send({
          jsonrpc: '2.0',
          id: null,
          error: { code: RPC.parse, message: 'Parse error: the line is not JSON' },
        });
        continue;
      }
      const work = server
        .handle(message)
        .then((response) => (response === undefined ? undefined : send(response)))
        .finally(() => pending.delete(work));
      pending.add(work);
    }
  } finally {
    options.signal?.removeEventListener('abort', stop);
    await Promise.all(pending);
  }
}
