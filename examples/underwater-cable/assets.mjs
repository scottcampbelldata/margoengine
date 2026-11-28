import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const cdn = 'https://dl.polyhaven.org/file/ph-assets';
const sand = 'Textures/jpg/1k/coast_sand_02/coast_sand_02_';
const metal = 'Textures/jpg/1k/rusty_metal_04/rusty_metal_04_';
const rock = 'Models/jpg/1k/coast_rocks_05/coast_rocks_05_';
const scans = [
  ['overcast-sky.hdr', 'HDRIs/hdr/2k/overcast_soil_puresky_2k.hdr', '877caf0680d7269037995f6567a67103'],
  ['sand.jpg', sand + 'diff_1k.jpg', '854479f7ceea9f940275f6733453600a'],
  ['sand-normal.jpg', sand + 'nor_gl_1k.jpg', 'ab2f0168551ddb91350654d620a16be7'],
  ['sand-arm.jpg', sand + 'arm_1k.jpg', '006ca9118eceeae02d1850944e44830b'],
  ['steel.jpg', metal + 'diff_1k.jpg', '91832efd8e5896387e2af18a5b49b895'],
  ['steel-normal.jpg', metal + 'nor_gl_1k.jpg', '25f7f28b3546391532a5567b86e65aeb'],
  ['steel-arm.jpg', metal + 'arm_1k.jpg', '279a6d62861e32e4ee43cce84b932e43'],
  [
    'coast_rocks_05_1k.gltf',
    'Models/gltf/1k/coast_rocks_05/coast_rocks_05_1k.gltf',
    '4d4e9186fe053d2385913fd2bf7eddd9',
  ],
  ['coast_rocks_05.bin', 'Models/gltf/8k/coast_rocks_05/coast_rocks_05.bin', '9d4e639dd13128e96335a5d9828b3f47'],
  ['textures/coast_rocks_05_diff_1k.jpg', rock + 'diff_1k.jpg', 'f2b66bad46855efa031e21aa392f4349'],
  ['textures/coast_rocks_05_nor_gl_1k.jpg', rock + 'nor_gl_1k.jpg', 'e5f4c65b6fafd54885044cb25a783265'],
  ['textures/coast_rocks_05_arm_1k.jpg', rock + 'arm_1k.jpg', 'e1254e9d26745f5d06e7a266a1231360'],
];

const models = [
  [
    'survey-submarine.glb',
    'https://files.innerscene.com/library/nuclear-style-submarine-3ed81485/574bf2db44f1632ef47c/nuclear-style-submarine.glb',
    '785415d1346171bcc65a7231c964a27810f673db0da235e77656303b9cfd159f',
  ],
  [
    'diver-head.glb',
    'https://grab3d.com/dl/human-head/human-head-light.glb',
    '1a525e9bf4aeccdd6b13ac3080217901ba1ab05d3a268392b8cf5d844b79577c',
  ],
];
const downloads = [...scans.map(([name, path, md5]) => [name, cdn + '/' + path, md5]), ...models];
const hash = (bytes, digest) =>
  createHash(digest.length === 64 ? 'sha256' : 'md5')
    .update(bytes)
    .digest('hex');
const vesselHash = 'a08273a9aa105c491b28b9ae417f081832e081c3530a0fb05dcc983c1fe39495';
const vessel = await readFile(new URL('./assets/tripo-vessel.glb', import.meta.url)).catch((error) => {
  if (error.code !== 'ENOENT') throw error;
  throw new Error('Copy the Tripo vessel export to examples/underwater-cable/assets/tripo-vessel.glb');
});
if (hash(vessel, vesselHash) !== vesselHash) throw new Error('tripo-vessel.glb: asset checksum mismatch');
await mkdir(new URL('./assets/textures/', import.meta.url), { recursive: true });
await Promise.all(
  downloads.map(async ([name, url, digest]) => {
    const target = new URL('./assets/' + name, import.meta.url);
    const cached = await readFile(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (cached && hash(cached, digest) === digest) return;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(name + ': HTTP ' + response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (hash(bytes, digest) !== digest) throw new Error(name + ': asset checksum mismatch');
    await writeFile(target, bytes);
    console.log(name);
  }),
);
