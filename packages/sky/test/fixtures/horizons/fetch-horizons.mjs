// Fetches the reference packages/sky/test/ephemeris.test.js compares against: JPL Horizons state vectors (DE441), heliocentric for the
// planets and geocentric for the Moon, in the ecliptic and equinox of J2000, at 51 dates about five years apart (1826.2 days) from
// 1800-01-02 to 2050-01-01 (TDB; Horizons has Neptune from 1800-01-02). Writes horizons.json beside this file. Run by hand: node packages/sky/test/fixtures/horizons/fetch-horizons.mjs
import { writeFileSync } from 'node:fs';

const bodies = {
  mercury: '199',
  venus: '299',
  earth: '3',
  mars: '499',
  jupiter: '599',
  saturn: '699',
  uranus: '799',
  neptune: '899',
  moon: '301',
};
const dates = Array.from({ length: 51 }, (_, i) => 2378497.5 + i * 1826.2);
const rows = {};
for (const [name, id] of Object.entries(bodies)) {
  const query = new URLSearchParams({
    format: 'text',
    COMMAND: `'${id}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'",
    CENTER: name === 'moon' ? "'500@399'" : "'500@10'",
    REF_PLANE: "'ECLIPTIC'",
    REF_SYSTEM: "'ICRF'",
    VEC_TABLE: "'1'",
    OUT_UNITS: "'AU-D'",
    CSV_FORMAT: "'YES'",
    TLIST: dates.map((d) => `'${d}'`).join(' '),
  });
  const text = await (await fetch(`https://ssd.jpl.nasa.gov/api/horizons.api?${query}`)).text();
  const body = text.split('$$SOE')[1]?.split('$$EOE')[0];
  if (!body) throw new Error(`no ephemeris for ${name}:\n${text.slice(0, 2000)}`);
  rows[name] = body
    .trim()
    .split('\n')
    .map((line) => {
      const cells = line.split(',').map((cell) => cell.trim());
      const [x, y, z] = cells.slice(2, 5).map(Number);
      return { jd: Number(cells[0]), x, y, z };
    });
  if (rows[name].length !== dates.length) throw new Error(`${name}: ${rows[name].length} rows`);
}
const out = {
  source: 'JPL Horizons (https://ssd.jpl.nasa.gov/horizons/), ephemeris DE441, retrieved 2026-11-13',
  frame: 'ecliptic and mean equinox of J2000 (Horizons REF_PLANE=ECLIPTIC, REF_SYSTEM=ICRF), au, TDB',
  centres: 'Sun body centre for the planets (Earth is the Earth-Moon barycentre, body 3); Earth centre for the Moon',
  rows,
};
writeFileSync(new URL('./horizons.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log('wrote horizons.json');
