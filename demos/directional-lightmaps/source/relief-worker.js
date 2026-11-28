import { buildRelief } from './relief.js';

const images=buildRelief();
self.postMessage(images,images.map(image=>image.data.buffer));
