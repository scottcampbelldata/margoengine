"""Run only in a separate factory-startup/background Blender process (npm run modern:test:blender). Regressions for
the add-on audit of 2026-11-15 (KB-P15a to KB-P15c), checked against Blender itself:

- KB-P15a: Blender shades and renders with the UV map marked active for rendering (MeshUVLoopLayer.active_render), not
  the one active for display and editing (UVLoopLayers.active). TEXCOORD_0, its tangents and the baked images must use
  the render map, so a mesh whose two flags differ exports the texture placement Blender renders.
- KB-P15b: a spot light with Spot Blend 0 (a hard edge, allowed by Blender) must still give a valid glTF cone,
  0 <= inner < outer (KHR_lights_punctual), or @margoengine/blender/components refuses the file.
- KB-P15c: a light with Custom Distance on and a distance of 0 has no glTF range (range must be above 0); the export
  fails by the light's name instead of writing a file the loader refuses."""
from pathlib import Path
import importlib.util
import json
import math
import struct
import sys
import tempfile
import zlib

import bpy
import numpy as np

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import export_scene

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve() if "--" in sys.argv else Path(tempfile.mkdtemp())
output.mkdir(parents=True, exist_ok=True)


def sections(path):
    data = Path(path).read_bytes()
    count = struct.unpack_from("<I", data, 12)[0]
    table = [struct.unpack_from("<4I", data, 64 + 16 * i) for i in range(count)]
    payload = [data[offset:offset + length] for _, offset, length, _ in table]
    return json.loads(payload[0]), payload


def png_rgba(data):
    """RGBA rows of a PNG the add-on wrote (8-bit RGBA, filter 0 on every row)."""
    width, height = struct.unpack_from(">II", data, 16)
    at, idat = 8, b""
    while at < len(data):
        length = struct.unpack_from(">I", data, at)[0]
        if data[at + 4:at + 8] == b"IDAT":
            idat += data[at + 8:at + 8 + length]
        at += 12 + length
    raw = zlib.decompress(idat)
    rows = [raw[y * (width * 4 + 1) + 1:(y + 1) * (width * 4 + 1)] for y in range(height)]
    return np.frombuffer(b"".join(rows), np.uint8).reshape(height, width, 4)


def fresh():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    return bpy.context.scene


def two_uv_plane():
    """A plane whose render UV map ("Left") covers the left half of the texture and whose active map ("Right") the right."""
    bpy.ops.mesh.primitive_plane_add(size=2)
    obj = bpy.context.active_object
    mesh = obj.data
    left = mesh.uv_layers[0]
    left.name = "Left"
    right = mesh.uv_layers.new(name="Right")
    for loop in mesh.loops:
        u, v = left.data[loop.index].uv
        left.data[loop.index].uv = (u * 0.5, v)
        right.data[loop.index].uv = (0.5 + u * 0.5, v)
    mesh.uv_layers.active_index = 1
    left.active_render, right.active_render = True, False
    assert mesh.uv_layers.active.name == "Right" and left.active_render and not right.active_render
    return obj


def material(obj, build):
    mat = bpy.data.materials.new(obj.name)
    if bpy.app.version < (5, 0, 0):
        mat.use_nodes = True
    shader = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    build(mat.node_tree, shader)
    obj.data.materials.append(mat)


def texcoords(manifest, payload):
    primitive = manifest["meshes"][0]["primitives"][0]
    vertices = np.frombuffer(payload[primitive["vertices"]], "<f4").reshape(-1, 20)
    return vertices[:, 12:14], vertices[:, 14:16]


# KB-P15a, direct material: the image texture Blender renders is placed by the render map.
fresh()
obj = two_uv_plane()
image = bpy.data.images.new("Halves", 2, 1, alpha=True)
image.pixels = [1, 0, 0, 1, 0, 1, 0, 1]


def textured(tree, shader):
    node = tree.nodes.new("ShaderNodeTexImage")
    node.image = image
    tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])


material(obj, textured)
path = output / "uv-direct.margo"
export_scene(bpy.context, str(path), bake_size=0, lights_cameras=False)
manifest, payload = sections(path)
uv0, uv1 = texcoords(manifest, payload)
assert uv0[:, 0].max() <= 0.5 + 1e-6, f"TEXCOORD_0 is not the render UV map (Left): u up to {uv0[:, 0].max()}"
assert uv1[:, 0].min() >= 0.5 - 1e-6, f"TEXCOORD_1 is not the other UV map (Right): u from {uv1[:, 0].min()}"

# KB-P15a, baked material: the bake lays its image out on the render map, the one TEXCOORD_0 carries.
fresh()
obj = two_uv_plane()


def constant_graph(tree, shader):
    rgb = tree.nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = (1, 0, 0, 1)
    tree.links.new(rgb.outputs[0], shader.inputs["Base Color"])


material(obj, constant_graph)
path = output / "uv-baked.margo"
export_scene(bpy.context, str(path), bake_size=32, lights_cameras=False)
manifest, payload = sections(path)
base = manifest["materials"][0]["pbrMetallicRoughness"]["baseColorTexture"]["index"]
rgba = png_rgba(payload[manifest["images"][manifest["textures"][base]["source"]]["section"]])
uv0, _ = texcoords(manifest, payload)
assert uv0[:, 0].max() <= 0.5 + 1e-6, "baked TEXCOORD_0 is not the render UV map"
# Columns 0 to 15 are the faces' texels on the render map; the far right (beyond the 4-texel margin) is never covered.
assert rgba[:, 2, 0].min() > 200, f"the bake left the render map's texels empty: red {rgba[:, 2, 0].tolist()}"
assert rgba[:, 30, 0].max() < 50, f"the bake covered the active (display) map instead: red {rgba[:, 30, 0].tolist()}"


# KB-P15b and KB-P15c: lights.
def lights_scene(**spot):
    scene = fresh()
    bpy.ops.mesh.primitive_plane_add(size=2)
    data = bpy.data.lights.new("Spot", "SPOT")
    for key, value in spot.items():
        setattr(data, key, value)
    scene.collection.objects.link(bpy.data.objects.new("Spot", data))
    return data


lights_scene(spot_size=math.radians(60), spot_blend=0.0)
path = output / "spot-hard.margo"
export_scene(bpy.context, str(path), bake_size=0)
manifest, _ = sections(path)
tags = next(n for n in manifest["nodes"] if n["name"] == "Spot")["extras"]["margo"]["properties"]
outer, inner = tags["margo:outer_cone"], tags["margo:inner_cone"]
assert abs(outer - math.radians(30)) < 1e-6, outer
assert 0 <= inner < outer, f"Spot Blend 0 gave inner {inner} and outer {outer}; KHR_lights_punctual needs inner < outer"
assert inner >= 0.999 * outer - 1e-12, f"a hard spot edge should stay hard: inner {inner} of outer {outer}"

lights_scene(spot_size=math.radians(60), spot_blend=0.5)
export_scene(bpy.context, str(path), bake_size=0)
manifest, _ = sections(path)
tags = next(n for n in manifest["nodes"] if n["name"] == "Spot")["extras"]["margo"]["properties"]
assert abs(tags["margo:inner_cone"] - math.radians(15)) < 1e-6, "Spot Blend above 0.001 keeps its mapping"

lights_scene(use_custom_distance=True, cutoff_distance=0.0)
try:
    export_scene(bpy.context, str(output / "range-zero.margo"), bake_size=0)
except ValueError as error:
    assert "Spot" in str(error) and "Custom Distance" in str(error), str(error)
else:
    raise AssertionError("a Custom Distance of 0 exported a light with range 0, which KHR_lights_punctual does not allow")
print("blender_uv_lights: ok")
