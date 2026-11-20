// Starts one development or production server, waits until it answers, fetches its first page and what the page loads,
// and reports every problem: a non-200 answer, a missing module, or a warning or error line in the server output. Used
// by scripts/check-dev-servers.mjs (this checkout's servers) and scripts/template-install-check.mjs (scaffolded apps).
// The server is killed with its whole process tree afterwards. Nothing here needs a GPU.
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { endTree } from './shutdown.mjs';

/** A line that names a problem. The lines of a clean Vite, Next.js or Node server never match. */
export const BAD_LINE = /\(!\)|\berror\b|\bwarn(ing)?\b|⚠|failed|cannot find|could not resolve|not found|no matching export|deprecat/i;

export function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

/** One GET that accepts the self-signed certificate of the LAN server; the answer is read whole. */
export function get(url, { insecure = false, timeout = 30_000 } = {}) {
  return new Promise((done, fail) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { rejectUnauthorized: !insecure, timeout }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => done({ status: response.statusCode, type: response.headers['content-type'] ?? '', body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('timeout', () => request.destroy(new Error(`${url}: no answer in ${timeout / 1000} s`)));
    request.on('error', fail);
  });
}

/**
 * A TCP port nothing listens on at `host` right now, from the operating system. The checks start each server on one of
 * these instead of a fixed number: a fixed port collided with every other server on the machine (another lane's GPU
 * suite or dev server), and the check then failed with "Port 5413 is already in use" for a server that was fine.
 */
export function freePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const tcpOpen = (port, host) =>
  new Promise((done) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => (socket.destroy(), done(true)));
    socket.once('error', () => done(false));
  });

// Bundled third-party code (Vite's pre-bundled dependencies, Next.js chunks) holds strings that look like imports; only
// the page and the app's own modules are followed.
const isThirdParty = (url) => /[/](node_modules|_next)[/]/.test(new URL(url).pathname);

/** Same-origin URLs a page or module names: script/link sources and module specifiers that start with a slash. */
function referencedUrls(text, base, html) {
  const found = new Set();
  const add = (reference) => {
    if (!reference || /^(data:|blob:|#|mailto:)/.test(reference)) return;
    const url = new URL(reference, base);
    if (url.origin === new URL(base).origin) found.add(url.href);
  };
  // Inline script bodies hold strings that look like tags (React's runtime inlined by Next.js); read real tags only.
  const markup = !html ? '' : text.replace(/<script(?![^>]*\ssrc=)[^>]*>[\s\S]*?<\/script>/g, '');
  for (const [, reference] of markup.matchAll(/<(?:script|link)\b[^>]*?\s(?:src|href)="([^"]+)"/g)) add(reference);
  if (!isThirdParty(base))
    for (const [, reference] of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\/[^"']+|\.{1,2}\/[^"']+)["']/g)) add(reference);
  return found;
}

/**
 * @param {{command: string, args: string[], cwd: string, env?: object, page: string, tcpPort?: number, host?: string,
 *   insecure?: boolean, listenLimitMs?: number, limitMs?: number, settleMs?: number,
 *   end?: (pid: number) => Promise<number[]>}} options
 *   `page` is the full first URL (or '' for a server with no web page: it must then give `tcpPort`). `end` ends the
 *   server's tree and resolves to the pids still running (default: endTree, which waits until they are gone).
 */
export async function probe({ command, args, cwd, env = process.env, page, tcpPort, host = '127.0.0.1', insecure = false, listenLimitMs = 60_000, limitMs = 120_000, settleMs = 6_000, end = endTree }) {
  const lines = [];
  const problems = [];
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const onData = (chunk) => lines.push(...chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter((line) => line.trim()));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (error) => problems.push(`could not start: ${error.message}`));
  let outOfTime = false;
  const deadline = setTimeout(() => ((outOfTime = true), killTree(child)), limitMs);
  try {
    const started = Date.now();
    for (;;) {
      if (child.exitCode !== null || problems.length) throw new Error(`exited ${child.exitCode} before it answered`);
      if (Date.now() - started > listenLimitMs) throw new Error(`no answer within ${listenLimitMs / 1000} s`);
      const up = page
        ? await get(page, { insecure, timeout: 5_000 }).then(() => true, () => false)
        : await tcpOpen(tcpPort, host);
      if (up) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (page) {
      // The crawl follows the app's whole module graph, however large. It used to stop and fail at a fixed 200 URLs: the
      // gameplay sandbox loads 204 real modules (its own, core's source and the built packages it imports), so a correct
      // server failed once a package it imports gained a module, and modules past the 200th went unchecked. A server
      // that keeps naming new URLs is still caught: the crawl runs inside the probe's hard limit and reports it.
      const queue = [page];
      const seen = new Set(queue);
      const unfinished = () =>
        new Error(`the crawl from ${page} did not finish within ${limitMs / 1000} s (${seen.size} URLs reached, ${queue.length} still queued)`);
      while (queue.length) {
        if (outOfTime) throw unfinished();
        const url = queue.shift();
        const answer = await get(url, { insecure }).catch((error) => {
          throw outOfTime ? unfinished() : error;
        });
        if (answer.status !== 200) problems.push(`${url} answered ${answer.status}`);
        else if (/html|javascript|css/.test(answer.type))
          for (const next of referencedUrls(answer.body, url, /html/.test(answer.type))) if (!seen.has(next)) (seen.add(next), queue.push(next));
      }
    }
    // The dependency scan and pre-bundling report after the first request; give them time to settle.
    await new Promise((r) => setTimeout(r, settleMs));
    // Only a server still running now answered: one that lost its port to another process exits, and the pages read
    // above came from that other process.
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`exited ${child.exitCode ?? child.signalCode} during the probe, so another process answered on its port`);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(deadline);
    // taskkill returns while the server is still dying and holds the folder it ran in: a caller that removed that
    // folder at once failed with EPERM under load (KB-FL3). Return only once the whole tree has gone.
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const left = await end(child.pid);
      if (left.length) problems.push(`processes ${left.join(', ')} still running after the kill`);
    }
  }
  for (const line of lines) if (BAD_LINE.test(line)) problems.push(`output: ${line.trim().slice(0, 240)}`);
  return { problems, lines };
}

/** Runs a command to its end (a production build) and returns its output lines; a bad line or a non-zero exit is a problem. */
export function runToEnd({ command, args, cwd, env = process.env, limitMs = 400_000 }) {
  return new Promise((done) => {
    const lines = [];
    const problems = [];
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const onData = (chunk) => lines.push(...chunk.toString().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/\r?\n/).filter((line) => line.trim()));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => (problems.push(`hard limit of ${limitMs / 1000} s reached`), killTree(child)), limitMs);
    child.on('error', (error) => (problems.push(`could not start: ${error.message}`), clearTimeout(timer), done({ problems, lines })));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) problems.push(`exit ${code}`);
      for (const line of lines) if (BAD_LINE.test(line)) problems.push(`output: ${line.trim().slice(0, 240)}`);
      done({ problems, lines });
    });
  });
}

/**
 * The environment without the variables that name a coding agent. `next dev` detects an agent from them and then writes
 * an AGENTS.md block into the project it serves; a person starting the same server never gets that file, and the check
 * must not dirty the tree whoever runs it.
 */
export function humanEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(AI_AGENT|CLAUDE|CODEX|CURSOR|GEMINI|OPENCODE|GOOSE|AUGMENT|REPL_ID|COPILOT|AMP_)/i.test(key)));
}
