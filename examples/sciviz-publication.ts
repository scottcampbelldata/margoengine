import { Figure } from '@margoengine/sciviz';
import { parseTTF } from '@margoengine/loaders/font';
import { addMathLabel, renderMath } from '@margoengine/sciviz/math';
import { exportPDF, svgToPDF } from '@margoengine/sciviz/pdf';

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')!;
export const figure = await Figure.create(canvas, {
  mode: '2d',
  theme: 'light',
  controls: false,
  margin: { top: 80, left: 90, bottom: 70 },
  titles: { x: 'Time (s)', y: 'Strain (10⁻²¹)' },
});
const [data, fontBytes] = await Promise.all([
  fetch(new URL('./assets/sciviz/publication/GW150914-H1.txt', import.meta.url)).then((r) => r.text()),
  fetch(new URL('./assets/sciviz/publication/DejaVuSerif.ttf', import.meta.url)).then((r) => r.arrayBuffer()),
]);
export const font = parseTTF(fontBytes);
const rows = data
  .split('\n')
  .filter((s) => s && !s.startsWith('#'))
  .map((s) => s.trim().split(/\s+/).map(Number));
await figure.line({ x: rows.map((r) => r[0]), y: rows.map((r) => r[1]) }, { color: '#164d73', name: 'LIGO Hanford' });
await figure.ready();
figure.render();
export const title = addMathLabel(figure, String.raw`h(t)=\frac{\Delta L(t)}{L}`, {
  font,
  size: 25,
  x: 110,
  y: 12,
  color: '#162e3d',
});
document.querySelector('#formula')!.innerHTML = renderMath(
  String.raw`\sqrt[3]{x_i^2}+\alpha\,\sin(\omega t)+\hat{v}+\begin{pmatrix}1&0\\0&1\end{pmatrix}`,
  { font, size: 22, color: '#edf2f6' },
).mathML;
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
export const pdf = () =>
  exportPDF(figure, {
    font,
    widthMM: 180,
    title: 'GW150914 Hanford strain',
    author: 'LIGO Scientific Collaboration and Virgo Collaboration',
    subject: 'Observed strain; CC BY 4.0',
    provenance: { source: 'GWOSC GW150914 Figure 1', license: 'CC BY 4.0' },
  });
export { svgToPDF };
document.querySelector('#pdf')!.addEventListener('click', async () => save(await pdf(), 'GW150914.pdf'));
document
  .querySelector('#svg')!
  .addEventListener('click', async () =>
    save(new Blob([await figure.toSVG()], { type: 'image/svg+xml' }), 'GW150914.svg'),
  );
document.querySelector('#status')!.textContent =
  `${rows.length} observed samples. PDF retains the strain trace, axes, units and formula as paths.`;
