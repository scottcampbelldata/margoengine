import { describeGallery } from './art.js';

const description=describeGallery();
const geometries=[...description.gallery.map(part=>part.geometry),
  ...description.rooms.flatMap(room=>room.map(part=>part.geometry)),...description.apertures];
self.postMessage(description,geometries.flatMap(geometry=>Object.values(geometry).map(value=>value.buffer)));
