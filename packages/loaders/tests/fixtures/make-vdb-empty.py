# Original test grids, written and read through the native OpenVDB API bundled with Blender.
# Run: blender --background --factory-startup --python packages/loaders/tests/fixtures/make-vdb-empty.py
import json
import pathlib
import openvdb

root = pathlib.Path(__file__).resolve().parent
grid = openvdb.FloatGrid()
grid.name = 'density'
accessor = grid.getAccessor()
accessor.setValueOn((0, 0, 0), 1.5)
accessor.setValueOn((16, 8, 0), 2.25)
records = []
for half in (False, True):
    grid.saveFloatAsHalf = half
    path = root / ('empty-half.vdb' if half else 'empty-full.vdb')
    openvdb.write(str(path), grids=[grid])
    decoded = openvdb.readAll(str(path))[0][0]
    records.append({'file': path.name, 'half': half, 'active': decoded.activeVoxelCount(),
                    'box': decoded.evalActiveVoxelBoundingBox(),
                    'values': [decoded.getAccessor().getValue((0, 0, 0)), decoded.getAccessor().getValue((16, 8, 0))]})
(root / 'vdb-empty-oracle.json').write_text(json.dumps(records, indent=2) + '\n')
print(json.dumps(records))
