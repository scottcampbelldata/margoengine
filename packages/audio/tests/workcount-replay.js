import { createHash } from 'node:crypto';
import { AudioListener, PositionalAudio } from '../dist/index.js';
import { FakeAudioContext, FakeParam } from './fake-web-audio.js';

// A point on the unit circle from basic arithmetic only (the rational parametrisation with t = tan(a / 2) taken as
// a / 2), so the inputs are the same bits on every machine. Math.cos and Math.sin are not correctly rounded, and the
// x64 machine that first recorded the hash and an arm64 Mac disagree in the last bit of some of them.
const circle = (a) => {
  const t = a / 2,
    d = 1 + t * t;
  return [(1 - t * t) / d, (2 * t) / d];
};

export function audioReplay() {
  const hash = createHash('sha256');
  let iterators = 0,
    events = 0;
  for (const [state, smoothing] of [
    ['suspended', 0.015],
    ['running', 0.015],
    ['running', 0],
  ]) {
    const context = new FakeAudioContext({ state });
    const listener = new AudioListener({ context, smoothing, autoResume: false });
    const sources = Array.from({ length: 128 }, () => new PositionalAudio(listener));
    const count = (array) => {
      const iterate = array[Symbol.iterator];
      array[Symbol.iterator] = function () {
        iterators++;
        return iterate.call(this);
      };
    };
    for (const array of [listener.position, listener.forward, listener.up]) count(array);
    for (const source of sources) for (const array of [source.worldPosition, source.worldDirection]) count(array);
    // A changing clock detects accidental currentTime hoisting or reordered scheduling.
    let time = 0;
    Object.defineProperty(context, 'currentTime', { get: () => (time += 1 / 48000) });
    const flush = (node) => {
      for (const value of Object.values(node))
        if (value instanceof FakeParam) {
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
      const [c, s] = circle(angle);
      listener.setPose([c * 2, 1.6, s * 2], [-c, 0, -s]);
      flush(context.listener);
      for (let j = 0; j < sources.length; j++) {
        const a = j * 0.098 + k * 0.01;
        const [ca, sa] = circle(a);
        sources[j].setPosition(ca * (5 + (j % 8)), 1 + (j % 4) * 0.5, sa * (5 + (j % 8)));
        sources[j].setDirection([-sa, 0, ca]);
        flush(sources[j].panner);
        hash.update(Buffer.from(sources[j].worldPosition.buffer));
        hash.update(Buffer.from(sources[j].worldDirection.buffer));
      }
    }
    listener.dispose();
  }
  return { hash: hash.digest('hex'), iterators, events };
}
