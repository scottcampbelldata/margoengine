import test from 'node:test';
import assert from 'node:assert/strict';
import { openWebSocket } from '../dist/websocket.js';
import { dataChannelConnection } from '../dist/webrtc.js';

// KB-NETCODE-LISTENERS1: a closed WebSocket or data-channel connection left its message and close listeners on the socket
// or channels (found by the netcode owner/lifetime fixture).
class Target extends EventTarget {
  live = new Set();
  get count() {
    return this.live.size;
  }
  addEventListener(type, listener, options) {
    this.live.add(listener);
    super.addEventListener(
      type,
      options?.once ? (event) => (this.live.delete(listener), listener(event)) : listener,
      options,
    );
  }
  removeEventListener(type, listener, options) {
    this.live.delete(listener);
    super.removeEventListener(type, listener, options);
  }
}
class FakeSocket extends Target {
  readyState = 0;
  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    });
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

for (const how of ['close()', 'the far end closing']) {
  test(`openWebSocket: a connection closed by ${how} leaves no listener on its socket`, async () => {
    let socket;
    const connection = await openWebSocket('ws://x', {
      WebSocket: class extends FakeSocket {
        constructor() {
          super();
          socket = this;
        }
      },
    });
    assert.equal(socket.count, 2, 'a live connection listens for messages and the close');
    if (how === 'close()') connection.close();
    else socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }));
    assert.equal(socket.count, 0);
    assert.equal(connection.open, false);
  });
}

for (const how of ['close()', 'a channel closing']) {
  test(`dataChannelConnection: a connection closed by ${how} leaves no listener on its channels`, () => {
    const channel = () =>
      Object.assign(new Target(), {
        readyState: 'open',
        binaryType: 'blob',
        send() {},
        close() {
          this.readyState = 'closed';
          queueMicrotask(() => this.dispatchEvent(new Event('close')));
        },
      });
    const reliable = channel(),
      unreliable = channel(),
      connection = dataChannelConnection({ reliable, unreliable });
    let closed = 0;
    connection.onclose = () => closed++;
    assert.equal(reliable.count + unreliable.count, 4);
    if (how === 'close()') connection.close();
    else reliable.dispatchEvent(new Event('close'));
    assert.equal(reliable.count + unreliable.count, 0);
    assert.equal(closed, 1);
    assert.equal(unreliable.readyState, 'closed', 'the other channel closes with it');
  });
}
