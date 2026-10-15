// One GPU user at a time across agents and worktrees: test-results/gpu.lock in the MAIN checkout.
// Acquire is an atomic mkdir plus owner.json; release removes the lock only if this owner still holds it; a lock whose
// owner process is gone is stale and taken over. Never delete a lock you don't own.
// CLI: node scripts/gpu-lock.mjs run --owner=<agent id> -- <command...>   (holds the lock only while the command runs)
//      node scripts/gpu-lock.mjs status
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const main = resolve(import.meta.dirname, '..').replace(/[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/, '');
export const lockDir = process.env.MARGO_GPU_LOCK ?? join(main, 'test-results', 'gpu.lock');
const ownerFile = join(lockDir, 'owner.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {try {process.kill(pid, 0); return true;} catch (error) {return error.code === 'EPERM';}};

export function status() {
  try {return JSON.parse(readFileSync(ownerFile, 'utf8'));} catch {
    try {readFileSync(join(lockDir, 'owner.txt')); return {legacy: true};} catch {}
    try {mkdirSync(lockDir); rmSync(lockDir, {recursive: true}); return null;} catch {return {unknown: true};}
  }
}

/** Waits (polling every `poll` ms) until the lock is ours. Returns a release function that only removes our own lock. */
export async function acquire({owner, poll = 30_000, log = console.error} = {}) {
  if (!owner) throw new Error('gpu-lock: pass an owner (agent id)');
  const token = `${owner}:${process.pid}:${Date.now()}`;
  for (let waited = 0; ; waited += poll) {
    try {
      mkdirSync(lockDir, {recursive: false});
      writeFileSync(ownerFile, JSON.stringify({owner, pid: process.pid, token, takenAt: new Date().toISOString()}));
      return () => {if (status()?.token === token) rmSync(lockDir, {recursive: true, force: true});};
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const held = status();
      if (held?.pid && !alive(held.pid)) {log(`gpu-lock: taking over stale lock from ${held.owner} (pid ${held.pid} gone)`); rmSync(lockDir, {recursive: true, force: true}); continue;}
      if (waited % (poll * 10) === 0) log(`gpu-lock: held by ${held?.owner ?? 'an unlabelled holder'}; waiting`);
      await sleep(poll);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [verb, ...rest] = process.argv.slice(2);
  if (verb === 'status') console.log(JSON.stringify(status()));
  else if (verb === 'run') {
    const split = rest.indexOf('--'), owner = rest.find(a => a.startsWith('--owner='))?.slice(8), command = rest.slice(split + 1);
    if (split < 0 || !command.length) throw new Error('usage: gpu-lock.mjs run --owner=<id> -- <command...>');
    const release = await acquire({owner});
    let code = 1;
    try {code = spawnSync(command[0], command.slice(1), {stdio: 'inherit', shell: process.platform === 'win32'}).status ?? 1;} finally {release();}
    process.exit(code);
  } else throw new Error('usage: gpu-lock.mjs run --owner=<id> -- <command...> | status');
}
