import { readFile, writeFile } from 'node:fs/promises';
import { parseShot } from '../../tools/shot/shot-file.mjs';
import { openShotPage } from '../../tools/shot/render.mjs';

const configs = {
  'horse-at-the-ridge': async (page) => {
    const beats = await page.evaluate(() => window.showcase.hoofbeats());
    if (beats.length < 150 || beats.some(([t]) => t > 24 && t < 31)) {
      throw Error('Hoofbeat schedule does not match the film');
    }
    const walk = beats.filter(([t]) => t >= 2 && t < 3);
    if (walk.map(([, hoof]) => hoof).join(',') !== '1,2,3,0') {
      throw Error('The walk must land in four separate beats.');
    }
    const trot = new Map();
    for (const [time, hoof] of beats.filter(([t]) => t >= 45 && t < 47)) {
      const pair = trot.get(time) ?? [];
      pair.push(hoof);
      trot.set(time, pair);
    }
    if (trot.size < 4 || [...trot.values()].some((pair) => !['0,3', '1,2'].includes(pair.join(',')))) {
      throw Error('The trot must land in alternating diagonal pairs.');
    }
    await writeFile('test-results/showcase-12-15-inputs/hoofbeats.json', JSON.stringify(beats));
    console.log('Recorded', beats.length, 'hoof contacts from the ridge performance.');
  },
  'opening-night': async (page) => {
    const counts = await page.evaluate(async () => {
      const scene = window.showcase;
      const sampled = [];
      for (const time of [0, 20, 40, 60, 79.5]) {
        scene.apply({ time });
        sampled.push({ time, arrived: scene.entrants(), total: scene.visitors() });
      }
      return sampled;
    });
    if (counts[0].arrived !== 0 || counts.at(-1).arrived < 60) {
      throw Error('Arrivals did not progress through the entrances: ' + JSON.stringify(counts));
    }
    console.log(JSON.stringify(counts));
  },
};

const film = process.argv[2];
if (!Object.hasOwn(configs, film)) throw Error('Choose horse-at-the-ridge or opening-night.');
const file = JSON.parse(await readFile(`examples/showcase-films/${film}.shot.json`, 'utf8'));
file.shot.size = [640, 360];
const shot = parseShot(file);
const browser = await openShotPage(shot);
try {
  const origin = `http://127.0.0.1:${browser.server.config.server.port}`;
  const url = new URL(shot.shot.page.path, origin);
  url.search = new URLSearchParams({ ...shot.shot.page.query, quality: shot.shot.tier });
  await browser.page.goto(url.href, { waitUntil: 'load', timeout: 35_000 });
  await browser.page.waitForFunction(() => Boolean(window.showcase), null, { timeout: 25_000, polling: 100 });
  await configs[film](browser.page);
} finally {
  await browser.close();
}
