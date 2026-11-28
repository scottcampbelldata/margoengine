import { streamGeometry } from './flow.js';

self.onmessage = ({ data: { archive, opening } }) => {
  const indices = [opening, ...archive.keys()].filter((index, at) => at === 0 || index !== opening);
  for (const index of indices) {
    const frame = streamGeometry(archive[index]);
    self.postMessage({ index, frame }, [frame.vertices.buffer]);
  }
};

