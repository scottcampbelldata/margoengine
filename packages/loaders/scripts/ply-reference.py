"""Outside oracle: python-plyfile 1.1.3 + NumPy 2.3.4, installed outside Margo.

Run with INPUT.ply OUTPUT.json. This reads the original VTK horse without writing
or re-encoding the model; only counts, bounds and canonical array hashes are emitted.
"""
import hashlib
import json
import pathlib
import sys
from importlib.metadata import version

import numpy as np
from plyfile import PlyData

source, output = map(pathlib.Path, sys.argv[1:])
data = PlyData.read(str(source))
assert not data.text and data.byte_order == ">"
vertices = data["vertex"].data
positions = np.column_stack([vertices[k] for k in ("x", "y", "z")]).astype("<f4")
colors = (np.column_stack([vertices[k] for k in ("red", "green", "blue")]).astype(np.float32) / np.float32(255)).astype("<f4")
faces = data["face"].data["vertex_indices"]
assert all(len(face) == 3 for face in faces)
indices = np.stack(faces).astype("<u4")
assert np.all(np.isfinite(positions))
assert indices.max() < len(positions)

def digest(values):
    return hashlib.sha256(values.tobytes(order="C")).hexdigest()

record = {
    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
    "oracle": {"tool": "python-plyfile", "version": version("plyfile"), "numpy": np.__version__, "python": sys.version.split()[0]},
    "format": "binary_big_endian", "vertices": len(positions), "faces": len(faces), "triangles": len(indices),
    "positionComponents": positions.size, "colorComponents": colors.size, "indexComponents": indices.size,
    "positionsFloat32LESha256": digest(positions), "colorsFloat32LESha256": digest(colors), "indicesUint32LESha256": digest(indices),
    "bounds": [*positions.min(axis=0).tolist(), *positions.max(axis=0).tolist()],
    "vertexProperties": list(vertices.dtype.names), "ignoredProperty": "confidence",
    "minimumIndex": int(indices.min()), "maximumIndex": int(indices.max()), "uniqueColors": len(np.unique(colors, axis=0)),
}
output.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
print(json.dumps(record, indent=2))
