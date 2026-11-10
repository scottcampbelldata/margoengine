// Standard scientific data only, from NOAA GHCN and the NASA Exoplanet Archive. No external code.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const root = new URL('../../../examples/assets/sciviz/stats/', import.meta.url);
await mkdir(root, { recursive: true });
const ghcnURL = 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/all/USW00094728.dly';
// NASA TAP returned HTTP 503 on both official hostnames. This pinned standard-data mirror
// contains only a NASA archive table; no notebook, README or implementation file is downloaded.
const nasaURL =
  'https://raw.githubusercontent.com/hannahrvs/Planetary-Composite-Data/a0d5fee61a002a349ea9d72fa450d5310b7c5947/Planetary%20Data%20Composite%20Data%20-%20PSCompPars_2026.05.30_18.25.02.csv';
const hash = (b) => createHash('sha256').update(b).digest('hex');
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`Scientific data download HTTP ${r.status}: ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}
const original = await get(ghcnURL),
  days = new Map();
for (const line of new TextDecoder().decode(original).split(/\r?\n/)) {
  if (line.slice(11, 15) !== '2020' || !['TMAX', 'TMIN'].includes(line.slice(17, 21))) continue;
  const month = Number(line.slice(15, 17)),
    element = line.slice(17, 21).toLowerCase();
  for (let day = 1; day <= 31; day++) {
    const i = 21 + (day - 1) * 8,
      v = Number(line.slice(i, i + 5));
    if (v === -9999 || line[i + 6] !== ' ') continue;
    const date = `2020-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const item = days.get(date) ?? { date, month };
    item[element] = v / 10;
    days.set(date, item);
  }
}
const weather = [...days.values()]
  .filter((v) => v.tmin !== undefined && v.tmax !== undefined)
  .sort((a, b) => a.date.localeCompare(b.date));
if (weather.length < 300) throw new Error('GHCN did not provide at least 300 paired days');
const planetsRaw = await get(nasaURL);
// RFC 4180 field quoting, including embedded commas/newlines and doubled quote characters.
const rows = [];
let row = [],
  field = '',
  quoted = false;
const text = new TextDecoder().decode(planetsRaw);
for (let i = 0; i <= text.length; i++) {
  const c = text[i] ?? '\n';
  if (c === '"') {
    if (quoted && text[i + 1] === '"') {
      field += '"';
      i++;
    } else quoted = !quoted;
  } else if (!quoted && (c === ',' || c === '\n')) {
    row.push(field);
    field = '';
    if (c === '\n') {
      if (row.some((v) => v.length)) rows.push(row);
      row = [];
    }
  } else if (c !== '\r' || quoted) field += c;
}
if (quoted) throw new Error('NASA CSV has an unterminated quoted field');
const header = rows.shift(),
  fields = ['pl_name', 'pl_orbper', 'pl_orbpererr1', 'pl_orbpererr2', 'pl_rade', 'pl_radeerr1', 'pl_radeerr2'];
if (fields.some((f) => !header.includes(f))) throw new Error('NASA CSV lacks a required field');
const planets = rows
  .map((row) =>
    Object.fromEntries(
      fields.map((f) => {
        const v = row[header.indexOf(f)];
        return [f, f === 'pl_name' ? v : v === '' ? null : Number(v)];
      }),
    ),
  )
  .filter((p) => p.pl_rade > 0 && p.pl_rade < 10 && p.pl_orbper > 0 && p.pl_orbper < 100)
  .sort((a, b) => (a.pl_name < b.pl_name ? -1 : a.pl_name > b.pl_name ? 1 : 0))
  .slice(0, 80);
if (planets.length < 40) throw new Error('NASA did not provide at least 40 planets');
const sources = [];
for (const [name, data, source, bytes, license, reduction] of [
  [
    'ghcn',
    weather,
    ghcnURL,
    original,
    'US government public domain',
    'Central Park NYC USW00094728, 2020 paired TMIN/TMAX; tenths C to C, missing -9999 and nonblank quality flags omitted',
  ],
  [
    'exoplanets',
    planets,
    nasaURL,
    planetsRaw,
    'Public NASA Exoplanet Archive data; acknowledge NASA Exoplanet Archive / NExScI / Caltech',
    'First 80 alphabetically named composite planet rows with 0<radius<10 Earth radii, 0<period<100 days; supplied signed measurement errors retained',
  ],
]) {
  const output = JSON.stringify(data) + '\n';
  await writeFile(new URL(`${name}.json`, root), output);
  sources.push({ file: `${name}.json`, source, license, reduction, sourceSHA256: hash(bytes), sha256: hash(output) });
}
await writeFile(
  new URL('source.json', root),
  JSON.stringify(
    {
      sources,
      nasaPolicy: 'https://exoplanetarchive.ipac.caltech.edu/docs/acknowledge.html',
      ghcnFormat: 'https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt',
    },
    null,
    2,
  ) + '\n',
);
