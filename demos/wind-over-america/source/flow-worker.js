import { streamGeometry } from './flow.js';

self.onmessage = ({ data: { archive, opening } }) => {
  const indices = [opening, ...archive.keys()].filter((index, at) => at === 0 || index !== opening);
  for (const index of indices) self.postMessage({ index, frame: streamGeometry(archive[index]) });
};
