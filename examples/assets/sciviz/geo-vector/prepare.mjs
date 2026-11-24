import { readFile, writeFile } from 'node:fs/promises';
import { parseShapefile } from '@margoengine/loaders/geo';
// Run from the repository root after expanding the two original archives into
// test-results/batch180-ne and test-results/batch180-census. No coordinates are simplified.
for (const [dir, base, name, key, field, units] of [
  ['batch180-ne', 'ne_110m_admin_0_countries', 'countries', 'ADM0_A3', 'POP_EST', 'persons, Natural Earth POP_EST'],
  ['batch180-census', 'cb_2024_us_state_20m', 'states', 'GEOID', 'ALAND', 'square metres, Census ALAND'],
]) {
  const root = `test-results/${dir}/${base}`;
  const data = parseShapefile(await readFile(root + '.shp'), { dbf: await readFile(root + '.dbf'), prj: 'OGC:CRS84' });
  const geometry = { type: 'FeatureCollection', features: data.features.map((f) => ({
    ...f, properties: { key: f.properties[key], name: f.properties.NAME ?? f.properties.ADMIN },
  })) };
  const values = data.features.map((f) => ({ key: f.properties[key], value: f.properties[field] }));
  await writeFile(`examples/assets/sciviz/geo-vector/${name}.geojson`, JSON.stringify(geometry) + '\n');
  await writeFile(`examples/assets/sciviz/geo-vector/${name}-values.json`, JSON.stringify({ units, rows: values }) + '\n');
  console.log(name, geometry.features.length, values.slice(0, 2));
}
