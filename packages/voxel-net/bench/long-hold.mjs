// Holds plain WebSockets for a long time with no game code on them, to learn what a path does to old connections. Found
// the Plaza 1006 closes: Cloudflare ends proxied WebSockets from about 15 minutes of age whatever they carry
// (docs/voxel-net-capacity-2026-10-31.md, "Old connections"). A unit test cannot reach Cloudflare, so this is the check to
// run after any change on that path, or any host move:
//   node bench/long-hold.mjs serve [--port=8812] [--host=127.0.0.1]
//   node bench/long-hold.mjs hold --url=wss://host/path [--count=20] [--mode=busy|quiet] [--seconds=2700] [--origin=URL] [--out=FILE]
// Hold one group through the proxy and one past it, side by side. `busy` sends 20 messages a second and gets 2 KB back for
// each; `quiet` sends one every 20 s and gets 8 bytes back. The server logs every end with the side that it heard it from.
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { acceptWebSocket, connectWebSocket } from '../dist/server.js';
import { summarizeCloses } from './remote-args.mjs';

const MODES = {
  busy: { every: 50, reply: new Uint8Array(2000) },
  quiet: { every: 20_000, reply: new Uint8Array(8) },
};
const ask = new Uint8Array(32);

const modeOf = (name) => {
  const mode = MODES[name];
  if (!mode) throw new RangeError(`--mode=${name}: pass busy or quiet`);
  return mode;
};

/** Starts the echo server; a client's path picks its reply with `?mode=`. Resolves to the HTTP server. */
export async function serve({ port = 8812, host = '127.0.0.1', log = console.log, origins = '*' } = {}) {
  const server = createServer((_, res) => res.writeHead(426).end());
  server.on('upgrade', (req, socket, head) => {
    const conn = acceptWebSocket(req, socket, head, { origins, maxMessage: 4096 });
    if (!conn) return;
    const born = Date.now(),
      name = new URL(req.url, 'http://local').searchParams.get('mode') ?? 'quiet',
      { reply } = modeOf(name);
    conn.onmessage = () => conn.send(reply);
    conn.onclose = (code, reason) =>
      log(
        `end ${code} ${reason} ${name} age ${Math.round((Date.now() - born) / 1000)} s at ${new Date().toISOString()}`,
      );
  });
  await new Promise((done) => server.listen(port, host, done));
  return server;
}

/** Holds `count` connections for `seconds` and resolves to the summary of how they ended. */
export async function hold({
  url,
  count = 20,
  mode = 'busy',
  seconds = 2700,
  origin,
  joinMs = 500,
  log = console.log,
}) {
  const { every } = modeOf(mode),
    target = new URL(url),
    began = Date.now(),
    opened = [],
    closes = [];
  target.searchParams.set('mode', mode);
  const one = async (index) => {
    await new Promise((done) => setTimeout(done, index * joinMs));
    const conn = await connectWebSocket(target, origin ? { headers: { Origin: origin } } : {}),
      born = Date.now(),
      timer = setInterval(() => conn.send(ask), every);
    opened.push(conn);
    conn.onclose = (code, reason) => {
      clearInterval(timer);
      const age = (Date.now() - born) / 1000;
      closes.push({ code, reason, age });
      log(`close ${code} ${reason} age ${Math.round(age)} s at ${new Date().toISOString()}`);
    };
  };
  const made = await Promise.allSettled(Array.from({ length: count }, (_, i) => one(i))),
    failed = made.filter((r) => r.status === 'rejected').length;
  await new Promise((done) => setTimeout(done, Math.max(0, seconds * 1000 - (Date.now() - began))));
  const ended = closes.length,
    summary = { ...summarizeCloses(closes), held: count - failed - ended, failed, seconds, mode };
  for (const conn of opened) conn.close();
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...rest] = process.argv.slice(2),
    arg = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  if (command === 'serve') {
    await serve({ port: Number(arg('port', 8812)), host: arg('host', '127.0.0.1') });
    console.log('listening');
  } else if (command === 'hold') {
    const summary = await hold({
        url: arg('url'),
        count: Number(arg('count', 20)),
        mode: arg('mode', 'busy'),
        seconds: Number(arg('seconds', 2700)),
        origin: arg('origin'),
      }),
      text = JSON.stringify(summary, null, 1);
    console.log(text);
    if (arg('out')) await writeFile(arg('out'), `${text}\n`);
    process.exit(0);
  } else throw new TypeError('Pass serve or hold; the usage is at the top of bench/long-hold.mjs');
}
