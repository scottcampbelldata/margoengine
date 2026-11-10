import { createFigure, element } from './sciviz-demo.js';
import { attachAccessibility, HIGH_CONTRAST_THEME, type AccessibilityHandle } from '@margoengine/sciviz/a11y';
import { THEMES } from '@margoengine/sciviz';
const [text, days] = await Promise.all([
  fetch('./assets/sciviz/publication/GW150914-H1.txt', { signal: AbortSignal.timeout(60000) }).then((r) => {
    if (!r.ok) throw new Error(`LIGO HTTP ${r.status}`);
    return r.text();
  }),
  fetch('./assets/sciviz/stats/ghcn.json', { signal: AbortSignal.timeout(60000) }).then((r) => {
    if (!r.ok) throw new Error(`GHCN HTTP ${r.status}`);
    return r.json() as Promise<{ date: string; tmax: number }[]>;
  }),
]);
const strain = text
  .split('\n')
  .filter((s) => s && !s.startsWith('#'))
  .map((s) => s.trim().split(/\s+/).map(Number));
export const ligo = await createFigure(element<HTMLCanvasElement>('strain'), {
  mode: '2d',
  theme: 'light',
  titles: { x: 'Time (s)', y: 'Strain (1e-21)' },
});
export const weather = await createFigure(element<HTMLCanvasElement>('weather'), {
  mode: '2d',
  theme: 'light',
  titles: { x: 'Observation', y: 'Maximum temperature (Celsius)' },
});
await ligo.line({ x: strain.map((r) => r[0]), y: strain.map((r) => r[1]) }, { color: '#075a9c', name: 'LIGO Hanford' });
await weather.line(
  { x: days.map((_, i) => i), y: days.map((d) => d.tmax) },
  { color: '#9a3300', name: 'GHCN maximum temperature' },
);
export let access: AccessibilityHandle[] = [];
const attach = async () => {
  for (const a of access) a.dispose();
  access = [
    attachAccessibility(ligo, {
      title: 'LIGO Hanford strain',
      reducedMotion: element<HTMLInputElement>('motion').checked,
    }),
    attachAccessibility(weather, {
      title: 'GHCN daily maximum temperature',
      reducedMotion: element<HTMLInputElement>('motion').checked,
    }),
  ];
  await Promise.all(access.map((a) => a.ready));
};
await attach();
await Promise.all([ligo.ready(), weather.ready()]);
element('contrast').addEventListener('change', () => {
  void Promise.all(
    [ligo, weather].map((f) =>
      f.setTheme(element<HTMLInputElement>('contrast').checked ? HIGH_CONTRAST_THEME : THEMES.light),
    ),
  ).then(() => {
    ligo.render();
    weather.render();
  });
});
element('motion').addEventListener('change', () => void attach());
element('status').textContent =
  `Ready: ${strain.length} LIGO samples and ${days.length} GHCN days. Each record remains reachable in its table.`;
element('strain').dataset.ready = 'true';
element('weather').dataset.ready = 'true';
window.addEventListener(
  'pagehide',
  () => {
    for (const a of access) a.dispose();
    ligo.dispose();
    weather.dispose();
  },
  { once: true },
);
