import { buildSculpture } from './sculpture.js';

try {
  const {shape,stats}=buildSculpture();
  self.postMessage({shape,stats},Object.values(shape).map(a=>a.buffer));
} catch(error) {
  self.postMessage({error:error.message??String(error)});
}
