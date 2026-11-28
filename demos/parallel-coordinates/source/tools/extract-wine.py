"""Package the exact numeric readings in the two UCI Vinho Verde CSVs."""
import argparse
import csv
from decimal import Decimal
import io
import struct
from pathlib import Path
from zipfile import ZipFile
import zlib

MEASURES = (
    ('residual sugar', 100),
    ('density', 1000000),
    ('alcohol', 1000),
    ('pH', 100),
    ('fixed acidity', 100),
    ('volatile acidity', 1000),
    ('sulphates', 100),
    ('quality', 1),
)

EXPECTED_ROWS = (1599, 4898)



def bake(source, target):
    columns = [[] for _ in MEASURES]
    with ZipFile(source) as archive:
        for color, size in zip(('red', 'white'), EXPECTED_ROWS):
            with archive.open(f'winequality-{color}.csv') as binary:
                rows = list(csv.DictReader(io.TextIOWrapper(binary, encoding='utf-8'), delimiter=';'))
            if len(rows) != size:
                raise ValueError(f'Unexpected source row count for {color}')
            for row in rows:
                for (name, scale), values in zip(MEASURES, columns):
                    values.append(Decimal(row[name]))
    body = bytearray(struct.pack('<4s2H', b'VV01', *EXPECTED_ROWS))
    for (name, scale), values in zip(MEASURES, columns):
        quantized = [round(value * scale) for value in values]
        overrides = [(i, float(value)) for i, value in enumerate(values) if value * scale != quantized[i]]
        origin = min(quantized)
        body.extend(struct.pack('<iIH', origin, scale, len(overrides)))
        deltas = [value - origin for value in quantized]
        body.extend(bytes(value & 255 for value in deltas))
        body.extend(bytes(value >> 8 for value in deltas))
        for index, actual in overrides:
            body.extend(struct.pack('<Hd', index, actual))
        print(name, len(values), min(values), max(values), 'overrides', len(overrides))
    data = zlib.compress(body, level=9)
    target.write_bytes(data)
    print(f'Wrote {len(data)} bytes for {sum(EXPECTED_ROWS)} records')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    parser.add_argument('target', type=Path)
    args = parser.parse_args()
    bake(args.archive, args.target)
