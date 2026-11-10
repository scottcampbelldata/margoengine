import { contour2D, scatteredContour2D, contourSVG, type ContourPoint2D } from '@margoengine/sciviz/contour2d';

const field = document.querySelector<HTMLSelectElement>('#field')!;
const scattered = document.querySelector<HTMLInputElement>('#scattered')!;
const status = document.querySelector<HTMLElement>('#status')!;
const plot = document.querySelector<HTMLElement>('#plot')!;
let active = new AbortController(),
  svg = '';

async function draw() {
  active.abort();
  active = new AbortController();
  const { signal } = active;
  try {
    const name = field.value,
      sites = scattered.checked;
    const response = await fetch(`./assets/sciviz/contour2d/${name}.json`, { signal });
    if (!response.ok) throw new Error(`Climate data HTTP ${response.status}`);
    const data = (await response.json()) as { x: number[]; y: number[]; values: (number | null)[] };
    const values = data.values.map((v) => (v === null ? NaN : v));
    const levels = name === 'oisst' ? [5, 10, 15, 20, 25, 30] : [48000, 50000, 52000, 54000, 56000, 58000];
    const points: ContourPoint2D[] = values.flatMap((v, i) =>
      Number.isFinite(v) ? [[data.x[i % data.x.length], data.y[Math.floor(i / data.x.length)], v] as const] : [],
    );
    const result = sites
      ? await scatteredContour2D(points, { levels, signal })
      : await contour2D({ ...data, values }, { levels, signal });
    signal.throwIfAborted();
    svg = contourSVG(result, {
      title: `${name}: longitude versus latitude; ${sites ? 'Delaunay linear interpolation' : 'rectilinear marching squares'}`,
    });
    plot.innerHTML = svg;
    status.textContent = `${result.lines.length} isolines, ${result.bands.length} filled bands; ${sites ? `${points.length} finite sites, interpolation across missing sites inside the convex hull` : 'land and missing cells masked'}.`;
  } catch (error) {
    if (!signal.aborted) {
      status.textContent = String(error);
      throw error;
    }
  }
}
field.addEventListener('change', () => {
  void draw();
});
scattered.addEventListener('change', () => {
  void draw();
});
document.querySelector('#download')!.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
    a = document.createElement('a');
  a.href = url;
  a.download = `${field.value}-contours.svg`;
  a.click();
  URL.revokeObjectURL(url);
});
await draw();
