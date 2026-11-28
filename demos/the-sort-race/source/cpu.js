import { COUNT, inspect, valueAt } from './input.mjs';

let input;
self.onmessage = ({ data }) => {
  try {
    if (data.phase === 'prepare') {
      input = new Uint32Array(COUNT);
      for (let index = 0; index < input.length; index++) input[index] = valueAt(index, data.seed);
      const keys = input.slice();
      self.postMessage({ keys }, [keys.buffer]);
      return;
    }
    if (data.phase === 'cpu') {
      const start = performance.now();
      input.sort();
      const ms = performance.now() - start;
      const { preview } = inspect(input);
      input = undefined;
      self.postMessage({ ms, preview }, [preview.buffer]);
      return;
    }
    const { histogram, preview } = inspect(data.keys);
    self.postMessage({ histogram, preview }, [histogram.buffer, preview.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
