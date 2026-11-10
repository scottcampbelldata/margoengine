import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createZstdDecompress } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
const url = 'https://noaaocm.blob.core.windows.net/ais/csv2/csv2024/ais-2024-01-01.csv.zst';
const r = await fetch(url, { signal: AbortSignal.timeout(240000) });
if (!r.ok) throw new Error(`AIS ${r.status}`);
const decoder = new StringDecoder('utf8'),
  hash = createHash('sha256'),
  root = 'examples/assets/sciviz/geo-time';
let pending = '',
  rows = 0,
  header;
const tracks = new Map();
function row(line) {
  if (!header) {
    header = line.split(',');
    console.log(header);
    return;
  }
  rows++;
  // NOAA CSV quotes ship names. Needed leading columns are unquoted numeric/time fields.
  const a = line.split(','),
    [id, date, lon, lat, sog] = a;
  const time = Date.parse(/Z$/.test(date) ? date : `${date}Z`);
  if (!(Number(lon) > -74.5 && Number(lon) < -73.5 && Number(lat) > 40 && Number(lat) < 41 && Number(sog) > 2)) return;
  let track = tracks.get(id);
  if (!track && tracks.size < 12) {
    track = { id, records: [] };
    tracks.set(id, track);
  }
  if (track && track.records.length < 240 && Number.isFinite(time))
    track.records.push({ time, position: [Number(lon), Number(lat), 0], sog: Number(sog) });
}
const compressed = new Transform({
  transform(chunk, _, done) {
    hash.update(chunk);
    done(null, chunk);
  },
});
const unpacked = new Transform({
  transform(chunk, _, done) {
    pending += decoder.write(chunk);
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      row(pending.slice(0, end).trimEnd());
      pending = pending.slice(end + 1);
    }
    done();
  },
});
await pipeline(Readable.fromWeb(r.body), compressed, createZstdDecompress(), unpacked);
if (pending) row(pending);
await mkdir(root, { recursive: true });
const curated = [...tracks.values()]
  .map((t) => {
    t.records.sort((a, b) => a.time - b.time);
    t.records = t.records.filter((r, i, a) => i === 0 || r.time > a[i - 1].time);
    return t;
  })
  .filter((t) => t.records.length >= 10);
if (!curated.length) throw new Error('No complete AIS tracks');
const bytes = Buffer.from(
  JSON.stringify({ date: '2024-01-01', region: 'New York harbour', tracks: curated }, null, 2) + '\n',
);
await writeFile(`${root}/ais.json`, bytes);
console.log({
  rows,
  tracks: curated.length,
  records: curated.map((t) => t.records.length),
  sha256: hash.digest('hex'),
  remoteBytes: r.headers.get('content-length'),
  etag: r.headers.get('etag'),
});
await writeFile(
  'test-results/batch180-job3-ais-source.json',
  JSON.stringify({ url, bytes: r.headers.get('content-length'), etag: r.headers.get('etag'), rows, header }, null, 2),
);
