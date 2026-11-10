// NOAA NCEP-NCAR Reanalysis 1. Native daily u/v samples, no synthetic flow.
import type { Figure, LineLayer } from '@margoengine/sciviz';
import { createFigure, element, exportButton, fail, floats } from './sciviz-demo.js';

const nx = 49,
  ny = 19,
  size = nx * ny;
const km = (Math.PI * 6371) / 180,
  cosCentre = Math.cos((42.5 * Math.PI) / 180);
const bounds: [number, number, number, number] = [-60 * km * cosCentre, 60 * km * cosCentre, -22.5 * km, 22.5 * km];
export const figure = await createFigure(element<HTMLCanvasElement>('viewport'), {
  mode: '2d',
  limits: bounds,
  titles: { x: 'East of 40 W (km)', y: 'North of 42.5 N (km)' },
});
export let streams: LineLayer | undefined;
export let arrows: LineLayer | undefined;
export let timeline: ReturnType<Figure['timeline']>;

try {
  const data = await floats(new URL('./assets/sciviz/wind.bin', import.meta.url));
  const times = Array.from({ length: 8 }, (_, k) => Date.UTC(2024, 0, k + 1));
  timeline = figure.timeline(
    times,
    async (frame, time) => {
      const u = new Float32Array(size),
        v = new Float32Array(size);
      const x: number[] = [],
        y: number[] = [],
        qu: number[] = [],
        qv: number[] = [];
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          const east = data[frame * 2 * size + k],
            north = data[(frame * 2 + 1) * size + k];
          // Equirectangular direction; normalise back to physical speed for colour and arrow length.
          const projected = (east * cosCentre) / Math.cos(((20 + j * 2.5) * Math.PI) / 180);
          const scale = Math.hypot(east, north) / (Math.hypot(projected, north) || 1);
          u[k] = projected * scale;
          v[k] = north * scale;
          if (i % 3 === 0 && j % 2 === 0) {
            x.push(bounds[0] + (i / (nx - 1)) * (bounds[1] - bounds[0]));
            y.push(bounds[2] + (j / (ny - 1)) * (bounds[3] - bounds[2]));
            qu.push(u[k]);
            qv.push(v[k]);
          }
        }
      const nextStreams = await figure.streamlines(
        { u, v, dims: [nx, ny], bounds },
        {
          seeds: 14,
          maxSteps: 280,
          step: 20,
          colormap: 'viridis',
          range: [0, 35],
          width: 1.5,
        },
      );
      streams = streams ? figure.replace(streams, nextStreams) : nextStreams;
      const nextArrows = await figure.quiver(
        { x, y, u: qu, v: qv },
        {
          scale: 14,
          color: '#e0e9ed',
          width: 1.2,
        },
      );
      arrows = arrows ? figure.replace(arrows, nextArrows) : nextArrows;
      element<HTMLInputElement>('day').value = String(frame);
      element('date').textContent = new Date(time).toISOString().slice(0, 10);
      await figure.ready();
      element('status').textContent = 'Daily mean wind speed, m/s. Drag to pan; scroll to zoom; double-click to reset.';
    },
    { controls: false },
  );
  figure.colorbar('viridis', [0, 35], { label: 'Wind speed (m/s)' });
  await timeline.seek(0);
  const play = element<HTMLButtonElement>('play');
  const stop = () => {
    timeline.pause();
    play.textContent = 'Play';
  };
  play.addEventListener('click', () => {
    if (timeline.playing) stop();
    else {
      play.textContent = 'Pause';
      void timeline
        .play({ fps: 2, loop: true })
        .then(() => {
          play.textContent = 'Play';
        })
        .catch(fail);
    }
  });
  element('day').addEventListener('input', () => {
    stop();
    void timeline.seek(Number(element<HTMLInputElement>('day').value)).catch(fail);
  });
  exportButton(figure, 'north-atlantic-wind');
  let exportAbort: AbortController | undefined;
  const cancel = element<HTMLButtonElement>('media-cancel');
  cancel.addEventListener('click', () => exportAbort?.abort(new DOMException('Export cancelled', 'AbortError')));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-media]'))
    button.addEventListener('click', () => {
      void (async () => {
        const { exportImage, exportImageSequence, exportVideo } = await import('@margoengine/sciviz/export-media');
        const format = button.dataset.media!,
          status = element('media-status');
        exportAbort = new AbortController();
        cancel.disabled = false;
        for (const control of document.querySelectorAll<HTMLButtonElement>('[data-media]')) control.disabled = true;
        status.textContent = 'Exporting NOAA wind fields...';
        try {
          const size =
            element<HTMLSelectElement>('media-size').value === 'print'
              ? { size: { width: 180, height: 100, unit: 'mm' as const }, dpi: 300 }
              : { scale: 2 };
          const options = {
            ...size,
            transparent: element<HTMLInputElement>('media-alpha').checked,
            fps: 2,
            signal: exportAbort.signal,
            provenance: {
              source: 'NOAA PSL NCEP-NCAR Reanalysis 1',
              url: 'https://psl.noaa.gov/data/gridded/data.ncep.reanalysis.html',
              license: 'Public domain',
              variable: '0.995 sigma daily u/v wind',
              dates: '2024-01-01/2024-01-08',
              units: 'm/s',
            },
          };
          const blob =
            format === 'zip'
              ? await exportImageSequence(figure, timeline, options)
              : format === 'webm' || format === 'mp4'
                ? await exportVideo(figure, timeline, { ...options, format })
                : await exportImage(figure, { ...options, format: format as 'png' | 'webp' });
          const url = URL.createObjectURL(blob),
            link = document.createElement('a');
          link.href = url;
          link.download = `noaa-wind.${format}`;
          link.click();
          URL.revokeObjectURL(url);
          status.textContent = `Saved ${format.toUpperCase()} with source provenance.`;
        } catch (error) {
          status.textContent = `Export ended: ${(error as Error).message}`;
        } finally {
          cancel.disabled = true;
          exportAbort = undefined;
          for (const control of document.querySelectorAll<HTMLButtonElement>('[data-media]')) control.disabled = false;
        }
      })();
    });
  element('viewport').dataset.ready = 'true';
} catch (error) {
  fail(error);
}
window.addEventListener('pagehide', () => figure.dispose(), { once: true });
