"""Dependency-free .margo v1 writer; see packages/blender/FORMAT.md."""
import hashlib
import json
import os
import struct
import tempfile
import zlib

MAX_BYTES = 64 * 1024 * 1024


def png(width, height, rgba):
    if not 0 < width <= 4096 or not 0 < height <= 4096 or len(rgba) != width * height * 4:
        raise ValueError("Texture must be bounded RGBA8")

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    rows = b"".join(b"\0" + rgba[y * width * 4:(y + 1) * width * 4] for y in range(height))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


def encode(document, geometry, images=()):
    sections = [(1, b"")]
    shared = {}

    def add(kind, data):
        data = bytes(data)
        key = (kind, hashlib.sha256(data).digest())
        if key not in shared:
            shared[key] = len(sections)
            sections.append((kind, data))
        return shared[key]

    doc = dict(document)
    doc["asset"] = {"version": "2.0", "generator": "margo-blender 1.0.0"}
    doc["meshes"] = []
    for mesh in geometry:
        primitives = []
        for primitive in mesh:
            vertex, index = primitive["vertices"], primitive["indices"]
            if len(vertex) < 240 or len(vertex) % 80 or not index or len(index) % 12:
                raise ValueError("Expected packed PBR triangle geometry")
            record = {k: v for k, v in primitive.items() if k not in ("vertices", "indices")}
            record.update(vertices=add(2, vertex), indices=add(3, index))
            primitives.append(record)
        if not primitives:
            raise ValueError("Mesh has no triangles")
        doc["meshes"].append({"primitives": primitives})
    doc["images"] = [{"section": add(4, image), "mimeType": "image/png"} for image in images]
    manifest = json.dumps(doc, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(manifest) > 1024 * 1024 or not 3 <= len(sections) <= 4096:
        raise ValueError(".margo manifest/section budget exceeded")
    sections[0] = (1, manifest)
    offset = 64 + 16 * len(sections)
    table, payload = [], []
    for kind, data in sections:
        table.append(struct.pack("<4I", kind, offset, len(data), 0))
        padded = data + b"\0" * (-len(data) % 4)
        payload.append(padded)
        offset += len(padded)
    if offset > MAX_BYTES:
        raise ValueError(".margo exceeds 64 MiB")
    header = struct.pack("<16I", 0x4F47524D, 1, offset, len(sections), 64, 0, 80, *([0] * 9))
    return header + b"".join(table) + b"".join(payload)


def write(path, document, geometry, images=()):
    data = encode(document, geometry, images)
    destination = os.path.abspath(path)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=os.path.dirname(destination), delete=False) as output:
            temporary = output.name
            output.write(data)
        os.replace(temporary, destination)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    return len(data)
