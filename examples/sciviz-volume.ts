// Volume demo: a 160^3 scalar field (nested, wobbling shells plus three bright blobs) computed on the GPU with fused
// @margoengine/compute expressions, uploaded to the volume's 3D texture on the GPU, ray-marched by sciviz. The
// controls switch composite and maximum-intensity modes, colour maps, a clip plane, a slice and a GPU isosurface.
import { createCompute } from '@margoengine/compute';
import {
  Figure,
  type ColormapName,
  type IsosurfaceLayer,
  type SliceLayer,
  type VolumeLayer,
} from '@margoengine/sciviz/spec';

declare global {
  interface Window {
    volumeDemo?: { triangles: number };
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('viewport'),
  status = $<HTMLParagraphElement>('status');
const N = 160;

try {
  const figure = await Figure.create(canvas, {
    axes: true,
    aspect: [1, 1, 1],
    titles: { x: 'x (mm)', y: 'y (mm)', z: 'z (mm)' },
  });
  const gpu = await createCompute({ engine: figure.engine });
  const i = gpu.arange(0, N ** 3, 1, 'f32'),
    x = i
      .mod(N)
      .div(N - 1)
      .sub(0.5)
      .eval(),
    y = i
      .floorDiv(N)
      .mod(N)
      .div(N - 1)
      .sub(0.5)
      .eval(),
    z = i
      .floorDiv(N * N)
      .div(N - 1)
      .sub(0.5)
      .eval();
  i.dispose();
  const r = x.hypot(y).hypot(z).eval();
  const angle = y.atan2(x);
  // Shells whose radius wobbles with angle and height, fading outward, plus three Gaussian blobs.
  const shells = r
    .mul(28)
    .add(angle.mul(3).sin().mul(1.5))
    .add(z.mul(9).cos())
    .sin()
    .add(1)
    .mul(0.5)
    .mul(r.mul(-4).exp());
  const blob = (cx: number, cy: number, cz: number) =>
    x.sub(cx).square().add(y.sub(cy).square()).add(z.sub(cz).square()).mul(-160).exp();
  const field = shells
    .add(blob(0.18, 0.1, 0.12))
    .add(blob(-0.2, -0.05, -0.1))
    .add(blob(0.02, -0.22, 0.2))
    .eval()
    .reshape(N, N, N);
  for (const a of [x, y, z, r]) a.dispose();
  const range: [number, number] = [0, (await field.max().item()) || 1];
  const bounds: [number, number, number, number, number, number] = [-80, 80, -80, 80, -80, 80];
  let map: ColormapName = 'ember';
  const make = () =>
    figure.volume(field, {
      bounds,
      range,
      colormap: map,
      opacity: [
        [0, 0],
        [0.18, 0],
        [0.45, 0.25],
        [1, 0.9],
      ],
      density: 1.2,
      mode: $<HTMLSelectElement>('mode').value as 'composite' | 'mip',
    });
  let volume: VolumeLayer = make();
  let bar = figure.colorbar(map, range, { label: 'density' });
  let slice: SliceLayer | undefined;
  let iso: IsosurfaceLayer | undefined;
  let isoBusy: Promise<unknown> = Promise.resolve();
  const applyCut = () => {
    const v = Number($<HTMLInputElement>('cut').value);
    $<HTMLOutputElement>('cutOut').textContent = v === 100 ? 'off' : `${v}%`;
    volume.clip = v === 100 ? [] : [{ normal: [-1, 0, 0], offset: v / 100 }];
  };
  const applySlice = () => {
    const v = Number($<HTMLInputElement>('slice').value);
    $<HTMLOutputElement>('sliceOut').textContent = v ? `${v}%` : 'off';
    if (!v) {
      slice?.dispose();
      slice = undefined;
    } else if (slice) slice.position = v / 100;
    else slice = volume.slice('z', v / 100);
  };
  $<HTMLSelectElement>('mode').addEventListener(
    'change',
    () => (volume.mode = $<HTMLSelectElement>('mode').value as 'composite' | 'mip'),
  );
  $<HTMLSelectElement>('map').addEventListener('change', () => {
    map = $<HTMLSelectElement>('map').value as ColormapName;
    figure.remove(volume);
    slice = undefined;
    volume = make();
    applyCut();
    applySlice();
    bar.dispose();
    bar = figure.colorbar(map, range, { label: 'density' });
  });
  $<HTMLInputElement>('cut').addEventListener('input', applyCut);
  $<HTMLInputElement>('slice').addEventListener('input', applySlice);
  $<HTMLInputElement>('iso').addEventListener('change', () => {
    const v = Number($<HTMLInputElement>('iso').value),
      level = range[0] + ((range[1] - range[0]) * v) / 100;
    $<HTMLOutputElement>('isoOut').textContent = v ? level.toFixed(2) : 'off';
    isoBusy = isoBusy.then(async () => {
      if (!v) {
        if (iso) figure.remove(iso);
        iso = undefined;
        return;
      }
      if (iso) await iso.update(level);
      else iso = await figure.isosurface(field, level, { bounds, colormap: map, range });
      window.volumeDemo = { triangles: iso.triangles };
      status.textContent = `Isosurface at ${level.toFixed(2)}: ${iso.triangles.toLocaleString('en')} triangles extracted on the GPU.`;
    });
  });
  window.addEventListener('pagehide', () => figure.dispose(), { once: true });
  status.textContent = `${(N ** 3).toLocaleString('en')} voxels generated and ray-marched on the GPU.`;
  await figure.ready();
  canvas.dataset.ready = 'true';
} catch (error) {
  status.textContent = `Could not start: ${(error as Error).message}`;
}
