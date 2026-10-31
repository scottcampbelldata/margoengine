// The pure parts of the real network bench (remote.mjs): where to join, the step plan, and what /metrics samples add
// up to. Tested in tests/bench-remote.test.js.

/**
 * Where bots go. A URL with no path is the router: each bot asks `<origin>/join` as the page does. A URL with a path is
 * one shard, joined directly. `origin` is the page origin the bots send, the same host unless `--origin` says otherwise.
 * @throws TypeError on a protocol other than ws, wss, http or https.
 */
export function parseTarget(url, origin) {
  const u = new URL(url);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(u.protocol))
    throw new TypeError(`--url=${url}: pass a ws://, wss://, http:// or https:// URL`);
  const secure = u.protocol === 'wss:' || u.protocol === 'https:',
    web = `${secure ? 'https' : 'http'}://${u.host}`,
    ws = `${secure ? 'wss' : 'ws'}://${u.host}`;
  if (u.pathname !== '/' && u.pathname !== '') return { direct: ws + u.pathname + u.search, origin: origin ?? web };
  return { join: `${web}/join`, origin: origin ?? web };
}

/**
 * The plan: `--steps=100@1.7:120,300@3.3:120` is 100 players in total joining at 1.7 a second, held 120 s, then 300 in
 * total at 3.3 a second, held 120 s. Without steps, `counts` at `joinRate`, each held `window` seconds.
 * @throws RangeError on a step that does not parse or a count that falls. An equal count holds with nobody added: a
 * machine at its share does that while another bot machine goes on rising.
 */
export function parseSteps({ steps, counts, joinRate, window }) {
  const list = steps
    ? steps.split(',').map((text) => {
        const m = text.trim().match(/^(\d+)@(\d+(?:\.\d+)?):(\d+)$/);
        if (!m) throw new RangeError(`Step "${text}" is not count@joinsPerSecond:seconds, such as 100@1.7:120`);
        return { count: Number(m[1]), joinRate: Number(m[2]), window: Number(m[3]) };
      })
    : counts.map((count) => ({ count, joinRate, window }));
  list.forEach((step, i) => {
    if (!(step.count > 0) || !(step.joinRate > 0) || !(step.window > 0))
      throw new RangeError(`Step ${i + 1} needs a count, a join rate and a hold above 0`);
    if (i && step.count < list[i - 1].count)
      throw new RangeError(
        `Step ${i + 1}: counts are totals and must not fall (${list[i - 1].count} then ${step.count})`,
      );
  });
  return list;
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};

/**
 * One step's numbers per shard from /metrics samples. A sample's p50, p95 and max cover the shard's last 60 s, so
 * samples earlier than `settleMs` into the hold (default 60 s) still hold ticks of the step before and are left out,
 * unless that would leave none. Budget: p95 of tick work at most 50 ms and 19.5 or more ticks a second.
 */
export function summarizeSamples(samples, settleMs = 60_000) {
  const first = samples[0]?.at ?? 0,
    settled = samples.filter((s) => s.at - first >= settleMs),
    used = settled.length ? settled : samples,
    byShard = new Map();
  for (const sample of used)
    for (const shard of sample.shards ?? []) {
      if (!byShard.has(shard.index)) byShard.set(shard.index, []);
      byShard.get(shard.index).push({ ...shard, at: sample.at });
    }
  const shards = [...byShard.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, list]) => {
      const live = list.filter((s) => s.ticks),
        perSecond = live.map((s) => s.ticks.perSecond).filter((v) => v !== undefined),
        ticksPerSecond = perSecond.length ? perSecond.reduce((a, v) => a + v, 0) / perSecond.length : null,
        p95 = median(live.map((s) => s.ticks.p95));
      return {
        index,
        players: median(list.map((s) => s.online ?? 0)),
        tickP50: median(live.map((s) => s.ticks.p50)),
        tickP95: p95,
        tickP95Worst: live.length ? Math.max(...live.map((s) => s.ticks.p95)) : null,
        tickMax: live.length ? Math.max(...live.map((s) => s.ticks.max)) : null,
        ticksPerSecond,
        ticksPerSecondWorst: perSecond.length ? Math.min(...perSecond) : null,
        bytesOutPerSecond: median(live.map((s) => s.bytesOut ?? 0)),
        bytesInPerSecond: median(live.map((s) => s.bytesIn ?? 0)),
        correctionsPerSecond: live.length ? live.reduce((a, s) => a + (s.corrections ?? 0), 0) / live.length : 0,
        rssMB: median(live.map((s) => (s.rss ?? 0) / 2 ** 20)),
        crashes: Math.max(0, ...list.map((s) => s.crashes ?? 0)),
        inBudget: p95 !== null && p95 <= 50 && ticksPerSecond !== null && ticksPerSecond >= 19.5,
      };
    });
  const busy = shards.filter((s) => s.players > 0);
  return { shards, inBudget: busy.length > 0 && busy.every((s) => s.inBudget) };
}

/**
 * How connections ended, from `{ code, reason, age }` (age in seconds): the count by code and reason, and the youngest,
 * median and oldest age. Whether closes wait for an age is what tells a path's timer from load.
 */
export function summarizeCloses(closes) {
  const byCause = {},
    ages = closes.map((close) => close.age);
  for (const { code, reason } of closes) byCause[`${code} ${reason}`] = (byCause[`${code} ${reason}`] ?? 0) + 1;
  return {
    closed: closes.length,
    byCause,
    ageSeconds: ages.length
      ? {
          youngest: Math.round(Math.min(...ages)),
          median: Math.round(median(ages)),
          oldest: Math.round(Math.max(...ages)),
        }
      : null,
  };
}
