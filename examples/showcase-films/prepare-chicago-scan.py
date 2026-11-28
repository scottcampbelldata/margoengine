"""Prepare a photograph-textured GLB export for Margo's local tile renderer."""

import argparse
from collections import defaultdict
from io import BytesIO
import json
from pathlib import Path
import struct

import numpy as np
from PIL import Image, ImageDraw
from scipy.ndimage import distance_transform_edt
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components
from scipy.spatial.transform import Rotation


def read_glb(path):
    with path.open("rb") as stream:
        if struct.unpack("<4sII", stream.read(12)) != (b"glTF", 2, path.stat().st_size):
            raise ValueError("Expected a complete glTF 2.0 binary export.")
        size, kind = struct.unpack("<I4s", stream.read(8))
        if kind != b"JSON":
            raise ValueError("The glTF JSON chunk is missing.")
        document = json.loads(stream.read(size))
        length, kind = struct.unpack("<I4s", stream.read(8))
        if kind != b"BIN\0":
            raise ValueError("The glTF vertex buffer is missing.")
        binary = bytearray(stream.read(length))
    return document, binary


def model_bounds(document):
    bounds = []

    def visit(index, parent):
        node = document["nodes"][index]
        if "matrix" in node:
            transform = np.asarray(node["matrix"]).reshape(4, 4).T
        else:
            transform = np.eye(4)
            transform[:3, :3] = Rotation.from_quat(node.get("rotation", [0, 0, 0, 1])).as_matrix()
            transform[:3, :3] *= node.get("scale", [1, 1, 1])
            transform[:3, 3] = node.get("translation", [0, 0, 0])
        world = parent @ transform
        if "mesh" in node:
            for primitive in document["meshes"][node["mesh"]]["primitives"]:
                accessor = document["accessors"][primitive["attributes"]["POSITION"]]
                if "min" not in accessor or "max" not in accessor:
                    raise ValueError("The GLB export needs POSITION bounds.")
                corners = np.array(np.meshgrid(*zip(accessor["min"], accessor["max"]))).reshape(3, -1).T
                bounds.extend(corners @ world[:3, :3].T + world[:3, 3])
        for child in node.get("children", []):
            visit(child, world)

    scene = document["scenes"][document.get("scene", 0)]
    for node in scene["nodes"]:
        visit(node, np.eye(4))
    if not bounds:
        raise ValueError("No scanned geometry was exported.")
    return np.min(bounds, axis=0), np.max(bounds, axis=0)


def building_envelopes(footprints):
    # Local surveyed footprint bounds, in metres. The outer buffer allows
    # eaves, registration uncertainty and the sculpture of the original roof.
    left, bottom, size = -580, -850, 1800
    raster = Image.new("1", (size, size))
    paint = ImageDraw.Draw(raster)
    source = json.loads(footprints.read_text(encoding="utf-8"))
    for feature in source["features"]:
        geometry = feature["geometry"]
        polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
        for rings in polygons:
            ring = [
                (-83 + (longitude + 87.62446) * 82844 - left, -172 + (41.87326 - latitude) * 111120 - bottom)
                for longitude, latitude in rings[0]
            ]
            if any(0 <= x < size and 0 <= y < size for x, y in ring):
                paint.polygon(ring, fill=1)
    distance = distance_transform_edt(~np.asarray(raster, dtype=bool))
    return left, bottom, distance


def accessor_data(document, binary, index, dtype, width):
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return np.frombuffer(binary, dtype, accessor["count"] * width, offset).reshape(-1, width)


PLANTING_BEDS = [(-76, 28, -153, -21), (-79, 28, -262, -180)]


def park_planting(x, z):
    # Keep the rail cut and sidewalks out of the planting beds.
    return ((x > -76) & (x < 28) & (z > -153) & (z < -21)) | (
        (x > -79) & (x < 28) & (z > -262) & (z < -180)
    )


def planting_grade(x, z):
    # Fit the west park's slope to low points visible between the crowns.
    grade = np.where(z < -166, 8.1 - 0.018 * (-185 - z), 10.12 + 0.048 * (z + 147))
    return grade - np.maximum(x + 18, 0) * 0.023 - np.maximum(x - 17, 0) * 0.48


def remove_bridged_faces(document, binary, envelopes, source, trees, facade):
    accessors = document["accessors"]
    views = document["bufferViews"]
    kept = []
    data = bytes(binary)
    for mesh in document["meshes"]:
        for primitive in mesh["primitives"]:
            # The exported vertex colors are a second copy of the same photos.
            # A textured material already carries the captured surface color.
            primitive["attributes"].pop("COLOR_0", None)
            positions = accessor_data(document, data, primitive["attributes"]["POSITION"], "<f4", 3)
            indices = accessors[primitive["indices"]]
            dtype = {5123: "<u2", 5125: "<u4"}[indices["componentType"]]
            faces = accessor_data(document, data, primitive["indices"], dtype, 1).reshape(-1, 3)
            triangles = positions[faces]
            sides = triangles - np.roll(triangles, 1, axis=1)
            lengths = np.einsum("ijk,ijk->ij", sides, sides).max(axis=1)
            # Large caps bridge unobserved regions in the reconstruction. The
            # measured street surfaces have much smaller triangles.
            centres = triangles.mean(axis=1)
            east, north, height = centres.T
            joined = lengths <= np.where(centres[:, 2] < 8, 14**2, 9**2)
            if envelopes is not None:
                left, bottom, distance = envelopes
                x = np.rint(east - left).astype(int).clip(0, distance.shape[1] - 1)
                z = np.rint(-north - bottom).astype(int).clip(0, distance.shape[0] - 1)
                setback = distance[z, x]
                # The Blackstone's east face includes long triangles across
                # flat stretches of valid brick. Keep them only on that front
                # wall, within the surveyed parcel and nearly vertical.
                normal = np.abs(np.cross(sides[:, 0], sides[:, 1]))
                blackstone = (east > -103) & (east < -81) & (north > 168) & (north < 222)
                wall = (normal[:, 0] > 2.3 * normal[:, 1]) & (normal[:, 0] > 3 * normal[:, 2])
                joined |= blackstone & wall & (setback <= 4) & (height > 8) & (lengths <= 23**2)
                joined &= (height < 29) | (setback <= 5.5 + (height < 55) * 4)

                # A building-aligned pale triangle can still be a piece of
                # sky. Inspect photographic texels along the silhouette,
                # outside the surveyed exterior, before publishing geometry.
                texture = document["materials"][primitive["material"]]["pbrMetallicRoughness"]["baseColorTexture"]
                atlas = document["images"][document["textures"][texture["index"]]["source"]]
                uv = accessor_data(document, data, primitive["attributes"]["TEXCOORD_0"], "<f4", 2)
                candidate = np.flatnonzero(joined & (height > 42) & (setback >= 1))
                with Image.open(source.parent / atlas["uri"]) as image:
                    photo = np.asarray(image.convert("RGB"), dtype=np.uint8)
                st = uv[faces[candidate]].mean(axis=1)
                pixels = (st * [photo.shape[1], photo.shape[0]]).astype(int).clip([0, 0], np.array(photo.shape[1::-1]) - 1)
                red, green, blue = photo[pixels[:, 1], pixels[:, 0]].astype(np.int16).T
                sky = (blue > 126) & (blue - red > 11) & (blue >= green + 2) & (green > red + 1)
                joined[candidate[sky]] = False

            road = (east > -70) & (east < 151) & (np.abs(north - 166.55) < 11.2)
            piers = (east > -68) & (east < 86) & (np.abs(north - 166.55) < 17.25)
            joined &= ~((road & (height < 17.4) & (height > 8.2)) | (piers & (height < 30) & (height > 9.15)))
            if trees:
                park = park_planting(east, -north)
                joined &= ~(park & (triangles[:, :, 2].max(axis=1) > planting_grade(east, -north) + 0.75))
                near_ends = (east > -76) & (east < 26) & (np.abs(north - 166.55) < 21)
                joined &= ~(near_ends & (height > 12) & (height < 32))
            if facade:
                for z_min, z_max, top, x_min in [(176.0, 204.35, 91.4, -90.6), (204.35, 229.55, 72.8, -91.1),
                                                 (229.55, 256.9, 54.6, -90.2)]:
                    face = (north >= z_min) & (north < z_max) & (east > x_min) & (east < -82.5)
                    joined &= ~(face & (height > 8.0) & (height < top))
            rail = (east > 38) & (east < 91) & (north > 76) & (north < 249)
            joined &= ~(rail & (height < 4.75 + (140 - north) * 0.047))
            kept.append((indices, positions, faces[joined]))

    # Position identities cross atlas seams. A disconnected fleck high above
    # the park is background reconstruction noise, rather than a surface.
    vertices = np.concatenate([positions for _, positions, _ in kept], axis=0)
    _, ids = np.unique(np.rint(vertices * 50).astype(np.int32), axis=0, return_inverse=True)
    ids = ids.reshape(-1)
    bases = np.cumsum([0] + [len(positions) for _, positions, _ in kept])
    topology = np.concatenate([ids[start + faces] for start, (_, _, faces) in zip(bases, kept)], axis=0)
    edge_a = topology.reshape(-1)
    edge_b = np.roll(topology, 1, axis=1).reshape(-1)
    size = int(ids.max() + 1)
    _, labels = connected_components(coo_matrix((np.ones(len(edge_a), dtype=np.uint8), (edge_a, edge_b)), shape=(size, size)).tocsr(), directed=False)
    area_count = np.bincount(labels[topology[:, 0]])
    offset = 0
    for indices, positions, faces in kept:
        components = labels[topology[offset:offset + len(faces), 0]]
        offset += len(faces)
        elevated = positions[faces, 2].mean(axis=1) > 28
        retained = faces[(area_count[components] > 180) | ~elevated].reshape(-1)
        binary.extend(b"\0" * (-len(binary) % 4))
        indices.update(bufferView=len(views), byteOffset=0, count=retained.size)
        indices.pop("min", None)
        indices.pop("max", None)
        views.append({"buffer": 0, "byteOffset": len(binary), "byteLength": retained.nbytes, "target": 34963})
        binary.extend(retained.tobytes())


def write_glb(document, binary, path):
    document["buffers"][0]["byteLength"] = len(binary)
    binary.extend(b"\0" * (-len(binary) % 4))
    data = json.dumps(document, separators=(",", ":")).encode()
    data += b" " * (-len(data) % 4)
    with path.open("wb") as stream:
        stream.write(struct.pack("<4sIII4s", b"glTF", 2, 28 + len(data) + len(binary), len(data), b"JSON"))
        stream.write(data)
        stream.write(struct.pack("<I4s", len(binary), b"BIN\0"))
        stream.write(binary)


def photograph_blackstone(source, destination):
    # First_Flight_-9 shows the three east walls nearly front-on. Rectify
    # observed wall corners in the 1500-pixel-wide reference to full height.
    panels = {
        "blackstone": ([(699, 329), (881, 325), (868, 757), (705, 758)], (1024, 2944)),
        "blackstone-annex": ([(881, 419), (1053, 415), (1026, 752), (868, 757)], (1024, 2376)),
        "spertus": ([(1045, 513), (1207, 507), (1168, 744), (1026, 752)], (1024, 1952)),
    }
    with Image.open(source) as photo:
        scale = photo.width / 1500
        for name, (corners, size) in panels.items():
            width, height = size
            target = [(0, 0), (width, 0), (width, height), (0, height)]
            matrix, values = [], []
            for (x, y), (u, v) in zip(target, np.asarray(corners) * scale):
                matrix += [[x, y, 1, 0, 0, 0, -x * u, -y * u], [0, 0, 0, x, y, 1, -x * v, -y * v]]
                values += [u, v]
            coefficients = np.linalg.solve(matrix, values)
            rectified = photo.transform(size, Image.Transform.PERSPECTIVE, coefficients, Image.Resampling.BICUBIC)
            rectified.convert("RGB").save(destination / f"{name}.jpg", quality=94, subsampling=0)


def plant_trees(source, path):
    asset, data = read_glb(source)
    by_material = defaultdict(list)
    for index in asset["scenes"][asset.get("scene", 0)]["nodes"]:
        node = asset["nodes"][index]
        if set(node) - {"name", "mesh"}:
            raise ValueError("Export the park tree with baked node transforms.")
        for part in asset["meshes"][node["mesh"]]["primitives"]:
            by_material[part["material"]].append(part)

    placements, turns, scales = [], [], []
    random = np.random.default_rng(719)
    for z in [-246, -231, -216, -201, -187, -144, -130, -115, -100, -86, -71, -56, -40, -26]:
        for x in [-69, -55, -40, -26, -11, 4, 18]:
            east, south = np.array([x, z]) + random.uniform(-3.6, 3.6, 2)
            if not park_planting(east, south):
                continue
            height = planting_grade(east, south)
            angle = random.uniform(0, np.pi)
            size = random.uniform(1.08, 1.71)
            placements.append([east, height - 0.18, south])
            turns.append([0, np.sin(angle), 0, np.cos(angle)])
            scales.append([size * random.uniform(0.86, 1.18), size, size])
    instancing = "EXT_mesh_gpu_instancing"
    for material in asset["materials"][:3]:
        pbr = material["pbrMetallicRoughness"]
        pbr["roughnessFactor"] = 0.79
        pbr["baseColorFactor"][0] *= 0.64
        pbr["baseColorFactor"][1] *= 0.72
        pbr["baseColorFactor"][2] *= 0.62
    output = {
        "asset": {"version": "2.0"}, "scene": 0, "scenes": [{"nodes": [0]}],
        "extensionsUsed": [instancing], "extensionsRequired": [instancing],
        "nodes": [{"mesh": 0}], "meshes": [{"primitives": []}],
        "materials": asset["materials"], "buffers": [{}], "bufferViews": [], "accessors": [],
    }
    binary = bytearray()

    def add(values, dtype, kind, component, bounds=False):
        array = np.asarray(values, dtype=dtype)
        views, accessors = output["bufferViews"], output["accessors"]
        binary.extend(b"\0" * (-len(binary) % 4))
        view = {"buffer": 0, "byteOffset": len(binary), "byteLength": array.nbytes}
        accessor = {"bufferView": len(views), "componentType": component, "count": len(array), "type": kind}
        if bounds:
            accessor.update(min=array.min(axis=0).tolist(), max=array.max(axis=0).tolist())
        views.append(view)
        accessors.append(accessor)
        binary.extend(array.tobytes())
        return len(accessors) - 1

    attributes = {"TRANSLATION": add(placements, "<f4", "VEC3", 5126, True),
                  "ROTATION": add(turns, "<f4", "VEC4", 5126), "SCALE": add(scales, "<f4", "VEC3", 5126)}
    output["nodes"][0]["extensions"] = {instancing: {"attributes": attributes}}
    for material, parts in by_material.items():
        positions, normals, indices = [], [], []
        start = 0
        for part in parts:
            points = accessor_data(asset, data, part["attributes"]["POSITION"], "<f4", 3)
            positions.append(points)
            normals.append(accessor_data(asset, data, part["attributes"]["NORMAL"], "<f4", 3))
            part_indices = part["indices"]
            dtype = {5123: "<u2", 5125: "<u4"}[asset["accessors"][part_indices]["componentType"]]
            indices.append(accessor_data(asset, data, part_indices, dtype, 1).ravel().astype(np.uint32) + start)
            start += len(points)
        output["meshes"][0]["primitives"].append({
            "material": material, "indices": add(np.concatenate(indices), "<u4", "SCALAR", 5125),
            "attributes": {"POSITION": add(np.concatenate(positions), "<f4", "VEC3", 5126, True),
                           "NORMAL": add(np.concatenate(normals), "<f4", "VEC3", 5126)},
        })
    grass_material = len(output["materials"])
    output["materials"].append({"name": "Park lawn", "pbrMetallicRoughness": {
        "baseColorFactor": [0.122, 0.175, 0.056, 1], "metallicFactor": 0, "roughnessFactor": 0.94,
    }})
    lawn = []
    for west, east, north, south in PLANTING_BEDS:
        x, z = np.meshgrid(np.linspace(west, east, 32), np.linspace(north, south, 36))
        points = np.stack([x, planting_grade(x, z) - 0.02, z], axis=-1).reshape(-1, 3)
        corner = np.arange(len(points)).reshape(x.shape)[:-1, :-1].ravel()
        triangles = np.stack([corner, corner + 32, corner + 1, corner + 1, corner + 32, corner + 33], axis=1)
        green = (0.76 + 0.19 * random.random(len(points)))[:, None] * [[0.94, 1.0, 0.89]]
        lawn.append({"material": grass_material, "indices": add(triangles.ravel(), "<u4", "SCALAR", 5125),
                     "attributes": {"POSITION": add(points, "<f4", "VEC3", 5126, True),
                                    "NORMAL": add(np.tile([0, 1, 0], (len(points), 1)), "<f4", "VEC3", 5126),
                                    "COLOR_0": add(green, "<f4", "VEC3", 5126)}})
    output["meshes"].append({"primitives": lawn})
    output["nodes"].append({"mesh": 1})
    output["scenes"][0]["nodes"].append(1)
    write_glb(output, binary, path)
    print(f"Anchored {len(placements)} oak trees")


def publish(source, destination, footprints, trees, facade):
    document, binary = read_glb(source)
    envelopes = building_envelopes(footprints) if footprints else None
    remove_bridged_faces(document, binary, envelopes, source, trees, facade)
    scene = document["scenes"][document.get("scene", 0)]
    root_node = {
        "matrix": [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1],
        "children": scene["nodes"],
    }
    scene["nodes"] = [len(document["nodes"])]
    document["nodes"].append(root_node)
    lo, hi = model_bounds(document)
    materials = document["materials"]
    if not all("baseColorTexture" in m.get("pbrMetallicRoughness", {}) for m in materials):
        raise ValueError("Export the reconstructed mesh with its photographic color textures.")
    for material in materials:
        material.setdefault("extensions", {})["KHR_materials_unlit"] = {}
    used = document.setdefault("extensionsUsed", [])
    if "KHR_materials_unlit" not in used:
        used.append("KHR_materials_unlit")
    for image in document["images"]:
        uri = image.pop("uri", None)
        if uri is None:
            continue
        encoded = BytesIO()
        with Image.open(source.parent / uri) as photo:
            photo.convert("RGB").save(encoded, format="JPEG", quality=94, subsampling=0, optimize=True)
        binary.extend(b"\0" * (-len(binary) % 4))
        image["bufferView"] = len(document["bufferViews"])
        image["mimeType"] = "image/jpeg"
        document["bufferViews"].append({"buffer": 0, "byteOffset": len(binary), "byteLength": encoded.tell()})
        binary.extend(encoded.getbuffer())
    # glTF is Y-up. A local OGC tileset bounds the same content in Z-up.
    x, y, z = (lo + hi) * 0.5
    dx, dy, dz = (hi - lo) * 0.5 + 0.02
    root = {
        "boundingVolume": {"box": [x, -z, y, dx, 0, 0, 0, dz, 0, 0, 0, dy]},
        "geometricError": 0,
        "refine": "REPLACE",
        "content": {"uri": "grant-park.glb"},
    }
    tileset = {"asset": {"version": "1.1"}, "geometricError": 0, "root": root}
    destination.mkdir(parents=True, exist_ok=True)
    if trees:
        plant_trees(trees, destination / "park-oaks.glb")
    if facade:
        photograph_blackstone(facade, destination)
    (destination / "tileset.json").write_text(json.dumps(tileset, indent=2), encoding="utf-8")
    write_glb(document, binary, destination / "grant-park.glb")
    print(json.dumps({"min": lo.tolist(), "max": hi.tolist(), "materials": len(materials)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--footprints", type=Path)
    parser.add_argument("--trees", type=Path)
    parser.add_argument("--facade", type=Path)
    args = parser.parse_args()
    publish(args.source, args.destination, args.footprints, args.trees, args.facade)
