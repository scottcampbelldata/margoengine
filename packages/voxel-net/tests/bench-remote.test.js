import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { parseSteps, parseTarget, summarizeSamples } from '../bench/remote-args.mjs';
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
