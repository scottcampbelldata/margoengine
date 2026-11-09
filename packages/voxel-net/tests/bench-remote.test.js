import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { hold, serve } from '../bench/long-hold.mjs';
import {
  mergeMetrics,
  parseMetricsUrls,
  parseSteps,
  parseTarget,
  summarizeCloses,
  summarizeSamples,
} from '../bench/remote-args.mjs';
import { acceptWebSocket, connectWebSocket } from '../dist/server.js';

test('parseTarget: no path is the router, a path is one shard', () => {
  assert.deepEqual(parseTarget('wss://a.example'), { join: 'https://a.example/join', origin: 'https://a.example' });
  assert.deepEqual(parseTarget('https://a.example/'), { join: 'https://a.example/join', origin: 'https://a.example' });
  assert.deepEqual(parseTarget('ws://127.0.0.1:9/'), { join: 'http://127.0.0.1:9/join', origin: 'http://127.0.0.1:9' });
  assert.deepEqual(parseTarget('wss://a.example/s/1', 'https://b.example'), {
    direct: 'wss://a.example/s/1',
    origin: 'https://b.example',
  });
  assert.throws(() => parseTarget('ftp://a.example'), TypeError);
});

test('parseSteps: both forms, and bad plans refused', () => {
  assert.deepEqual(parseSteps({ steps: '100@1.7:120, 300@3.3:60' }), [
    { count: 100, joinRate: 1.7, window: 120 },
    { count: 300, joinRate: 3.3, window: 60 },
  ]);
  assert.deepEqual(parseSteps({ counts: [25, 50], joinRate: 3, window: 300 }), [
    { count: 25, joinRate: 3, window: 300 },
    { count: 50, joinRate: 3, window: 300 },
  ]);
  assert.throws(() => parseSteps({ steps: '100@fast:120' }), RangeError);
  assert.throws(() => parseSteps({ steps: '100@0:120' }), RangeError);
  assert.throws(() => parseSteps({ steps: '100@1:1,50@1:1' }), /must not fall/);
});

const sample = (at, p95, perSecond = 20, online = 10) => ({
  at,
  shards: [{ index: 0, online, ticks: { p50: p95 / 2, p95, max: p95 + 1, perSecond }, bytesOut: 1000, rss: 2 ** 20 }],
});

test('summarizeSamples leaves out samples whose 60 s window reaches into the step before', () => {
  const s = summarizeSamples([
    sample(0, 500),
    sample(59_000, 500),
    sample(60_000, 10),
    sample(62_000, 20),
    sample(64_000, 30),
  ]);
  assert.equal(s.shards[0].tickP95, 20);
  assert.equal(s.shards[0].tickP95Worst, 30);
  assert.equal(s.inBudget, true);
});

test('summarizeSamples budget: p95 over 50 ms or under 19.5 ticks a second fails, an empty shard does not count', () => {
  assert.equal(summarizeSamples([sample(0, 51)], 0).inBudget, false);
  assert.equal(summarizeSamples([sample(0, 40, 19)], 0).inBudget, false);
  assert.equal(summarizeSamples([sample(0, 40, 19.5)], 0).inBudget, true);
  const two = sample(0, 10);
  two.shards.push({ index: 1, online: 0, ticks: { p50: 90, p95: 90, max: 90, perSecond: 20 } });
  assert.equal(summarizeSamples([two], 0).inBudget, true);
  assert.equal(summarizeSamples([sample(0, 10, 20, 0)], 0).inBudget, false);
});

test('connectWebSocket refuses other protocols and a pong reaches onpong', async () => {
  await assert.rejects(connectWebSocket('http://127.0.0.1:1'), /ws:\/\/ or wss:\/\//);
  const server = createServer();
  server.on('upgrade', (req, socket, head) => acceptWebSocket(req, socket, head));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const conn = await connectWebSocket(`ws://127.0.0.1:${server.address().port}`),
    pong = new Promise((done) => {
      conn.onpong = done;
    });
  conn.ping();
  await pong;
  conn.close();
  server.closeAllConnections();
  server.close();
});

test('summarizeCloses counts causes and gives the ages, so a wait for an age shows', () => {
  assert.deepEqual(summarizeCloses([]), { closed: 0, byCause: {}, ageSeconds: null });
  assert.deepEqual(
    summarizeCloses([
      { code: 1006, reason: 'socket ended', age: 902.4 },
      { code: 1006, reason: 'socket ended', age: 1500 },
      { code: 1008, reason: 'client-silent', age: 1100 },
    ]),
    {
      closed: 3,
      byCause: { '1006 socket ended': 2, '1008 client-silent': 1 },
      ageSeconds: { youngest: 902, median: 1100, oldest: 1500 },
    },
  );
});

// What the Plaza closes looked like from a bot: the far end stops with no close frame. The hold must report it as a 1006
// with its age and still count who stayed, or the check could not tell a path that cuts connections from one that does not.
test('long-hold reports a connection cut with no close frame, and the ones still held', async () => {
  const ends = [],
    sockets = [],
    server = await serve({ port: 0, log: (line) => ends.push(line) });
  server.on('upgrade', (_, socket) => sockets.push(socket));
  const lines = [],
    summary = hold({
      url: `ws://127.0.0.1:${server.address().port}/s`,
      count: 3,
      mode: 'busy',
      seconds: 1,
      joinMs: 10,
      log: (line) => lines.push(line),
    });
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(sockets.length, 3);
  sockets[1].end();
  const result = await summary;
  assert.equal(result.closed, 1);
  assert.deepEqual(result.byCause, { '1006 socket ended': 1 });
  assert.equal(result.held, 2);
  assert.equal(result.failed, 0);
  assert.match(lines[0], /^close 1006 socket ended age \d+ s at /);
  server.closeAllConnections();
  server.close();
  assert.match(ends[0], /^end 1006 socket \w+ busy age \d+ s at /);
});

test('--metrics: a comma list is several boxes, and their shards stay apart in one summary', () => {
  assert.deepEqual(parseMetricsUrls(undefined), []);
  assert.deepEqual(parseMetricsUrls('https://a.example/metrics'), ['https://a.example/metrics']);
  assert.deepEqual(parseMetricsUrls('https://a.example/metrics, https://b.example/metrics,'), [
    'https://a.example/metrics',
    'https://b.example/metrics',
  ]);

  const one = { at: 5, load: 1, counters: { online: 9 }, shards: [{ index: 0, online: 9 }] };
  assert.equal(mergeMetrics([one]), one, 'one box passes through untouched');

  // The first box's counters already add the second's: the sum comes from the shards, not from those counters.
  const a = { ...sample(1000, 10, 20, 7), load: 2, counters: { online: 12 } },
    b = { ...sample(9000, 40, 20, 5), load: 3, counters: { online: 5 } },
    merged = mergeMetrics([a, b]);
  assert.equal(merged.at, 1000);
  assert.equal(merged.load, 3);
  assert.equal(merged.counters.online, 12);
  assert.deepEqual(
    merged.shards.map((shard) => shard.index),
    [0, 100],
  );
  const summary = summarizeSamples([merged], 0);
  assert.deepEqual(
    summary.shards.map((shard) => [shard.index, shard.players, shard.tickP95]),
    [
      [0, 7, 10],
      [100, 5, 40],
    ],
  );
  assert.equal(summary.inBudget, true);
  assert.equal(
    summarizeSamples([mergeMetrics([a, sample(9000, 51)])], 0).inBudget,
    false,
    'either box over budget fails',
  );

  // A box stopped mid-hold: the other's numbers stay, under the same index.
  const without = mergeMetrics([undefined, b]);
  assert.equal(without.at, 9000);
  assert.deepEqual(
    without.shards.map((shard) => shard.index),
    [100],
  );
});
