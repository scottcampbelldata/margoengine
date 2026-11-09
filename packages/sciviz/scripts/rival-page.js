// One headless page: Figure.volume and VTK.js 38 take turns on the same 64-cube.
// Public VTK.js API (kitware.github.io/vtk-js, Volume, ImageData, Camera, VolumeMapper):
// the Volume profile, ImageData scalars, color and opacity transfer functions, sample distance.
// This file does not read VTK.js source.
import '@kitware/vtk.js/Rendering/Profiles/Volume';
import vtkColorTransferFunction from '@kitware/vtk.js/Rendering/Core/ColorTransferFunction';
import vtkFullScreenRenderWindow from '@kitware/vtk.js/Rendering/Misc/FullScreenRenderWindow';
import vtkImageData from '@kitware/vtk.js/Common/DataModel/ImageData';
import vtkPiecewiseFunction from '@kitware/vtk.js/Common/DataModel/PiecewiseFunction';
import vtkDataArray from '@kitware/vtk.js/Common/Core/DataArray';
import vtkVolume from '@kitware/vtk.js/Rendering/Core/Volume';
import vtkVolumeMapper from '@kitware/vtk.js/Rendering/Core/VolumeMapper';
import { Figure, colormap } from '@margoengine/sciviz';
import { BACKGROUND, N, ROUNDS, SIZE, fillVolume, sampleDistance, sceneSpacing } from './rival-data.js';

const waitStart = () =>
  new Promise((resolve) => {
    if (window.__startRival) resolve();
    else {
      const timer = setInterval(() => {
        if (window.__startRival) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    }
  });

const readPixels = async (canvas) => {
  const bitmap = await createImageBitmap(canvas);
  const out = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = out.getContext('2d', { willReadFrequently: true });
  g.drawImage(bitmap, 0, 0);
  bitmap.close();
  return g.getImageData(0, 0, out.width, out.height).data;
};

const backgroundByte = (channel) => Math.round(BACKGROUND[channel] * 255);

const painted = (pixels) => {
  const br = backgroundByte(0);
  const bg = backgroundByte(1);
  const bb = backgroundByte(2);
  let ink = 0;
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i] - br) > 2 || Math.abs(pixels[i + 1] - bg) > 2 || Math.abs(pixels[i + 2] - bb) > 2) ink += 1;
  }
  return ink / count;
};

const imageStats = (pixels) => {
  let sum = 0;
  for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
  return { sum, width: SIZE, ink: painted(pixels) };
};

const compare = (a, b) => {
  if (a.length !== b.length) throw new Error(`pixel length ${a.length} vs ${b.length}`);
  let sum = 0;
  let far = 0;
  const count = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    const d = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    sum += d;
    if (d > 8) far += 1;
  }
  return { mean: sum / count, far: far / count, pixels: count };
};

const requireFrame = (name, canvas, pixels) => {
  if (canvas.width !== SIZE || canvas.height !== SIZE)
    throw new Error(`${name} canvas is ${canvas.width}x${canvas.height}, expected ${SIZE}`);
  const ink = painted(pixels);
  if (ink < 0.01) throw new Error(`${name} frame is empty (ink ${ink})`);
  return pixels;
};

const run = async () => {
  await waitStart();
  const { data, sum } = fillVolume();
  const spacing = sceneSpacing();
  const distance = sampleDistance();
  const margoCanvas = document.querySelector('#margo');
  const fig = await Figure.create(margoCanvas, { axes: false, controls: false });
  fig.engine.stop();
  fig.volume(data, { dims: [N, N, N], range: [0, 1] });

  const host = document.querySelector('#vtk');
  const full = vtkFullScreenRenderWindow.newInstance({
    background: BACKGROUND,
    container: host,
    containerStyle: { width: `${SIZE}px`, height: `${SIZE}px`, position: 'relative' },
  });
  const renderer = full.getRenderer();
  const renderWindow = full.getRenderWindow();
  const image = vtkImageData.newInstance();
  image.setDimensions(N, N, N);
  image.setSpacing(spacing[0], spacing[1], spacing[2]);
  // Rows are the I, J, K directions (ImageData docs). Unit axes: data x to world +x,
  // data y to world -z, data z to world +y. Spacing carries the figure's aspect.
  image.setDirection(1, 0, 0, 0, 0, -1, 0, 1, 0);
  image.setOrigin(-1, -0.75, 1);
  if (image.computeTransforms) image.computeTransforms();
  const scalars = vtkDataArray.newInstance({ name: 'scalars', values: data, numberOfComponents: 1 });
  image.getPointData().setScalars(scalars);

  const actor = vtkVolume.newInstance();
  const mapper = vtkVolumeMapper.newInstance();
  mapper.setInputData(image);
  mapper.setSampleDistance(distance);
  mapper.setAutoAdjustSampleDistances(false);
  actor.setMapper(mapper);
  const colors = vtkColorTransferFunction.newInstance();
  const opacity = vtkPiecewiseFunction.newInstance();
  const map = colormap('aurora');
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    const rgb = map.sample(t);
    colors.addRGBPoint(t, rgb[0], rgb[1], rgb[2]);
    opacity.addPoint(t, t * t);
  }
  const property = actor.getProperty();
  property.setRGBTransferFunction(0, colors);
  property.setScalarOpacity(0, opacity);
  property.setScalarOpacityUnitDistance(0, (spacing[0] + spacing[1] + spacing[2]) / 3);
  property.setInterpolationTypeToLinear();
  property.setShade(true);
  renderer.addVolume(actor);
  const camera = renderer.getActiveCamera();
  camera.setPositionAndFocalPoint([2.6, 1.7, 2.9], [0, 0, 0]);
  camera.setViewUp(0, 1, 0);
  camera.setViewAngle(60);
  camera.setClippingRange(0.01, 100);
  renderer.resetCameraClippingRange();

  const vtkCanvas = host.querySelector('canvas');
  if (!vtkCanvas) throw new Error('VTK.js render window has no canvas');

  const frameMargo = async () => {
    const t0 = performance.now();
    fig.render();
    const pixels = requireFrame('margo', margoCanvas, await readPixels(margoCanvas));
    return { pixels, ms: performance.now() - t0 };
  };
  const frameVtk = async () => {
    const t0 = performance.now();
    renderWindow.render();
    const pixels = requireFrame('vtk', vtkCanvas, await readPixels(vtkCanvas));
    return { pixels, ms: performance.now() - t0 };
  };

  for (let i = 0; i < 2; i++) {
    await frameMargo();
    await frameVtk();
  }
  const roundsA = [];
  const roundsB = [];
  let lastA;
  let lastB;
  for (let i = 0; i < ROUNDS; i++) {
    if (i % 2 === 0) {
      lastA = await frameMargo();
      roundsA.push(lastA.ms);
      lastB = await frameVtk();
      roundsB.push(lastB.ms);
    } else {
      lastB = await frameVtk();
      roundsB.push(lastB.ms);
      lastA = await frameMargo();
      roundsA.push(lastA.ms);
    }
  }
  const delta = compare(lastA.pixels, lastB.pixels);
  window.__rival = {
    sum,
    bounds: image.getBounds(),
    sampleDistance: distance,
    spacing,
    margo: imageStats(lastA.pixels),
    vtk: imageStats(lastB.pixels),
    delta,
    minA: Math.min(...roundsA),
    minB: Math.min(...roundsB),
    roundsA,
    roundsB,
  };
  fig.dispose();
  full.delete();
};

run().catch((error) => {
  window.__rival = { error: String(error?.message ?? error), stack: String(error?.stack ?? '') };
  console.error('rival failed', error);
});
