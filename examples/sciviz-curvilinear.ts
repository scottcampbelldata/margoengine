import { Figure } from '@margoengine/sciviz';
import { curvilinearVolume } from '@margoengine/sciviz/curvilinear';
import { element } from './sciviz-demo.js';
const signal = AbortSignal.timeout(120000);
async function data(name: string): Promise<Float32Array> {
  const r = await fetch(new URL(`./assets/sciviz/${name}.bin`, import.meta.url), { signal });
  if (!r.ok) throw new Error(`NOAA subset ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
}
async function metadata(name: string) {
  const r = await fetch(new URL(`./assets/sciviz/${name}.json`, import.meta.url), { signal });
  if (!r.ok) throw new Error(`NOAA metadata ${r.status}`);
  return r.json();
}
const [radarMeta, oceanMeta, radarData, radarPoints, oceanData] = await Promise.all([
  metadata('nexrad-curvilinear'),
  metadata('woa23-shell'),
  data('nexrad-curvilinear'),
  data('nexrad-curvilinear-points'),
  data('woa23-shell'),
]);
export const radar = await Figure.create(element<HTMLCanvasElement>('radar'), { axes: false, aspect: [1, 1, 0.45] });
export const ocean = await Figure.create(element<HTMLCanvasElement>('ocean'), { axes: false, aspect: [1, 1, 1] });
radar.engine.camera.position = [1.4, 1.7, 1.5];
ocean.engine.camera.position = [1.8, 1.1, 1.8];
export const radarVolume = curvilinearVolume(radar, { dims: radarMeta.dims, points: radarPoints }, radarData, {
  range: [-10, 75],
  colormap: 'inferno',
  opacity: [
    [0, 0],
    [0.3, 0],
    [0.6, 0.1],
    [1, 0.5],
  ],
  referenceStep: 2,
  quality: 1,
  shading: false,
});
export const oceanVolume = curvilinearVolume(ocean, oceanMeta, oceanData, {
  range: [-2, 32],
  colormap: 'aurora',
  opacity: () => 0.15,
  referenceStep: 0.01,
  quality: 1.5,
  shading: false,
});
const radarOutline = radarVolume.outline({ stride: 5 }),
  oceanOutline = oceanVolume.outline({ stride: 6 });
const radarSlice = radarVolume.slice(2, 2),
  oceanSlice = oceanVolume.slice(2, 9);
function update(): void {
  for (const v of [radarVolume, oceanVolume]) v.visible = element<HTMLInputElement>('volume').checked;
  for (const v of [radarOutline, oceanOutline]) v.visible = element<HTMLInputElement>('outline').checked;
  for (const v of [radarSlice, oceanSlice]) v.visible = element<HTMLInputElement>('slice').checked;
  radarSlice.index = Number(element<HTMLInputElement>('elevation').value);
  oceanSlice.index = Number(element<HTMLInputElement>('depth').value);
}
for (const id of ['volume', 'outline', 'slice', 'depth', 'elevation']) element(id).addEventListener('input', update);
update();
await Promise.all([radar.ready(), ocean.ready()]);
element('status').textContent =
  `Ready. ${radarMeta.finite} measured radar samples and ${oceanMeta.finite} ocean samples. Both use original node scalars, shared classifiers and coordinate slices.`;
window.addEventListener(
  'pagehide',
  () => {
    radar.dispose();
    ocean.dispose();
  },
  { once: true },
);
