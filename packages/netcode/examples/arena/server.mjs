// The arena's server: node packages/netcode/examples/arena/server.mjs [port]
// Then: npm run dev:examples, and open http://127.0.0.1:5173/packages/netcode/examples/arena/?server=ws://127.0.0.1:8787
import { serve } from '@margoengine/netcode/node';
import { game } from './game.js';

// ARENA_PORT=0 picks a free port (the package test uses it so parallel runs do not collide).
const port = Number(process.argv[2] ?? process.env.ARENA_PORT ?? 8787),
  stop = new AbortController();
process.once('SIGINT', () => stop.abort());
// The page comes from the dev server on another port, so any page may connect; the server listens on 127.0.0.1 only.
const origins = '*';
const served = await serve(game, { port, host: '127.0.0.1', origins, signal: stop.signal });
console.log(`arena server on ws://127.0.0.1:${served.port} (Ctrl+C stops it)`);
await served.done;
