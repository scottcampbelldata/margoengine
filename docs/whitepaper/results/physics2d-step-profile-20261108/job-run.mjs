// Own portable hard-deadline runner. Every child writes only inside this reproduction's output.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { homedir } from 'node:os';
const spec = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const jobs = Array.isArray(spec) ? spec : [spec];
const output = resolve(process.env.LANE_PROFILE_OUTPUT ?? '.');
mkdirSync(join(output, 'tmp'), { recursive: true });
mkdirSync(join(output, 'npm-cache'), { recursive: true });
for (const job of jobs) {
  if (!(Number.isFinite(job.timeout) && job.timeout > 0 && job.timeout <= 900000)) throw new Error('Every job requires a hard deadline <=900000ms');
  const log = resolve(job.log), inside = relative(output, log);
  if (inside.startsWith('..') || resolve(log) === output) throw new Error('Log must stay in owned output');
  const env = { ...process.env, PATH: join(homedir(), '.cargo', 'bin') + (process.platform === 'win32' ? ';' : ':') + process.env.PATH,
    ...job.env, MARGO_RESULT_CACHE: 'off', TEMP: join(output, 'tmp'), TMP: join(output, 'tmp'), npm_config_cache: join(output, 'npm-cache') };
  const start = Date.now(), args = job.args ?? [];
  appendFileSync(log, `START ${job.cmd} ${args.join(' ')}\n`);
  const child = spawn(job.cmd, args, { cwd: job.cwd ?? process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
  child.stdout.on('data', (s) => appendFileSync(log, s));
  child.stderr.on('data', (s) => appendFileSync(log, s));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15000, windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  }, job.timeout);
  const code = await new Promise((resolveCode, reject) => { child.on('error', reject); child.on('exit', resolveCode); });
  clearTimeout(timer);
  appendFileSync(log, `END code=${code} timeout=${timedOut} elapsed=${Date.now() - start}ms\n`);
  console.log(`${job.cmd}: ${code}, timeout=${timedOut}`);
  if (code !== 0 || timedOut) process.exit(code || 124);
}
