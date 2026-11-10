// Download small immutable object/range snapshots from their owning public scientific repositories.
// No source code or full cloud volumes are downloaded. Each request has a 30-second deadline.
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cloudStore, openOMEZarr, openN5, openPrecomputed } from '@margoengine/sciviz/omezarr';

const root = 'packages/sciviz/tests/fixtures/cloud-volumes';
await mkdir(root, { recursive: true });
const sources = [
  {
    name: 'idr-lightsheet',
    base: 'https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.5/idr0066/ExpA_VIP_ASLM_on.zarr',
    open: openOMEZarr,
    license: 'CC BY 4.0',
    attribution: 'IDR idr0066, Voigt et al., mesoSPIM light-sheet microscopy',
  },
  {
    name: 'openorganelle',
    base: 'https://janelia-cosem-datasets.s3.amazonaws.com/jrc_hela-2/jrc_hela-2.n5/em/fibsem-uint16',
    open: openN5,
    license: 'CC BY 4.0',
    attribution: 'Janelia COSEM / OpenOrganelle, jrc_hela-2, Heinrich et al.',
  },
  {
    name: 'hemibrain',
    base: 'https://storage.googleapis.com/neuroglancer-janelia-flyem-hemibrain/emdata/clahe_yz/jpeg',
    open: openPrecomputed,
    license: 'CC BY 4.0',
    attribution: 'Janelia FlyEM hemibrain, Scheffer et al.',
  },
];
for (const source of sources) {
  const only = process.argv
    .find((a) => a.startsWith('--only='))
    ?.slice(7)
    .split(',');
  if (only && !only.includes(source.name)) continue;
  const dir = `${root}/${source.name}`;
  await mkdir(dir, { recursive: true });
  const requests = [];
  const remote = cloudStore(source.base, { maxBytes: 64 * 1024 * 1024 });
  const store = {
    async get(key, signal, range) {
      const bytes = await remote.get(
        key,
        signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        range,
      );
      const record = { key, ...(range ? { range } : {}), file: null };
      if (bytes) {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        record.file = `${sha256}.bin`;
        record.sha256 = sha256;
        record.bytes = bytes.length;
        await writeFile(`${dir}/${record.file}`, bytes);
      }
      requests.push(record);
      return bytes;
    },
  };
  const volume = await source.open(store);
  console.log(
    source.name,
    volume.levels.map((l) => ({ path: l.path, dims: l.dims, chunks: l.array.chunks })),
  );
  const selected = volume.levels.length - 1,
    level = volume.levels[selected];
  const size = level.dims.map((n) => Math.min(n, 32));
  const origin = level.dims.map((n, d) => Math.floor((n - size[d]) / 2));
  const data = await level.source.read({ level: 0, frame: 0, size, origin, signal: AbortSignal.timeout(120000) });
  const expected = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  await writeFile(`${dir}/expected.f32`, expected);
  const manifest = {
    name: source.name,
    base: source.base,
    license: source.license,
    attribution: source.attribution,
    selected,
    size,
    origin,
    samples: data.length,
    sampleRange: [Math.min(...data), Math.max(...data)],
    requests,
  };
  await writeFile(`${dir}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    source.name,
    'requests',
    requests.length,
    'downloaded bytes',
    requests.reduce((n, r) => n + (r.bytes ?? 0), 0),
    'samples',
    data.length,
    manifest.sampleRange,
  );
}
