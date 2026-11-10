import { installFigureStats } from '@margoengine/sciviz/monitor';

export const SIZE = 256;
export const COLOR = '#22cbee';
export const BACKGROUND = '#0f141c';

export async function copyCanvas(canvas) {
  if (canvas.width !== SIZE || canvas.height !== SIZE)
    throw new Error(`Canvas dimensions differ: ${canvas.width}x${canvas.height}`);
  const bitmap = await createImageBitmap(canvas);
  const target = new OffscreenCanvas(SIZE, SIZE);
  const ctx = target.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { width: SIZE, height: SIZE, rgba: ctx.getImageData(0, 0, SIZE, SIZE).data };
}

export function flatCamera(figure) {
  const camera = figure.engine.camera;
  camera.position = [0, 10, 0];
  camera.target = [0, 0, 0];
  camera.up = [0, 0, -1];
  camera.project = (out, _aspect, webgpu) => {
    out.fill(0);
    out[0] = out[5] = out[15] = 1;
    out[10] = (webgpu ? 1 : 2) / (camera.far - camera.near);
    out[14] = (webgpu ? camera.far : camera.far + camera.near) / (camera.far - camera.near);
  };
}

export async function margoRenderer(host, data, signal, exportImage = false, schedule = false) {
  const { Figure } = await import('@margoengine/sciviz');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  host.append(canvas);
  const flat = ['scatter', 'line', 'heatmap', 'streamlines'].includes(data.id);
  const figure = await Figure.create(canvas, {
    axes: false,
    controls: false,
    mode: flat ? '2d' : '3d',
    margin: { left: 0, right: 0, top: 0, bottom: 0 },
    pointBudget: 100_000_000,
    aspect: [1, 1, 1],
    limits: flat ? [-1, 1, -1, 1] : [-1, 1, -1, 1, -1, 1],
    signal,
  });
  figure.engine.stop();
  try {
    if (data.id === 'scatter' || data.id === 'line') {
      const points = { x: Float32Array.from(data.points, (p) => p[0]), y: Float32Array.from(data.points, (p) => p[1]) };
      if (data.id === 'scatter') await figure.scatter(points, { color: COLOR, size: 3, edl: false });
      else await figure.line(points, { color: COLOR, width: 1 });
    } else if (data.id === 'heatmap') {
      const center = 1 - 1 / data.scale;
      await figure.heatmap(data.values.slice(), {
        nx: data.scale,
        ny: data.scale,
        x: [-center, center],
        y: [-center, center],
        range: [0, data.maximum],
        colormap: 'aurora',
      });
    } else if (data.id === 'volume') {
      figure.volume(data.values.slice(), {
        dims: [data.scale, data.scale, data.scale],
        range: [0, 1],
        bounds: [-1, 1, -1, 1, -1, 1],
        shading: false,
      });
    } else if (data.id === 'isosurface') {
      await figure.isosurface(data.values.slice(), 0.5, {
        dims: [data.scale, data.scale, data.scale],
        bounds: [-1, 1, -1, 1, -1, 1],
        color: COLOR,
        signal,
      });
    } else if (data.id === 'streamlines') {
      await figure.streamlines(data.field, {
        seeds: data.scale,
        step: 0.01,
        maxSteps: 512,
        direction: 'both',
        color: COLOR,
        width: 1,
      });
    } else if (data.id === 'graph') {
      const { graphLayer } = await import('@margoengine/sciviz/graph');
      flatCamera(figure);
      graphLayer(figure, { nodes: data.positions.length / 3, edges: data.edges }, data.positions.slice(), {
        nodeSize: 3,
        colormap: [COLOR, COLOR],
        edgeColor: COLOR,
        edgeOpacity: 1,
        bounds: [-1, 1, -1, 1, -1, 1],
      });
    } else if (data.id === 'tiles') {
      const { tileLayer } = await import('@margoengine/sciviz/geo');
      flatCamera(figure);
      await tileLayer(figure, {
        zoom: data.scale,
        maxTiles: 4 ** data.scale,
        tiles: async (z, x, y, requestSignal) => {
          const src = `/examples/assets/sciviz/geo-lod/2-${x % 4}-${y % 4}.png`;
          const result = await fetch(src, { signal: requestSignal });
          if (!result.ok) throw new Error(`Tile ${src}: ${result.status}`);
          return result.blob();
        },
        signal,
      });
    } else throw new RangeError(`No Margo adapter for ${data.id}`);
    await figure.ready();
    const stats = installFigureStats(figure);
    return {
      canvas,
      figure,
      memory: () => stats.stats.snapshot(),
      async frame(frameSignal) {
        frameSignal?.throwIfAborted();
        if (exportImage) {
          const blob = await figure.toPNG({ overlays: false });
          const image = await createImageBitmap(blob);
          const out = new OffscreenCanvas(SIZE, SIZE);
          const ctx = out.getContext('2d');
          ctx.drawImage(image, 0, 0);
          image.close();
          return { width: SIZE, height: SIZE, rgba: ctx.getImageData(0, 0, SIZE, SIZE).data };
        }
        if (schedule)
          return new Promise((resolve) =>
            requestAnimationFrame(() => {
              figure.render();
              resolve(copyCanvas(canvas));
            }),
          );
        figure.render();
        return copyCanvas(canvas);
      },
      dispose() {
        figure.dispose();
        host.replaceChildren();
      },
    };
  } catch (error) {
    figure.dispose();
    host.replaceChildren();
    throw error;
  }
}
