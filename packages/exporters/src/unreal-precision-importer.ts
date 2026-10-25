// Unreal 5.8 Editor Python that imports an exact static precision bundle through the official Interchange glTF importer.
import { nativeAppNames } from './native-names.js';

/** Options for {@link createUnrealPrecisionImporter}. Hooks are Python source the application owns. */
export interface UnrealPrecisionImporterOptions {
  /** The owning application: names output folders (`/Game/<appName>Precision_<id>`), metadata keys and log lines. */
  appName: string;
  /** Bundle member holding the application's complete editable source, as named by the manifest. */
  masterFile: string;
  /** Name of the native unlit material asset the importer creates. */
  materialName: string;
  /**
   * Python defining `validate_master(project, manifest)`: checks the parsed source master's structure and that it
   * names every manifest object and material; returns the master's document. Called before any import.
   */
  validateMaster: string;
  /**
   * Python defining `atlas_payload(manifest, master, source_sha)`: the JSON identity string stored on the atlas
   * texture, built from the master's atlas record and `manifest["image"]`.
   */
  atlasPayload: string;
  /**
   * Python statements run inside `import_bundle` (four-space indent) that check the master's atlas pixels against
   * `rgba`; `master_project`, `manifest` and `image` are in scope.
   */
  checkMasterAtlas: string;
}

const hook = (value: unknown, label: string, start: string): string => {
  if (typeof value !== 'string' || !value.startsWith(start) || value.includes('`'))
    throw new TypeError(`${label} must be Python source starting with "${start}"; pass the application's hook`);
  return value;
};

/**
 * The Unreal Editor helper, `Editor/<appName>PrecisionImporter.py` in the bundle. Running
 * `import_bundle(absolute_manifest_path)` imports the bundle's GLB with Interchange into a new owned folder,
 * adapts one unlit material with the original atlas (nearest, clamp), saves a map and checks every source triangle,
 * label, transform and texel before and after save and reopen. It logs `<APPNAME>_UNREAL_PRECISION_STORAGE_PASS_RENDER_GATES_OPEN`.
 * @throws TypeError for an invalid `appName`, file or material name, or a hook that does not define what it should.
 */
export function createUnrealPrecisionImporter(options: UnrealPrecisionImporterOptions): string {
  const n = nativeAppNames(options?.appName);
  if (
    typeof options.masterFile !== 'string' ||
    !/^[A-Za-z0-9_.-]+$/.test(options.masterFile) ||
    /^\.+$/.test(options.masterFile)
  )
    throw new TypeError(
      'masterFile must be a bundle file name of letters, digits, _, - and .; pass the master member name',
    );
  if (typeof options.materialName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(options.materialName))
    throw new TypeError('materialName must be an asset name of letters, digits and _; pass a name like "Material_0"');
  const o = {
    masterFile: options.masterFile,
    materialName: options.materialName,
    validateMaster: hook(options.validateMaster, 'validateMaster', 'def validate_master(project, manifest):'),
    atlasPayload: hook(options.atlasPayload, 'atlasPayload', 'def atlas_payload(manifest, master, source_sha):'),
    checkMasterAtlas: hook(options.checkMasterAtlas, 'checkMasterAtlas', '    '),
  };
  return String.raw`"""${n.name} app-owned bounded static Unreal integration.

Run import_bundle(absolute_manifest_path) in Unreal Editor Python. This module
does not import or modify anything when loaded. Original render-corner, RHI
pixels/shaders and fresh-process persistence require independent native QA.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import struct
import uuid
import zlib

import unreal

PROFILE = "unreal-interchange-static-unlit-rgba8-v1"
IDENTITY_POLICY = "exact-authored-id-name-native-metadata-bijection"
METADATA_KEY = "${n.name}PrecisionIdentityV1"
ATLAS_PARAMETER = "${n.name}OriginalAtlas"
OWNER_PATTERN = r"/Game/${n.name}Precision_[0-9a-f]{32}"
PIPELINES = (
    "/Interchange/Pipelines/DefaultGLTFSceneAssetsPipeline.DefaultGLTFSceneAssetsPipeline",
    "/Interchange/Pipelines/DefaultGLTFPipeline.DefaultGLTFPipeline",
    "/Interchange/Pipelines/DefaultSceneLevelPipeline.DefaultSceneLevelPipeline",
)


def need(condition, message):
    if not condition:
        raise ValueError("${n.upper}_UNREAL_PRECISION: " + message)


def strict_json(data):
    if isinstance(data, (bytes, bytearray)):
        data = data.decode("utf-8", errors="strict")
    need(isinstance(data, str) and not data.startswith("\ufeff"), "UTF-8 JSON without BOM required")
    def pairs(rows):
        result = {}
        for key, value in rows:
            need(key not in result, "Duplicate JSON member")
            result[key] = value
        return result
    def invalid(_value):
        raise ValueError("${n.upper}_UNREAL_PRECISION: Nonfinite JSON number")
    result = json.loads(data, object_pairs_hook=pairs, parse_constant=invalid)
    def finite(value):
        if isinstance(value, float):
            need(math.isfinite(value), "Nonfinite JSON number")
        elif isinstance(value, list):
            for part in value:
                finite(part)
        elif isinstance(value, dict):
            for part in value.values():
                finite(part)
    finite(result)
    return result


def sha(data):
    return hashlib.sha256(data).hexdigest()


def sha_file(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bundle_member(folder, filename):
    need(isinstance(filename, str) and filename and not any(c in filename for c in "/\\:")
         and filename not in (".", "..") and Path(filename).name == filename, "Unsafe bundle member")
    path = folder / filename
    need(path.is_file() and not path.is_symlink() and path.resolve().parent == folder,
         "Bundle member is not an independent regular file")
    return path


def read_member(folder, row, expected_name):
    need(isinstance(row, dict) and row.get("filename") == expected_name
         and re.fullmatch(r"[0-9a-f]{64}", row.get("sha256", "")), "Member contract mismatch")
    path = bundle_member(folder, row["filename"])
    value = path.read_bytes()
    need(sha(value) == row["sha256"], "Original member SHA-256 mismatch: " + expected_name)
    return path, value


def decode_glb(data):
    need(len(data) >= 28 and struct.unpack_from("<III", data) == (0x46546C67, 2, len(data)), "Invalid complete GLB")
    length, kind = struct.unpack_from("<II", data, 12)
    need(kind == 0x4E4F534A and length % 4 == 0 and 28 + length <= len(data), "Invalid JSON chunk")
    g = strict_json(data[20:20 + length])
    size, kind = struct.unpack_from("<II", data, 20 + length)
    need(kind == 0x004E4942 and size % 4 == 0 and 28 + length + size == len(data), "Invalid BIN chunk")
    binary = memoryview(data)[28 + length:]
    need(g.get("asset", {}).get("version") == "2.0" and len(g.get("buffers", [])) == 1
         and "uri" not in g["buffers"][0] and type(g["buffers"][0].get("byteLength")) is int
         and 0 <= size - g["buffers"][0]["byteLength"] <= 3, "One embedded physical original buffer required")
    need(set(g.get("extensionsUsed", [])) == {"KHR_materials_unlit"}
         and set(g.get("extensionsRequired", [])) <= {"KHR_materials_unlit"}, "Unsupported GLB extension")
    need(not g.get("animations") and not g.get("skins"), "Static source profile only")
    return g, binary


def png_pixels(data):
    # Lossless PNG8 source-art decoder; not a GPU or platform-mip readback.
    need(data[:8] == b"\x89PNG\r\n\x1a\n", "Original embedded PNG required")
    at, compressed, palette, alpha, header, ended = 8, bytearray(), None, b"", None, False
    while at < len(data):
        need(at + 12 <= len(data), "Truncated PNG")
        length = struct.unpack_from(">I", data, at)[0]
        need(at + length + 12 <= len(data), "Truncated PNG chunk")
        tag, payload = data[at + 4:at + 8], data[at + 8:at + 8 + length]
        need(zlib.crc32(tag + payload) & 0xffffffff == struct.unpack_from(">I", data, at + 8 + length)[0], "PNG CRC mismatch")
        if tag == b"IHDR":
            need(header is None and at == 8 and length == 13, "PNG IHDR order")
            header = struct.unpack(">IIBBBBB", payload)
        elif tag == b"IDAT":
            need(header is not None, "PNG data before header")
            compressed.extend(payload)
        elif tag == b"PLTE":
            need(length % 3 == 0, "PNG palette shape")
            palette = [payload[i:i + 3] for i in range(0, length, 3)]
        elif tag == b"tRNS":
            alpha = payload
        elif tag == b"IEND":
            need(length == 0 and at + 12 == len(data), "PNG trailing data")
            ended = True
            break
        else:
            need(tag[:1].islower(), "Unsupported critical PNG chunk")
        at += length + 12
    need(header is not None and ended, "Incomplete PNG")
    width, height, depth, color, compression, filtering, interlace = header
    need(width > 0 and height > 0 and depth == 8 and compression == filtering == interlace == 0
         and color in (0, 2, 3, 4, 6) and (not alpha or color == 3), "Supported original PNG8 profile required")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    raw = zlib.decompress(compressed)
    need(len(raw) == height * (1 + width * channels), "PNG scanline dimensions")
    rgba, previous = bytearray(), bytearray(width * channels)
    for y in range(height):
        offset = y * (1 + width * channels)
        mode, line = raw[offset], bytearray(raw[offset + 1:offset + 1 + width * channels])
        need(mode <= 4, "Invalid PNG filter")
        for x in range(len(line)):
            left = line[x - channels] if x >= channels else 0
            up, upper = previous[x], previous[x - channels] if x >= channels else 0
            predictor = 0
            if mode == 1:
                predictor = left
            elif mode == 2:
                predictor = up
            elif mode == 3:
                predictor = (left + up) // 2
            elif mode == 4:
                value = left + up - upper
                distances = (abs(value - left), abs(value - up), abs(value - upper))
                predictor = (left, up, upper)[distances.index(min(distances))]
            line[x] = (line[x] + predictor) & 255
        for x in range(width):
            value = line[x * channels:(x + 1) * channels]
            if color == 6:
                rgba.extend(value)
            elif color == 2:
                rgba.extend(value + b"\xff")
            elif color == 0:
                rgba.extend(bytes((value[0], value[0], value[0], 255)))
            elif color == 4:
                rgba.extend(bytes((value[0], value[0], value[0], value[1])))
            else:
                need(palette is not None and value[0] < len(palette), "Invalid PNG palette index")
                rgba.extend(palette[value[0]] + bytes((alpha[value[0]] if value[0] < len(alpha) else 255,)))
        previous = line
    return width, height, bytes(rgba)


def numeric_tuple(value, count):
    need(isinstance(value, (list, tuple)) and len(value) == count and
         all(type(part) in (int, float) and math.isfinite(part) for part in value), "Finite complete tuple required")
    return tuple(float(part) for part in value)


def array_item(values, index):
    need(isinstance(values, list) and type(index) is int and 0 <= index < len(values), "Physical original array index out of bounds")
    return values[index]


def original_accessor(g, binary, index):
    accessor = array_item(g.get("accessors"), index)
    view = array_item(g.get("bufferViews"), accessor.get("bufferView"))
    widths, kinds = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}, {5121: "B", 5123: "H", 5125: "I", 5126: "f"}
    need(accessor.get("type") in widths and accessor.get("componentType") in kinds
         and "sparse" not in accessor and not accessor.get("normalized") and view.get("buffer", 0) == 0,
         "Supported original physical accessor required")
    fmt = "<" + kinds[accessor["componentType"]] * widths[accessor["type"]]
    packed = struct.calcsize(fmt)
    start, length, offset, count = view.get("byteOffset", 0), view.get("byteLength"), accessor.get("byteOffset", 0), accessor.get("count")
    stride = view.get("byteStride", packed)
    need(all(type(value) is int for value in (start, length, offset, count, stride))
         and min(start, offset) >= 0 and count > 0 and stride >= packed and length >= packed
         and start + length <= len(binary) and offset + (count - 1) * stride + packed <= length,
         "Complete original accessor byte bounds required")
    for item in range(count):
        value = struct.unpack_from(fmt, binary, start + offset + item * stride)
        need(all(math.isfinite(part) for part in value), "Nonfinite original physical accessor")
        yield value


${o.validateMaster}


def source_inventory(g, manifest, binary, rgba):
    nodes, rows = g.get("nodes", []), manifest.get("objects", [])
    need(nodes and len(nodes) == len(rows) and len(g.get("scenes", [])) == 1 and g.get("scene", 0) == 0,
         "Complete active source scene inventory required")
    by_id, by_index, parents = {}, {}, [-1] * len(nodes)
    for row in rows:
        need(isinstance(row, dict) and isinstance(row.get("id"), str) and row["id"].strip()
             and row["id"] not in by_id and type(row.get("glbNodeIndex")) is int
             and 0 <= row["glbNodeIndex"] < len(nodes) and row["glbNodeIndex"] not in by_index,
             "Bijective original object IDs and GLB indices required")
        by_id[row["id"]] = row
        by_index[row["glbNodeIndex"]] = row
    for index, node in enumerate(nodes):
        row = by_index[index]
        need(isinstance(row.get("name"), str) and row["name"] and row["name"] == node.get("name")
             and not any(key in node for key in ("matrix", "skin", "weights", "extensions")), "Exact original static authored node required")
        transform = strict_json(row["authoredTransformJSON"])
        need(set(transform) == {"position", "rotation", "scale"}, "Complete authored local transform metadata required")
        for authored, gltf, default, count in (("position", "translation", [0, 0, 0], 3),
                                               ("rotation", "rotation", [0, 0, 0, 1], 4),
                                               ("scale", "scale", [1, 1, 1], 3)):
            original = numeric_tuple(transform[authored], count)
            exported = numeric_tuple(node.get(gltf, default), count)
            rounded = tuple(struct.unpack("<f", struct.pack("<f", value))[0] for value in original)
            native = tuple(struct.unpack("<f", struct.pack("<f", value))[0] for value in exported)
            need(all(math.isfinite(value) for value in rounded + native), "Finite native Float32 transform required")
            if authored == "rotation":
                # The engine writer keeps a quaternion within 1e-5 of unit length
                # exactly and scales any other to unit length, sign kept. Python/JS
                # hypot can round differently: the app verifier proves exact JS JSON;
                # this storage adapter checks the scaled case within eight binary64 ulps.
                length = math.hypot(*original)
                need(math.isfinite(length) and length > 0, "Nonzero source quaternion required")
                if abs(length - 1) <= 1e-5:
                    need(exported == original, "Original GLB quaternion must retain the authored values")
                else:
                    tolerance = 8 * math.ulp(1.0)
                    need(all(abs(actual - value / length) <= tolerance for actual, value in zip(exported, original)),
                         "Original GLB quaternion must retain bounded unit scaling")
            else:
                need(exported == original, "Original GLB translation/scale must retain the exact authored values")
            need(all(after == expected and abs(before - actual) <= 1e-5 and abs(before - after) <= 1e-5
                     for before, actual, expected, after in zip(original, exported, rounded, native)),
                 "Original GLB must retain the exact bounded native Float32 authored transform")
        for child in node.get("children", []):
            need(type(child) is int and 0 <= child < len(nodes) and parents[child] == -1,
                 "Unique original hierarchy parent required")
            parents[child] = index
    for index, row in by_index.items():
        need(row.get("parentId") == (None if parents[index] < 0 else by_index[parents[index]]["id"]),
             "Manifest source ID hierarchy differs from original GLB")
    roots = g["scenes"][0].get("nodes", [])
    need(isinstance(roots, list) and len(set(roots)) == len(roots)
         and set(roots) == {i for i, parent in enumerate(parents) if parent < 0}, "Complete active source roots required")
    seen, pending = set(), list(roots)
    while pending:
        index = pending.pop()
        need(type(index) is int and 0 <= index < len(nodes) and index not in seen, "Acyclic complete source hierarchy required")
        seen.add(index)
        pending.extend(nodes[index].get("children", []))
    need(len(seen) == len(nodes), "Inactive original nodes unsupported")
    materials = manifest.get("materials", [])
    need(len(materials) == len(g.get("materials", [])) == 1, "Initial single-material profile required")
    material, mrow = g["materials"][0], materials[0]
    need(mrow.get("glbMaterialIndex") == 0 and isinstance(mrow.get("id"), str) and mrow["id"].strip()
         and isinstance(mrow.get("sourceAssetId"), str) and mrow["sourceAssetId"].strip()
         and mrow.get("name") == material.get("name") and isinstance(mrow["name"], str), "Exact source material identity required")
    pbr = material.get("pbrMetallicRoughness", {})
    need(material.get("alphaMode", "OPAQUE") == "OPAQUE" and material.get("doubleSided") is True
         and material.get("extensions") == {"KHR_materials_unlit": {}}
         and set(material) <= {"name", "pbrMetallicRoughness", "alphaMode", "doubleSided", "extensions"}
         and set(pbr) <= {"baseColorTexture", "baseColorFactor", "metallicFactor", "roughnessFactor"}
         and pbr.get("baseColorFactor", [1, 1, 1, 1]) == [1, 1, 1, 1]
         and pbr.get("baseColorTexture") == {"index": 0}, "Opaque double-sided basic unlit original material only")
    need(len(g.get("textures", [])) == len(g.get("images", [])) == len(g.get("samplers", [])) == 1
         and g["textures"][0] == {"sampler": 0, "source": 0}
         and g["samplers"][0] == {"magFilter": 9728, "minFilter": 9728, "wrapS": 33071, "wrapT": 33071},
         "Exact original nearest/clamp single atlas required")
    image = g["images"][0]
    need(image.get("mimeType") == "image/png" and "uri" not in image, "Embedded original PNG required")
    view = array_item(g.get("bufferViews"), image.get("bufferView"))
    start, length = view.get("byteOffset", 0), view["byteLength"]
    need(type(start) is int and type(length) is int and start >= 0 and length > 0
         and view.get("buffer", 0) == 0 and start + length <= len(binary), "Physical embedded PNG bounds required")
    need(png_pixels(bytes(binary[start:start + length])) == (manifest["image"]["width"], manifest["image"]["height"], rgba),
         "Every original embedded PNG pixel and source dimension must match atlas.rgba")
    triangles = 0
    for node in nodes:
        if "mesh" not in node:
            continue
        need(type(node["mesh"]) is int and 0 <= node["mesh"] < len(g.get("meshes", [])), "Original mesh index")
        for primitive in g["meshes"][node["mesh"]]["primitives"]:
            need(primitive.get("mode", 4) == 4 and primitive.get("material") == 0
                 and not primitive.get("targets") and not primitive.get("extensions")
                 and set(primitive["attributes"]) == {"POSITION", "NORMAL", "TEXCOORD_0", "COLOR_0"}, "Complete original static attributes required")
            index = array_item(g.get("accessors"), primitive.get("indices"))
            need(index.get("type") == "SCALAR" and index.get("componentType") in (5121, 5123, 5125)
                 and type(index.get("count")) is int and index["count"] > 0 and index["count"] % 3 == 0
                 and not index.get("normalized") and "sparse" not in index, "Complete original triangle indices required")
            triangles += index["count"] // 3
            streams = []
            for name, kind in (("POSITION", "VEC3"), ("NORMAL", "VEC3"), ("TEXCOORD_0", "VEC2"), ("COLOR_0", "VEC4")):
                stream_index = primitive["attributes"][name]
                stream = array_item(g.get("accessors"), stream_index)
                need(stream.get("type") == kind and stream.get("componentType") == 5126 and "sparse" not in stream
                     and not stream.get("normalized") and type(stream.get("count")) is int and stream["count"] > 0,
                     "Complete raw Float32 original attributes required")
                streams.append(stream)
                for value in original_accessor(g, binary, stream_index):
                    if name == "COLOR_0":
                        need(value == (1, 1, 1, 1), "Initial unlit profile requires exact white original corner RGBA")
            need(len({stream["count"] for stream in streams}) == 1, "Associated original vertex streams must be complete")
            for value in original_accessor(g, binary, primitive["indices"]):
                need(0 <= value[0] < streams[0]["count"], "Actual original index references missing vertex")
    need(triangles > 0 and triangles == manifest.get("triangles"), "Complete original triangle total required")
    return {"parents": parents, "byIndex": by_index, "triangles": triangles}


def expected_actor_uids(g, parents):
    scene = "\\Scene\\geometry_scene_0"
    expected = {"Factory_" + scene: (None, "", scene)}
    pending = [(index, scene) for index in g["scenes"][0]["nodes"]]
    while pending:
        index, parent = pending.pop()
        translated = parent + "\\geometry_node_" + str(index)
        uid = "Factory_" + translated
        need(uid not in expected, "Duplicate original source UID")
        expected[uid] = (index, "Factory_" + parent, translated)
        for child in g["nodes"][index].get("children", []):
            need(parents[child] == index, "Original UID parent mismatch")
            pending.append((child, translated))
    need(len(expected) == len(g["nodes"]) + 1, "Exhaustive source actor UID graph required")
    return expected


def owned_asset(value, owner):
    path = value.get_path_name()
    need(re.fullmatch(OWNER_PATTERN, owner) and path.startswith(owner + "/"), "Refusing non-owned native asset")
    return path


def comparable(value):
    # Struct wrappers (SoftObjectPath) compare by identity in Python, so a read-back copy never equals the value set:
    # compare their exported text (the object path) instead.
    if isinstance(value, unreal.StructBase):
        return value.export_text()
    return value


def set_exact(owner, name, value):
    owner.set_editor_property(name, value)
    actual = owner.get_editor_property(name)
    # Reflected arrays and FName values retain native wrappers in Python.
    if isinstance(value, list):
        actual, value = [comparable(item) for item in actual], [comparable(item) for item in value]
    elif isinstance(value, str):
        actual = str(actual)
    else:
        actual, value = comparable(actual), comparable(value)
    need(actual == value, "Native setting did not stick: " + name)


def reference_matches(factory, obj):
    reference = factory.get_custom_reference_object()
    expected = unreal.SystemLibrary.get_soft_object_path(obj)
    need(isinstance(reference, unreal.SoftObjectPath) and isinstance(expected, unreal.SoftObjectPath), "Native soft reference type required")
    actual_tuple, expected_tuple = reference.to_tuple(), expected.to_tuple()
    need(isinstance(actual_tuple, tuple) and len(actual_tuple) == 1 and isinstance(actual_tuple[0], str)
         and actual_tuple == expected_tuple and actual_tuple[0] == obj.get_path_name()
         and unreal.SystemLibrary.get_object_from_soft_path(reference) == obj, "Actual factory/native object identity mismatch")


def inspect_actor_uids(g, inventory, source, destination):
    expected, mapped, observed, containers = expected_actor_uids(g, inventory["parents"]), {}, {}, {}
    actors = unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors()
    need(len(actors) == len(expected), "Every actual actor including explicit wrapper must be accounted for")
    for actor in actors:
        root = actor.root_component
        need(root is not None, "Actual source actor root required")
        data = list(root.get_editor_property("asset_user_data")) + list(root.get_editor_property("asset_user_data_editor_only"))
        data = [value for value in data if isinstance(value, unreal.InterchangeUserData)]
        need(len(data) == 1, "Exactly one official actor Interchange identity required")
        metadata = {str(k): str(v) for k, v in data[0].get_editor_property("metadata").items()}
        uid, import_path = metadata.get("InterchangeFactoryNodeUid"), metadata.get("InterchangeSceneImportAssetPath")
        need(uid in expected and uid not in observed and isinstance(import_path, str)
             and import_path.startswith(destination + "/"), "Unknown, duplicate or foreign actual actor UID")
        if import_path not in containers:
            scene_asset = unreal.load_asset(import_path)
            need(isinstance(scene_asset, unreal.InterchangeSceneImportAsset), "Original scene import owner missing")
            data = scene_asset.get_editor_property("asset_import_data")
            need(isinstance(data, unreal.InterchangeAssetImportData)
                 and [Path(p).resolve() for p in data.script_extract_filenames()] == [source], "Exact original imported source required")
            container = data.get_node_container()
            uids = list(container.get_nodes(unreal.InterchangeActorFactoryNode))
            need(len(uids) == len(expected) and set(uids) == set(expected)
                 and not list(container.get_nodes(unreal.InterchangeSceneNode)), "Exact official persisted factory-only graph required")
            containers[import_path] = container
        container = containers[import_path]
        factory = container.get_factory_node(uid)
        index, parent, target = expected[uid]
        need(isinstance(factory, unreal.InterchangeActorFactoryNode) and factory.get_unique_id() == uid
             and factory.get_parent_uid() == parent and list(factory.get_target_node_uids()) == [target],
             "Exact original actor factory targets/ancestry required before adaptation")
        reference_matches(factory, actor)
        observed[uid] = actor
        if index is not None:
            mapped[index] = actor
    need(len(containers) == 1 and set(observed) == set(expected), "Single exhaustive original scene import required")
    for uid, actor in observed.items():
        parent = expected[uid][1]
        need(actor.get_attach_parent_actor() == (observed[parent] if parent else None), "Exact original native hierarchy required")
    wrapper = observed["Factory_\\Scene\\geometry_scene_0"]
    need(wrapper.get_class().get_name() == "Actor" and not wrapper.get_attach_parent_actor()
         and not wrapper.get_components_by_class(unreal.PrimitiveComponent)
         and len(wrapper.get_components_by_class(unreal.ActorComponent)) == 1, "Explicit official wrapper must be ordinary, empty and accounted for")
    check_local_trs(wrapper.root_component.get_relative_transform(), {})
    check_local_trs(wrapper.root_component.get_world_transform(), {})
    for index, actor in mapped.items():
        check_local_trs(actor.root_component.get_relative_transform(), g["nodes"][index])
    return mapped, wrapper, next(iter(containers.values()))


def check_local_trs(transform, node):
    position = numeric_tuple(node.get("translation", [0, 0, 0]), 3)
    rotation = numeric_tuple(node.get("rotation", [0, 0, 0, 1]), 4)
    scale = numeric_tuple(node.get("scale", [1, 1, 1]), 3)
    expected_p, expected_q, expected_s = (position[0], position[2], position[1]), (-rotation[0], -rotation[2], -rotation[1], rotation[3]), (scale[0], scale[2], scale[1])
    actual_p = (transform.translation.x / 100, transform.translation.y / 100, transform.translation.z / 100)
    actual_q = (transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w)
    actual_s = (transform.scale3d.x, transform.scale3d.y, transform.scale3d.z)
    need(all(math.isfinite(value) for value in actual_p + actual_q + actual_s)
         and max(abs(a-b) for a, b in zip(actual_p, expected_p)) <= 1e-5
         and min(max(abs(a-b) for a, b in zip(actual_q, expected_q)), max(abs(a+b) for a, b in zip(actual_q, expected_q))) <= 1e-5
         and max(abs(a-b) for a, b in zip(actual_s, expected_s)) <= 1e-5,
         "Actual native local TRS differs from original source basis")


def material_source_index(material, source, destination, container):
    need(material.get_path_name().startswith(destination + "/"), "Actual bound original material must be owned")
    data = unreal.InterchangeManager.get_interchange_manager_scripted().get_asset_import_data(material)
    need(isinstance(data, unreal.InterchangeAssetImportData)
         and [Path(p).resolve() for p in data.script_extract_filenames()] == [source], "Actual bound material requires exact original import data")
    uid = data.get_editor_property("node_unique_id")
    need(uid == "Factory_\\Shaders\\geometry_material_0", "Actual bound material must match original source array UID")
    factory = container.get_factory_node(uid)
    need(isinstance(factory, unreal.InterchangeFactoryBaseNode)
         and factory.get_class().get_name() in ("InterchangeMaterialFactoryNode", "InterchangeMaterialInstanceFactoryNode")
         and factory.get_unique_id() == uid and list(factory.get_target_node_uids()) in ([], ["\\Shaders\\geometry_material_0"]),
         "Exact persisted final material factory required")
    reference_matches(factory, material)
    return 0


def import_original(source, destination, report):
    outer, pipelines = unreal.find_object(None, "/Engine/Transient"), []
    need(outer is not None, "Engine transient package required")
    for template_path in PIPELINES:
        template = unreal.load_asset(template_path)
        need(template is not None, "Official installed GLTF pipeline missing")
        pipeline = unreal.SystemLibrary.duplicate_object(template, outer, "${n.name}Precision_" + uuid.uuid4().hex)
        need(pipeline is not None and pipeline != template, "Independent transient official pipeline required")
        pipelines.append(pipeline)
    assets, gltf, level = pipelines
    need(isinstance(assets, unreal.InterchangeGenericAssetsPipeline) and isinstance(gltf, unreal.InterchangeGLTFPipeline)
         and isinstance(level, unreal.InterchangeGenericLevelPipeline), "Pinned official pipeline classes changed")
    common = assets.get_editor_property("common_meshes_properties")
    for key, value in {"bake_meshes": False, "recompute_normals": False, "recompute_tangents": False,
                       "use_high_precision_tangent_basis": True, "use_full_precision_u_vs": True, "remove_degenerates": False}.items():
        set_exact(common, key, value)
    mesh = assets.get_editor_property("mesh_pipeline")
    for key, value in {"build_nanite": False, "generate_lightmap_u_vs": False, "collision": False, "import_skeletal_meshes": False}.items():
        set_exact(mesh, key, value)
    set_exact(level, "scene_hierarchy_type", unreal.InterchangeSceneHierarchyType.CREATE_LEVEL_ACTORS)
    parameters = unreal.ImportAssetParameters()
    set_exact(parameters, "is_automated", True)
    set_exact(parameters, "replace_existing", False)
    set_exact(parameters, "override_pipelines", [unreal.SoftObjectPath(p.get_path_name()) for p in pipelines])
    report["pipelineTemplates"] = list(PIPELINES)
    need(unreal.InterchangeManager.get_interchange_manager_scripted().import_scene(
        destination, unreal.InterchangeManager.create_source_data(str(source)), parameters), "Official exact original GLB import failed")


def identity_payload(kind, row, source_sha):
    value = {"version": 1, "kind": kind, "sourceGlbSha256": source_sha, "id": row["id"], "name": row["name"]}
    if kind == "object":
        value.update({"parentId": row["parentId"], "glbNodeIndex": row["glbNodeIndex"], "authoredTransformJSON": row["authoredTransformJSON"]})
    elif kind == "material":
        value.update({"glbMaterialIndex": row["glbMaterialIndex"], "sourceAssetId": row["sourceAssetId"]})
    else:
        need(False, "Unknown authored metadata kind")
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"), allow_nan=False)


${o.atlasPayload}


def set_identity(obj, payload, owner):
    # Actor metadata lives in the uniquely owned map package; asset metadata in
    # uniquely owned packages. Names/IDs are JSON string values, never FName keys.
    need(owned_native_object(obj, owner), "Metadata target must belong to the new owned output")
    unreal.EditorAssetLibrary.set_metadata_tag(obj, METADATA_KEY, payload)
    need(unreal.EditorAssetLibrary.get_metadata_tag(obj, METADATA_KEY) == payload,
         "Exact durable authored ID/name metadata did not stick")


def owned_native_object(obj, owner):
    path = obj.get_path_name()
    return re.fullmatch(OWNER_PATTERN, owner) is not None and path.startswith(owner + "/")


def apply_labels(mapped, inventory, source_sha, owner):
    labels = []
    for index, actor in mapped.items():
        row = inventory["byIndex"][index]
        need(owned_native_object(actor, owner), "Actor must belong to the fresh owned map")
        actor.set_actor_label(row["name"], True)
        need(actor.get_actor_label() == row["name"], "Engine cannot represent the exact authored display label")
        payload = identity_payload("object", row, source_sha)
        set_identity(actor, payload, owner)
        labels.append({"id": row["id"], "name": row["name"], "glbNodeIndex": index,
                       "nativeActor": actor.get_path_name(), "metadataJSON": payload})
    return labels


def source_texture_pixels(texture, directory, name, expected):
    target = directory / name
    need(not target.exists(), "Refusing texture evidence overwrite")
    task = unreal.AssetExportTask()
    for key, value in {"object": texture, "filename": str(target), "automated": True,
                       "prompt": False, "replace_identical": False, "exporter": unreal.TextureExporterPNG()}.items():
        task.set_editor_property(key, value)
    need(unreal.Exporter.run_asset_export_task(task) is True and target.is_file(), "Actual native texture source-art export unavailable")
    decoded = png_pixels(target.read_bytes())
    need(decoded == expected, "Actual native texture source-art lost original pixels or dimensions")
    return sha(decoded[2])


def texture_policy():
    return {"compression_settings": unreal.TextureCompressionSettings.TC_VECTOR_DISPLACEMENTMAP,
            # TC_VECTOR_DISPLACEMENTMAP is stored uncompressed (8 bits per channel); UE 5.8 has no compression_none,
            # so lossy compression is ruled out explicitly instead.
            "lossy_compression_amount": unreal.TextureLossyCompressionAmount.TLCA_NONE, "compression_no_alpha": False,
            "mip_gen_settings": unreal.TextureMipGenSettings.TMGS_NO_MIPMAPS,
            "max_texture_size": 0, "lod_bias": 0, "num_cinematic_mip_levels": 0,
            "filter": unreal.TextureFilter.TF_NEAREST, "address_x": unreal.TextureAddress.TA_CLAMP,
            "address_y": unreal.TextureAddress.TA_CLAMP, "srgb": True,
            "never_stream": True, "virtual_texture_streaming": False,
            "power_of_two_mode": unreal.TexturePowerOfTwoSetting.NONE,
            "adjust_brightness": 1.0, "adjust_brightness_curve": 1.0, "adjust_hue": 0.0,
            "adjust_rgb_curve": 1.0, "adjust_saturation": 1.0, "adjust_vibrance": 0.0,
            "adjust_min_alpha": 0.0, "adjust_max_alpha": 1.0, "flip_green_channel": False,
            "chroma_key_texture": False, "composite_texture": None}


def configure_texture(texture, owner):
    owned_asset(texture, owner)
    for key, value in texture_policy().items():
        set_exact(texture, key, value)


def check_texture_policy(texture, owner):
    owned_asset(texture, owner)
    for key, value in texture_policy().items():
        need(texture.get_editor_property(key) == value, "Persistent native texture policy differs: " + key)


def create_unlit(texture, owner, row, source_sha):
    assets = unreal.AssetToolsHelpers.get_asset_tools()
    material = assets.create_asset("${o.materialName}", owner + "/Adapted", unreal.Material, unreal.MaterialFactoryNew())
    need(isinstance(material, unreal.Material), "Fresh app-owned native material creation failed")
    owned_asset(material, owner)
    for key, value in {"shading_model": unreal.MaterialShadingModel.MSM_UNLIT, "two_sided": True,
                       "blend_mode": unreal.BlendMode.BLEND_OPAQUE, "material_domain": unreal.MaterialDomain.MD_SURFACE,
                       "use_material_attributes": False}.items():
        set_exact(material, key, value)
    sample = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionTextureSampleParameter2D, -300, 0)
    need(isinstance(sample, unreal.MaterialExpressionTextureSampleParameter2D), "Native texture sample expression unavailable")
    for key, value in {"texture": texture, "sampler_type": unreal.MaterialSamplerType.SAMPLERTYPE_COLOR,
                       "sampler_source": unreal.SamplerSourceMode.SSM_FROM_TEXTURE_ASSET,
                       "const_coordinate": 0, "automatic_view_mip_bias": False, "parameter_name": ATLAS_PARAMETER}.items():
        set_exact(sample, key, value)
    need(unreal.MaterialEditingLibrary.connect_material_property(sample, "RGB", unreal.MaterialProperty.MP_EMISSIVE_COLOR) is True,
         "Actual native Unlit emissive graph connection failed")
    unreal.MaterialEditingLibrary.recompile_material(material)
    set_identity(material, identity_payload("material", row, source_sha), owner)
    inspect_unlit(material, texture, owner, row, source_sha)
    return material


def inspect_unlit(material, texture, owner, row, source_sha):
    owned_asset(material, owner)
    need(isinstance(material, unreal.Material)
         and material.get_editor_property("shading_model") == unreal.MaterialShadingModel.MSM_UNLIT
         and material.get_editor_property("two_sided") is True
         and material.get_editor_property("blend_mode") == unreal.BlendMode.BLEND_OPAQUE
         and material.get_editor_property("material_domain") == unreal.MaterialDomain.MD_SURFACE
         and material.get_editor_property("use_material_attributes") is False, "Actual bounded Unlit material state differs")
    lib = unreal.MaterialEditingLibrary
    expressions = list(lib.get_material_expressions(material))
    need(len(expressions) == 1 and isinstance(expressions[0], unreal.MaterialExpressionTextureSampleParameter2D), "Exact single-node native graph required")
    sample = expressions[0]
    for key, value in {"texture": texture, "sampler_type": unreal.MaterialSamplerType.SAMPLERTYPE_COLOR,
                       "sampler_source": unreal.SamplerSourceMode.SSM_FROM_TEXTURE_ASSET,
                       "const_coordinate": 0, "automatic_view_mip_bias": False, "parameter_name": ATLAS_PARAMETER}.items():
        actual = sample.get_editor_property(key)
        need((str(actual) if key == "parameter_name" else actual) == value, "Actual texture sample binding differs: " + key)
    need(lib.get_material_property_input_node(material, unreal.MaterialProperty.MP_EMISSIVE_COLOR) == sample
         and lib.get_material_property_input_node_output_name(material, unreal.MaterialProperty.MP_EMISSIVE_COLOR) == "RGB",
         "Actual native emissive source/output differs")
    # The single sample node above already binds only the atlas; the compiled list is empty when no shader map exists
    # (an unattended -NullRHI editor), and must be exactly the atlas otherwise.
    used = list(lib.get_material_used_textures(material))
    need(used in ([], [texture]), "Actual native graph must bind only the exact owned atlas")
    for name in ("MP_BASE_COLOR", "MP_OPACITY", "MP_OPACITY_MASK", "MP_NORMAL", "MP_WORLD_POSITION_OFFSET", "MP_MATERIAL_ATTRIBUTES"):
        need(lib.get_material_property_input_node(material, getattr(unreal.MaterialProperty, name)) is None,
             "Unexpected native material input: " + name)
    need(unreal.EditorAssetLibrary.get_metadata_tag(material, METADATA_KEY) == identity_payload("material", row, source_sha),
         "Exact native material metadata identity differs")


def native_storage_fingerprint(mapped, g, owner, expected_triangles):
    # Bulk actual SOURCE_MODEL topology/positions/sections plus local state.
    # This is deliberately NOT a split normal/UV/color corner measurement.
    # Public per-vertex overlay APIs average or choose arbitrary split values;
    # those APIs are never used as substitutes for independent native QA.
    digest, triangles, components = hashlib.sha256(), 0, []
    query = unreal.GeometryScript_MeshQueries
    def numbers(values):
        for value in values:
            need(math.isfinite(value), "Nonfinite actual native geometry")
            digest.update(struct.pack("<d", value))
    for index in sorted(mapped):
        actor = mapped[index]
        root = actor.root_component
        need(root is not None and owned_native_object(actor, owner), "Native owned actor/root required")
        transform = root.get_relative_transform()
        numbers((transform.translation.x, transform.translation.y, transform.translation.z,
                 transform.rotation.x, transform.rotation.y, transform.rotation.z, transform.rotation.w,
                 transform.scale3d.x, transform.scale3d.y, transform.scale3d.z))
        native = list(actor.get_components_by_class(unreal.StaticMeshComponent))
        primitives = list(actor.get_components_by_class(unreal.PrimitiveComponent))
        if "mesh" not in g["nodes"][index]:
            need(not native and not primitives, "Empty original source node gained native geometry")
            continue
        need(len(native) == len(primitives) == 1 and native[0].get_class().get_name() == "StaticMeshComponent",
             "Exactly one ordinary native component per original mesh node required")
        component, mesh = native[0], native[0].static_mesh
        owned_asset(mesh, owner)
        need(mesh.get_num_lods() == 1 and mesh.get_editor_property("nanite_settings").get_editor_property("enabled") is False,
             "One complete original LOD without Nanite substitution required")
        settings = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem).get_lod_build_settings(mesh, 0)
        for key, value in {"recompute_normals": False, "recompute_tangents": False, "remove_degenerates": False,
                           "use_high_precision_tangent_basis": True, "use_full_precision_u_vs": True,
                           "generate_lightmap_u_vs": False}.items():
            need(settings.get_editor_property(key) == value, "Actual native precision mesh build state differs: " + key)
        options, lod = unreal.GeometryScriptCopyMeshFromAssetOptions(), unreal.GeometryScriptMeshReadLOD()
        set_exact(options, "apply_build_settings", False)
        set_exact(options, "use_build_scale", True)
        set_exact(lod, "lod_type", unreal.GeometryScriptLODType.SOURCE_MODEL)
        set_exact(lod, "lod_index", 0)
        copied, outcome = unreal.GeometryScript_AssetUtils.copy_mesh_from_static_mesh(mesh, unreal.DynamicMesh(), options, lod)
        need(outcome == unreal.GeometryScriptOutcomePins.SUCCESS, "Actual native source-model readback unavailable")
        _mesh, triangle_list, triangle_gaps = query.get_all_triangle_indices(copied, False)
        _mesh, position_list, vertex_gaps = query.get_all_vertex_positions(copied, False)
        _mesh, material_list, has_materials = unreal.GeometryScript_Materials.get_all_triangle_material_i_ds(copied)
        need(triangle_gaps is False and vertex_gaps is False and has_materials is True,
             "Complete dense native bulk topology/position/section lists required")
        lists = unreal.GeometryScript_List
        indices = lists.convert_triangle_list_to_array(triangle_list)
        positions = lists.convert_vector_list_to_array(position_list)
        sections = lists.convert_index_list_to_array(material_list)
        need(len(indices) > 0 and len(positions) > 0 and len(sections) == len(indices)
             and component.get_num_materials() == 1, "Complete actual native bulk stream association required")
        digest.update(struct.pack("<iii", index, len(positions), len(indices)))
        for position in positions:
            numbers((position.x, position.y, position.z))
        for triangle, section in zip(indices, sections):
            values = (triangle.x, triangle.y, triangle.z)
            need(all(type(value) is int and 0 <= value < len(positions) for value in values)
                 and type(section) is int and section == 0, "Actual native index/section is out of bounds")
            digest.update(struct.pack("<iiii", *values, section))
        triangles += len(indices)
        components.append(component)
    need(triangles == expected_triangles, "Complete actual source-model triangle count differs")
    return digest.hexdigest(), components


def mesh_package_snapshot(components, owner, save=False):
    content = Path(unreal.Paths.project_content_dir()).resolve()
    owned_directory = content / owner.removeprefix("/Game/")
    records, seen = [], set()
    for component in components:
        mesh = component.static_mesh
        path = owned_asset(mesh, owner)
        need(path not in seen, "One original owned mesh package per source node required")
        seen.add(path)
        package = path.split(".", 1)[0]
        need(package.startswith(owner + "/") and not any(part in ("", ".", "..") for part in package[6:].split("/")),
             "Owned mesh package path required")
        if save:
            need(unreal.EditorAssetLibrary.save_asset(path, only_if_is_dirty=False) is True, "Original owned mesh package save failed")
        base = content / package.removeprefix("/Game/")
        need(base.with_suffix(".uasset").is_file(), "Saved original native mesh package missing")
        suffixes = (".uasset", ".uexp", ".ubulk", ".uptnl", ".m.ubulk")
        need(all(candidate.name in {base.name + suffix for suffix in suffixes}
                 for candidate in base.parent.glob(base.name + ".*")), "Unknown native mesh package sidecar")
        for suffix in suffixes:
            artifact = Path(str(base) + suffix)
            if not artifact.exists():
                continue
            need(artifact.is_file() and not artifact.is_symlink()
                 and artifact.resolve().is_relative_to(owned_directory.resolve()), "Mesh package aliases or foreign paths unsupported")
            records.append({"mesh": path, "relativePath": artifact.relative_to(content).as_posix(),
                            "size": artifact.stat().st_size, "sha256": sha_file(artifact)})
    need(records, "Complete original mesh package inventory required")
    return sorted(records, key=lambda row: row["relativePath"])


def import_bundle(manifest_path):
    manifest_path = Path(manifest_path)
    need(manifest_path.is_absolute() and manifest_path.is_file() and not manifest_path.is_symlink(), "Absolute original manifest file required")
    manifest_path = manifest_path.resolve()
    folder, manifest_bytes = manifest_path.parent, manifest_path.read_bytes()
    manifest = strict_json(manifest_bytes)
    need(type(manifest.get("version")) is int and manifest["version"] == 1 and manifest.get("profileId") == PROFILE
         and manifest.get("materialIdentityPolicy") == IDENTITY_POLICY, "Supported explicit bounded manifest required")
    need(manifest.get("options") == {"layout": "objects", "transformMode": "preserve", "animation": "static", "skin": False, "objectAnimation": False},
         "Static preserve-transform original profile required")
    source, glb = read_member(folder, manifest["glb"], "geometry.glb")
    master, original_master = read_member(folder, manifest["sourceMaster"], "${o.masterFile}")
    rgba_path, rgba = read_member(folder, manifest["image"], "atlas.rgba")
    master_project = strict_json(original_master)
    need(manifest["sourceMaster"].get("role") == "original-full-source-project", "Complete captured original project and workspace required")
    validate_master(master_project, manifest)
    image = manifest["image"]
    need(image.get("origin") == "top-left" and type(image.get("width")) is int and type(image.get("height")) is int
         and image["width"] > 0 and image["height"] > 0 and len(rgba) == image["width"] * image["height"] * 4
         and all(rgba[index] == 255 for index in range(3, len(rgba), 4)), "Full opaque original top-left RGBA8 required")
    helper = Path(__file__).resolve()
    need(helper == folder / "Editor" / "${n.name}PrecisionImporter.py" and not helper.is_symlink()
         and sha_file(helper) == manifest.get("importerSha256"), "Exact exported app-owned helper required")
    g, binary = decode_glb(glb)
    inventory = source_inventory(g, manifest, binary, rgba)
    atlas_identity = atlas_payload(manifest, master_project, sha(glb))
${o.checkMasterAtlas}    need(re.fullmatch(r"[0-9a-f]{64}", manifest.get("sourceSnapshotSha256", ""))
         and isinstance(strict_json(manifest["sourceSnapshotOptionsJSON"]), dict), "Captured source snapshot provenance required")
    need(not unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages()
         and not unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages(), "Save current unsaved Editor work before changing levels")
    owner = "/Game/${n.name}Precision_" + uuid.uuid4().hex
    need(not unreal.EditorAssetLibrary.does_directory_exist(owner), "Existing output is never replaced")
    report_directory = Path(unreal.Paths.project_saved_dir()).resolve() / ("${n.name}Precision_" + uuid.uuid4().hex)
    need(not report_directory.exists(), "Existing diagnostic output is never replaced")
    report_directory.mkdir()
    report = {"version": 1, "processId": os.getpid(), "engineVersion": unreal.SystemLibrary.get_engine_version(),
              "status": "failed", "assetRoot": owner, "mapAssetPath": owner + "/Scene", "reportDirectory": str(report_directory),
              "sourceManifestSha256": sha(manifest_bytes), "sourceGlbSha256": sha(glb), "sourceMasterSha256": sha(original_master),
              "originalRgbaSha256": sha(rgba), "importerSha256": sha_file(helper),
              "originalNativeNamesPreserved": False, "renderCornerCorrespondenceQualified": False,
              "completeSourceModelCornersQualified": False,
              "masterToEvaluatedGlbReconstructionQualifiedByHelper": False,
              "rhiPixelsQualified": False, "activeShaderQualified": False, "freshProcessQualified": False,
              "scope": "Adapter storage only: source UID/labels/metadata, bulk native positions/indices/sections/local state, byte-identical saved original mesh packages and texture source-art/configuration. Complete split normal/UV/RGBA corner conservation, render buffers/RHI/shaders, fresh-process persistence and million-triangle performance require independent actual native gates. No averaged/arbitrary overlay values are used."}
    try:
        level = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
        need(level.new_level(report["mapAssetPath"], False) is True, "New uniquely owned map creation failed")
        need(not unreal.get_editor_subsystem(unreal.EditorActorSubsystem).get_all_level_actors(), "Owned blank map must be empty")
        destination = owner + "/Imported"
        import_original(source, destination, report)
        mapped, wrapper, container = inspect_actor_uids(g, inventory, source, destination)
        before, components = native_storage_fingerprint(mapped, g, owner, inventory["triangles"])
        mesh_packages_before = mesh_package_snapshot(components, owner, save=True)
        bound = {}
        for component in components:
            for slot in range(component.get_num_materials()):
                material = component.get_material(slot)
                need(material is not None and material_source_index(material, source, destination, container) == 0,
                     "Actual bound source-material bijection required before adaptation")
                bound[material.get_path_name()] = material
        need(len(bound) == 1, "Exactly one actual source-UID-verified native material required")
        for original in bound.values():
            set_identity(original, identity_payload("material", manifest["materials"][0], sha(glb)), owner)
        report["originalMaterialBinding"] = {"nativePath": next(iter(bound)), "glbMaterialIndex": 0,
                                             "nativeName": next(iter(bound.values())).get_name(), "directAuthoredNamePreserved": False}
        report["labels"] = apply_labels(mapped, inventory, sha(glb), owner)
        for index, actor in mapped.items():
            for component in actor.get_components_by_class(unreal.StaticMeshComponent):
                payload = identity_payload("object", inventory["byIndex"][index], sha(glb))
                set_identity(component, payload, owner)
        assets = [unreal.load_asset(path) for path in unreal.EditorAssetLibrary.list_assets(destination, recursive=True, include_folder=False)]
        textures = [asset for asset in assets if isinstance(asset, unreal.Texture2D)]
        need(len(textures) == 1, "Exactly one newly imported original atlas required")
        texture = textures[0]
        owned_asset(texture, owner)
        expected_pixels = (image["width"], image["height"], rgba)
        source_texture_pixels(texture, report_directory, "before-source-art.png", expected_pixels)
        configure_texture(texture, owner)
        set_identity(texture, atlas_identity, owner)
        material = create_unlit(texture, owner, manifest["materials"][0], sha(glb))
        for component in components:
            for slot in range(component.get_num_materials()):
                component.set_material(slot, material)
                need(component.get_material(slot) == material, "Actual owned native material slot binding failed")
        after, _ = native_storage_fingerprint(mapped, g, owner, inventory["triangles"])
        need(before == after, "Actual native bulk positions/topology/sections/local state changed during adaptation")
        report.update({"nativeStorageBeforeSha256": before, "nativeStorageAfterSha256": after,
                       "meshPackagesBefore": mesh_packages_before,
                       "triangles": inventory["triangles"], "objects": len(mapped), "nativeActorCount": len(mapped) + 1,
                       "nativeMaterial": material.get_path_name(), "nativeTexture": texture.get_path_name(),
                       "atlasParameter": ATLAS_PARAMETER, "atlasMetadataJSON": atlas_identity,
                       "materialMetadataJSON": identity_payload("material", manifest["materials"][0], sha(glb))})
        check_texture_policy(texture, owner)
        need(unreal.EditorAssetLibrary.get_metadata_tag(texture, METADATA_KEY) == atlas_identity, "Original atlas metadata differs")
        inspect_unlit(material, texture, owner, manifest["materials"][0], sha(glb))
        source_texture_pixels(texture, report_directory, "after-source-art.png", expected_pixels)
        need(unreal.EditorAssetLibrary.save_directory(owner, only_if_is_dirty=True, recursive=True) is True
             and level.save_current_level() is True, "Owned native map/assets failed to save")
        report["meshPackagesAfter"] = mesh_package_snapshot(components, owner)
        need(report["meshPackagesAfter"] == mesh_packages_before, "Original native mesh package bytes changed during adaptation/save")
        # Same-process reopen is genuine but explicitly not fresh-process proof.
        need(level.new_level(owner + "/ReopenBoundary", False) is True
             and level.load_level(report["mapAssetPath"]) is True, "Saved owned map reopen failed")
        reopened, _wrapper, _container = inspect_actor_uids(g, inventory, source, destination)
        reopened_hash, reopened_components = native_storage_fingerprint(reopened, g, owner, inventory["triangles"])
        need(reopened_hash == before, "Actual native bulk positions/topology/sections/local state differs after Save/reopen")
        report["meshPackagesReopened"] = mesh_package_snapshot(reopened_components, owner)
        need(report["meshPackagesReopened"] == mesh_packages_before, "Original saved native mesh package bytes changed after reopen")
        texture, material = unreal.load_asset(report["nativeTexture"]), unreal.load_asset(report["nativeMaterial"])
        check_texture_policy(texture, owner)
        need(unreal.EditorAssetLibrary.get_metadata_tag(texture, METADATA_KEY) == atlas_identity, "Saved original atlas metadata differs")
        inspect_unlit(material, texture, owner, manifest["materials"][0], sha(glb))
        for index, actor in reopened.items():
            row = inventory["byIndex"][index]
            need(actor.get_actor_label() == row["name"] and unreal.EditorAssetLibrary.get_metadata_tag(actor, METADATA_KEY) == identity_payload("object", row, sha(glb)),
                 "Exact authored display label or metadata differs after Save/reopen")
        for component in reopened_components:
            need(all(component.get_material(slot) == material for slot in range(component.get_num_materials())),
                 "Saved actual native material binding differs")
            owner_actor = component.get_owner()
            matching = [index for index, actor in reopened.items() if actor == owner_actor]
            need(len(matching) == 1, "Saved component must bind one source-mapped actual native actor")
            payload = identity_payload("object", inventory["byIndex"][matching[0]], sha(glb))
            need(unreal.EditorAssetLibrary.get_metadata_tag(component, METADATA_KEY) == payload,
                 "Saved component/actual immutable mesh source identity metadata differs")
        source_texture_pixels(texture, report_directory, "reopened-source-art.png", expected_pixels)
        report["nativeStorageReopenedSha256"] = reopened_hash
        report["status"] = "native-adapter-storage-passed-render-gates-open"
    except Exception as error:
        report["exceptionType"] = type(error).__name__
        report["exception"] = str(error)
        raise
    finally:
        try:
            unchanged = (sha_file(manifest_path) == report["sourceManifestSha256"] and sha_file(source) == report["sourceGlbSha256"]
                         and sha_file(master) == report["sourceMasterSha256"] and sha_file(rgba_path) == report["originalRgbaSha256"]
                         and sha_file(helper) == report["importerSha256"])
        except OSError:
            unchanged = False
        report["originalInputsUnchanged"] = unchanged
        if not unchanged:
            report["status"] = "failed"
        with (report_directory / "import-report.json").open("x", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=True, allow_nan=False, indent=2)
        need(unchanged, "Original bundle input bytes changed")
    unreal.log("${n.upper}_UNREAL_PRECISION_STORAGE_PASS_RENDER_GATES_OPEN")
    return report
`;
}
