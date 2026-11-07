// Writes numbered 1 MB saves through safeStorage over real files until it is killed; tests/safe.test.js does the killing.
// Prints each number once its write has returned. A save's first four bytes are its number, the rest follow from it.
import { fileStorage } from '../dist/node.js';
import { safeStorage } from '../dist/safe.js';

const [folder, first] = process.argv.slice(2),
  storage = safeStorage(fileStorage(folder), { verify: false }),
  save = new Uint8Array(1 << 20);
for (let number = Number(first); ; number++) {
  new DataView(save.buffer).setUint32(0, number);
  for (let i = 4; i < save.length; i++) save[i] = (number + i) & 255;
  await storage.write('game', save);
  process.stdout.write(`${number}\n`);
}
