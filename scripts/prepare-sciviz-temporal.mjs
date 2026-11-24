// Reproduce the daily file-series assets from the repository's pinned NOAA NetCDF.
// era5.nc is the separately curated eight-step WeatherBench2 CDF2 standard data asset; no network query here.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openNetCDF } from '../packages/sciviz/dist/netcdf.js';
const root = new URL('../examples/assets/sciviz/temporal/', import.meta.url);
await mkdir(root, { recursive: true });
using noaa = await openNetCDF(new Uint8Array(await readFile(new URL('../examples/assets/sciviz/wind-classic.nc', import.meta.url))));
const files = [];
for (let i = 0; i < 8; i++) {
  const values = await noaa.variables.uwnd.read({ start: [i, 0, 0], count: [1, 5, 5] }), name = `wind-${String(i).padStart(4, '0')}.json`;
  await writeFile(new URL(name, root), JSON.stringify({ values: [...values] }) + '\n');
  files.push({ name, time: i });
}
await writeFile(new URL('wind.json.series', root), JSON.stringify({ 'file-series-version': '1.0', files }, null, 2) + '\n');
const names = [...files.map(f => f.name), 'wind.json.series', 'era5.nc'], sha256 = {};
for (const name of names) sha256[name] = createHash('sha256').update(await readFile(new URL(name, root))).digest('hex');
const manifest = {
  noaa: {
    title: 'NCEP-NCAR Reanalysis 1 daily eastward near-surface wind, January 1-8 2024',
    source: 'https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.dailyavgs/surface/uwnd.sig995.2024.nc',
    sourceSHA256: 'd6e65f8dee2ea1c8b193d252cd468031c6f6553c3f9544170fabad17a9848f8e',
    input: '../wind-classic.nc', inputSHA256: '1bdfb66dc788095208155e2f917d92d340a46700d0b155ec2904b690fa78ae99',
    license: 'US government public domain, NOAA PSL credit retained', units: 'm/s', timeUnits: 'days since 2024-01-01',
    selection: 'Unchanged 5x5 native samples: longitude -100 to -90, latitude 20 to 30, x fastest. Split day dimension into JSON files; no scaling or fabricated fields.',
  },
  era5: {
    title: 'ERA5 2 metre temperature, WeatherBench2 six-hour 64x32 conservative grid',
    authors: 'Copernicus Climate Change Service (C3S), ECMWF; WeatherBench2, Stephan Rasp et al.',
    source: 'https://storage.googleapis.com/weatherbench2/datasets/era5/1959-2023_01_10-6h-64x32_equiangular_conservative.zarr',
    dataGuide: 'https://weatherbench2.readthedocs.io/en/latest/data-guide.html',
    license: 'CC BY 4.0 (ERA5 producer dataset licence); contains modified Copernicus Climate Change Service information [2024]. Neither the European Commission nor ECMWF is responsible for use of this information.',
    licenseURL: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels?tab=overview',
    selection: '2m_temperature indices time=89124:89132, all 64 longitudes and 32 latitudes; 8 six-hour steps, not hourly interpolation. CDF2 repacking of unchanged float32 values; longitude/latitude standard_name/units/axis metadata added truthfully.',
    sourceChunk: '2m_temperature/891.0.0', sourceChunkSHA256: 'af410b32e16bef88d7732c5a4db8b1701ce3b380f8ee25b52a7fc8f9b1f45ae1',
    units: 'K', timeUnits: 'hours since 1959-01-01', calendar: 'proleptic_gregorian',
  }, sha256,
};
await writeFile(new URL('source.json', root), JSON.stringify(manifest, null, 2) + '\n');
console.log('Prepared eight unchanged NOAA day files, .series and provenance for the pinned ERA5 data.');
