// Runs on the server during the real network bench, one JSON line every 2 s: CPU per core, memory, network bytes, TCP
// sockets on 443, CPU, memory and open files of each Node and nginx process, and nginx error lines by kind. It changes nothing.
//   sudo timeout 11000 node host-sampler.mjs out.jsonl
import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync, statSync } from 'node:fs';

const out = process.argv[2],
  errorLog = '/var/log/nginx/error.log',
  tick = 100; // USER_HZ
const cpuLines = () =>
  readFileSync('/proc/stat', 'utf8')
    .split('\n')
    .filter((l) => /^cpu\d/.test(l))
    .map((l) => {
      const v = l.split(/\s+/).slice(1).map(Number),
        idle = v[3] + v[4];
      return { idle, total: v.reduce((a, n) => a + n, 0), softirq: v[6], steal: v[7] };
    });
function processes() {
  const list = [];
  for (const pid of readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'),
        name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      if (name !== 'node' && name !== 'nginx' && !name.startsWith('MainThread')) continue;
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' '),
        cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
      if (cmd.includes('host-sampler')) continue;
      const shard = cmd.match(/"index":(\d+)/);
      list.push({
        pid: Number(pid),
        role:
          name === 'nginx'
            ? cmd.includes('master')
              ? 'nginx-master'
              : 'nginx'
            : shard
              ? `shard${shard[1]}`
              : 'router',
        cpu: Number(rest[11]) + Number(rest[12]),
        rss: Number(rest[21]) * 4096,
        files: readdirSync(`/proc/${pid}/fd`).length,
      });
    } catch {
      // gone between the listing and the read
    }
  }
  return list;
}
const net = () => {
  const line = readFileSync('/proc/net/dev', 'utf8')
      .split('\n')
      .find((l) => /^\s*(eth|ens|enp)/.test(l)),
    v = line.split(':')[1].trim().split(/\s+/).map(Number);
  return { rx: v[0], tx: v[8] };
};
const errorKinds = (from) => {
  const kinds = {};
  try {
    const size = statSync(errorLog).size;
    if (size <= from) return { kinds, size };
    const text = readFileSync(errorLog, 'utf8').slice(from);
    for (const line of text.split('\n')) {
      if (!line) continue;
      const kind =
        line.match(
          /worker_connections are not enough|limiting connections|limiting requests|upstream timed out|Connection refused|Too many open files|prematurely closed|reset by peer/,
        )?.[0] ?? 'other';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    return { kinds, size };
  } catch {
    return { kinds, size: from };
  }
};
const token = readFileSync('/etc/plaza/router.env', 'utf8')
  .match(/PLAZA_METRICS_TOKEN=(.*)/)?.[1]
  ?.trim();
let cpu0 = cpuLines(),
  procs0 = new Map(processes().map((p) => [p.pid, p.cpu])),
  net0 = net(),
  at0 = Date.now(),
  logAt = (() => {
    try {
      return statSync(errorLog).size;
    } catch {
      return 0;
    }
  })();
async function sample() {
  const at = Date.now(),
    seconds = (at - at0) / 1000,
    cpu1 = cpuLines(),
    procs = processes(),
    n = net(),
    mem = readFileSync('/proc/meminfo', 'utf8'),
    available = Number(mem.match(/MemAvailable:\s+(\d+)/)[1]) * 1024,
    { kinds, size } = errorKinds(logAt);
  logAt = size;
  let sockets = -1;
  try {
    sockets =
      execFileSync('ss', ['-Htn', 'state', 'established', '( sport = :443 )'], { encoding: 'utf8' }).split('\n')
        .length - 1;
  } catch {
    // no ss: leave it at -1
  }
  let metrics;
  try {
    const res = await fetch('http://127.0.0.1:8790/metrics', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1500),
    });
    metrics = await res.json();
  } catch (error) {
    metrics = { error: error.message };
  }
  appendFileSync(
    out,
    `${JSON.stringify({
      at,
      cores: cpu1.map((c, i) => {
        const total = c.total - cpu0[i].total;
        return {
          busy: Math.round((1 - (c.idle - cpu0[i].idle) / Math.max(1, total)) * 1000) / 1000,
          steal: Math.round(((c.steal - cpu0[i].steal) / Math.max(1, total)) * 1000) / 1000,
        };
      }),
      availableMB: Math.round(available / 2 ** 20),
      txMbit: Math.round(((n.tx - net0.tx) * 8) / seconds / 1e4) / 100,
      rxMbit: Math.round(((n.rx - net0.rx) * 8) / seconds / 1e4) / 100,
      sockets443: sockets,
      procs: procs.map((p) => ({
        role: p.role,
        cores: Math.round(((p.cpu - (procs0.get(p.pid) ?? p.cpu)) / tick / seconds) * 1000) / 1000,
        rssMB: Math.round(p.rss / 2 ** 20),
        files: p.files,
      })),
      errors: kinds,
      metrics,
    })}\n`,
  );
  cpu0 = cpu1;
  procs0 = new Map(procs.map((p) => [p.pid, p.cpu]));
  net0 = n;
  at0 = at;
}
for (;;) {
  await new Promise((done) => setTimeout(done, 2000));
  await sample();
}
