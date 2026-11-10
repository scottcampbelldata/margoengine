import { createHash } from 'node:crypto';
import { AudioListener, PositionalAudio } from '../dist/index.js';
import { FakeAudioContext, FakeParam } from './fake-web-audio.js';

export function audioReplay() {
  const hash = createHash('sha256');
  let iterators = 0, events = 0;
  for (const [state, smoothing] of [['suspended', 0.015], ['running', 0.015], ['running', 0]]) {
    const context = new FakeAudioContext({ state });
    const listener = new AudioListener({ context, smoothing, autoResume: false });
    const sources = Array.from({ length: 128 }, () => new PositionalAudio(listener));
    const count = (array) => {
      const iterate = array[Symbol.iterator];
      array[Symbol.iterator] = function () { iterators++; return iterate.call(this); };
    };
    for (const array of [listener.position, listener.forward, listener.up]) count(array);
    for (const source of sources) for (const array of [source.worldPosition, source.worldDirection]) count(array);
    // A changing clock detects accidental currentTime hoisting or reordered scheduling.
    let time = 0;
    Object.defineProperty(context, 'currentTime', { get: () => (time += 1 / 48000) });
    const flush = (node) => {
      for (const value of Object.values(node)) if (value instanceof FakeParam) {
        for (const event of value.events) {
          hash.update(event[0]);
          const numbers = new Float64Array(event.slice(1));
          hash.update(Buffer.from(numbers.buffer));
          events++;
        }
        value.events.length = 0;
        hash.update(Buffer.from(new Float64Array([value.value, value.target ?? 0]).buffer));
      }
    };
    for (let k = 0; k < 100; k++) {
      const angle = k * 0.005;
      listener.setPose([Math.cos(angle) * 2, 1.6, Math.sin(angle) * 2], [-Math.cos(angle), 0, -Math.sin(angle)]);
      flush(context.listener);
      for (let j = 0; j < sources.length; j++) {
        const a = j * 0.098 + k * 0.01;
        sources[j].setPosition(Math.cos(a) * (5 + j % 8), 1 + j % 4 * 0.5, Math.sin(a) * (5 + j % 8));
        sources[j].setDirection([-Math.sin(a), 0, Math.cos(a)]);
        flush(sources[j].panner);
        hash.update(Buffer.from(sources[j].worldPosition.buffer));
        hash.update(Buffer.from(sources[j].worldDirection.buffer));
      }
    }
    listener.dispose();
  }
  return { hash: hash.digest('hex'), iterators, events };
}
