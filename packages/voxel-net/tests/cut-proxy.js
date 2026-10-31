// A TCP proxy for the resume tests: it cuts or stalls its connections in the ways a network does.
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';

export const wait = (ms) => new Promise((done) => setTimeout(done, ms));

/** Waits for `check()` to give something true, and gives it. */
export async function until(what, check, ms = 20_000) {
  const end = performance.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    assert.ok(performance.now() < end, `timed out waiting for ${what}`);
    await wait(5);
  }
}

/** Proxies to `port` on loopback. Starts listening on any free port, given as `port`. */
export async function cutProxy(port) {
  const pairs = new Set(),
    server = createServer((down) => {
      const up = connect(port, '127.0.0.1'),
        pair = { down, up, dropDown: false, frozen: false };
      pairs.add(pair);
      up.setNoDelay(true);
      down.setNoDelay(true);
      down.on('data', (data) => pair.frozen || up.write(data));
      up.on('data', (data) => pair.frozen || pair.dropDown || down.write(data));
      for (const [a, b] of [
        [down, up],
        [up, down],
      ]) {
        a.on('end', () => pair.frozen || b.end());
        a.on('close', () => {
          if (pair.frozen) return; // the other end stays open until close()
          pairs.delete(pair);
          b.destroy();
        });
        a.on('error', () => {});
      }
    });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    port: server.address().port,
    /** How many connections it carries. */
    get open() {
      return pairs.size;
    },
    /** FIN to both ends of every connection, as Cloudflare does. */
    cut() {
      for (const pair of pairs) {
        pair.down.end();
        pair.up.end();
      }
    },
    /** From now on, what the server writes is lost; what the client sends still arrives. */
    dropDown() {
      for (const pair of pairs) pair.dropDown = true;
    },
    /** Nothing moves either way and both sockets stay open: a half-open connection. */
    freeze() {
      for (const pair of pairs) pair.frozen = true;
    },
    /** Ends every connection at once with no goodbye, and keeps listening. */
    kill() {
      for (const pair of pairs) {
        pair.frozen = false;
        pair.down.destroy();
        pair.up.destroy();
      }
    },
    /** Lets go of everything. */
    close() {
      for (const pair of pairs) {
        pair.down.destroy();
        pair.up.destroy();
      }
      server.close();
    },
  };
}
