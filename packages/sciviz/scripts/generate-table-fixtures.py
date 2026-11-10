"""Regenerate standard-data fixtures with PyArrow 26.0.1, never its source code.
Run with pyarrow installed; TLC source download lives under this lane's ignored test-results.
"""
from pathlib import Path
import json
import urllib.request
import pyarrow as pa
import pyarrow.parquet as pq
import pyarrow.ipc as ipc

root = Path(__file__).resolve().parents[3]
out = root / 'packages/sciviz/tests/fixtures/table'
out.mkdir(parents=True, exist_ok=True)
source = root / 'test-results/batch174/green_tripdata_2024-01.parquet'
url = 'https://d37ci6vzurychx.cloudfront.net/trip-data/green_tripdata_2024-01.parquet'
if not source.exists():
    with urllib.request.urlopen(url, timeout=60) as response:
        source.write_bytes(response.read())
trips = pq.read_table(source, columns=['trip_distance', 'fare_amount', 'PULocationID', 'payment_type']).slice(0, 4096)
pq.write_table(trips, out / 'tlc-trips.parquet', compression='snappy', row_group_size=1024)
with ipc.new_file(out / 'tlc-trips.arrow', trips.schema) as writer:
    writer.write_table(trips)
(out / 'tlc-reference.json').write_text(json.dumps(trips.to_pydict(), separators=(',', ':')) + '\n')

data = pa.table({
    'i': pa.array([1, None, -3, 2147483647, 0], type=pa.int32()),
    'wide': pa.array([9007199254740993, -7, None, 2**62, 0], type=pa.int64()),
    'u': pa.array([2**64-1, 0, 3, None, 7], type=pa.uint64()),
    'f': pa.array([1.25, -2.5, 0.0, None, 8.75], type=pa.float64()),
    's': pa.array(['alpha', 'alpha', None, 'beta\n"x', 'λ']),
    'b': pa.array([True, False, None, True, False]),
    'time': pa.array([0, 1, 1000000, None, -1], type=pa.timestamp('us', tz='UTC')),
})
for codec in ['NONE', 'snappy', 'gzip', 'brotli', 'zstd', 'lz4']:
    for version in ['1.0', '2.0']:
        pq.write_table(data, out / f'scalars-{codec}-{version}.parquet', compression=codec,
                       data_page_version=version, row_group_size=3, write_page_checksum=True)
for codec in [None, 'lz4', 'zstd']:
    for kind in ['file', 'stream']:
        for dictionary in [False, True]:
            table = data.set_column(4, 's', data['s'].dictionary_encode()) if dictionary else data
            suffix = f'{kind}-{codec or "none"}-{"dict" if dictionary else "plain"}.arrow'
            with pa.OSFile(str(out / suffix), 'wb') as sink:
                with (ipc.new_file if kind == 'file' else ipc.new_stream)(sink, table.schema, options=ipc.IpcWriteOptions(compression=codec)) as writer:
                    writer.write_table(table, max_chunksize=3)
for encoding, names in [('DELTA_BINARY_PACKED', ['i','wide']), ('DELTA_LENGTH_BYTE_ARRAY', ['s']), ('DELTA_BYTE_ARRAY', ['s']), ('BYTE_STREAM_SPLIT', ['i','wide','f'])]:
    table = data.select(names)
    pq.write_table(table, out / f'encoding-{encoding}.parquet', compression=None, use_dictionary=False, column_encoding=encoding)
print(f'Wrote {len(list(out.iterdir()))} fixtures; {trips.num_rows} real TLC rows')
