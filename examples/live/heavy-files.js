// Every heavy example file. The live pages load `key` from ASSET_BASE.
// `bytes` is null when the file is not in the source commit, so its size is not known here.
// Regenerate examples/live/assets-manifest.json with: node examples/live/emit-manifest.mjs

const sourceCommit = '05c0eb827dc07c18dc9e2ad99e06ae962c10a896';

function missing(demo, key, source, note) {
  return {
    demo,
    key,
    source,
    sourceCommit,
    bytes: null,
    gitLfs: false,
    status: note,
  };
}

const gitignored = 'missing from the source commit (the assets folder is gitignored, not git-lfs)';
const absent = 'missing from the source commit (not git-lfs; the file was never committed)';

const firstWake = [
  ['quay-plain.glb', 'examples/first-wake/assets/quay-plain.glb'],
  ['quay-bollard.glb', 'examples/first-wake/assets/quay-bollard.glb'],
  ['port-crane.glb', 'examples/first-wake/assets/port-crane.glb'],
  ['port-office.glb', 'examples/first-wake/assets/port-office.glb'],
  ['port-warehouse.glb', 'examples/first-wake/assets/port-warehouse.glb'],
  ['cargo-container.glb', 'examples/first-wake/assets/cargo-container.glb'],
  ['concrete-color.jpg', 'examples/first-wake/assets/concrete-color.jpg'],
  ['concrete-normal.jpg', 'examples/first-wake/assets/concrete-normal.jpg'],
  ['concrete-orm.jpg', 'examples/first-wake/assets/concrete-orm.jpg'],
  ['dawn.hdr', 'examples/first-wake/assets/dawn.hdr'],
  ['survey-hull.glb', 'examples/first-wake/assets/survey-hull.glb'],
  ['survey-screw.glb', 'examples/first-wake/assets/survey-screw.glb'],
].map(([file, source]) => missing('first-wake', `first-wake/${file}`, source, gitignored));

const swellFiles = [
  'overcast-sky.hdr',
  'sand.jpg',
  'sand-normal.jpg',
  'sand-arm.jpg',
  'steel.jpg',
  'steel-normal.jpg',
  'steel-arm.jpg',
  'coast_rocks_05_1k.gltf',
  'coast_rocks_05.bin',
  'textures/coast_rocks_05_diff_1k.jpg',
  'textures/coast_rocks_05_nor_gl_1k.jpg',
  'textures/coast_rocks_05_arm_1k.jpg',
  'survey-submarine.glb',
  'diver-head.glb',
  'tripo-vessel.glb',
].map((file) =>
  missing(
    'below-the-swell',
    `below-the-swell/${file}`,
    `examples/underwater-cable/assets/${file}`,
    file.endsWith('.gltf')
      ? `${gitignored}. Keep this glTF and its bin and textures side by side so relative URIs resolve.`
      : gitignored,
  ),
);

const chicago = [
  'tiles/blackstone.jpg',
  'tiles/blackstone-annex.jpg',
  'tiles/spertus.jpg',
  'tiles/park-oaks.glb',
  'tiles/tileset.json',
  'tiles/grant-park.glb',
  'grant-park-naip.jpg',
].map((file) =>
  missing(
    'city-to-street',
    `city-to-street/${file}`,
    `test-results/four-demos-inputs/chicago/${file.replace('tiles/', 'tiles/')}`,
    file.endsWith('tileset.json')
      ? `${absent}. prepare-chicago-scan.py writes this tileset. grant-park.glb is the relative content URI, so it must sit in the same tiles folder.`
      : `${absent}. prepare-chicago-scan.py writes the Grant Park tiles and facade photos.`,
  ),
);

const cast = [
  'business_male_02',
  'business_female_01',
  'business_male_07',
  'business_female_03',
  'business_male_01',
  'business_female_02',
  'business_male_05',
  'business_female_04',
].flatMap((name) =>
  ['glb', 'png'].map((ext) =>
    missing(
      'opening-night',
      `opening-night/${name}.${ext}`,
      `test-results/showcase-12-15-inputs/${name}.${ext}`,
      absent,
    ),
  ),
);

export const heavyFiles = [
  {
    demo: 'last-tram',
    key: 'last-tram/industrial-buildings.glb',
    source: 'examples/showcase-films/assets/north-yard/industrial-buildings.glb',
    sourceCommit,
    bytes: 12258800,
    gitLfs: false,
    status: 'tracked blob on the source branch (not git-lfs). Left out of this branch because it is over 5 MB.',
  },
  ...firstWake,
  ...swellFiles,
  ...chicago,
  missing(
    'horse-at-the-ridge',
    'horse-at-the-ridge/ridge-bay-performance.glb',
    'test-results/showcase-12-15-inputs/ridge-bay-performance.glb',
    absent,
  ),
  missing(
    'horse-at-the-ridge',
    'horse-at-the-ridge/ridge-bay-performance.json',
    'test-results/showcase-12-15-inputs/ridge-bay-performance.json',
    absent,
  ),
  missing(
    'inside-a-meteorite',
    'inside-a-meteorite/sample.obj',
    'test-results/showcase-12-15-inputs/meteorite/sample.obj',
    absent,
  ),
  missing(
    'inside-a-meteorite',
    'inside-a-meteorite/volume.u8',
    'test-results/showcase-12-15-inputs/meteorite/volume.u8',
    `${absent}. prepare-meteorite-volume.py builds this grid from NASA PNG slices, which are also absent.`,
  ),
  missing(
    'inside-a-meteorite',
    'inside-a-meteorite/texture.jpg',
    'test-results/showcase-12-15-inputs/meteorite/texture.jpg',
    absent,
  ),
  ...cast,
  missing(
    'the-projectionist',
    'the-projectionist/projectionist.glb',
    'test-results/showcase-12-15-inputs/projectionist.glb',
    absent,
  ),
  missing(
    'the-solar-field',
    'the-solar-field/antelope.f32',
    'test-results/four-demos-inputs/solar-v2/antelope.f32',
    absent,
  ),
  missing(
    'the-solar-field',
    'the-solar-field/antelope.jpg',
    'test-results/four-demos-inputs/solar-v2/antelope.jpg',
    absent,
  ),
  missing(
    'the-scanned-workshop',
    'the-scanned-workshop/cactus.spz',
    'test-results/four-demos-inputs/studio/cactus.spz',
    absent,
  ),
  missing(
    'the-scanned-workshop',
    'the-scanned-workshop/plant.splat',
    'test-results/four-demos-inputs/studio/plant.splat',
    absent,
  ),
  missing(
    'the-scanned-workshop',
    'the-scanned-workshop/studio-garden.jpg',
    'test-results/four-demos-inputs/studio/studio-garden.jpg',
    absent,
  ),
];
