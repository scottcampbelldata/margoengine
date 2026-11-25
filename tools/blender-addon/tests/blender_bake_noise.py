"""CC0 Margo-authored bake_noise export (KB5339e): materials a Noise Texture feeds are baked by Cycles, and every texel of
the exported PNGs equals an independent Cycles emission bake of the same socket. Other materials stay live."""
from pathlib import Path
import importlib.util
import json
import struct
import sys
import zlib
import bpy
import numpy as np

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import export_scene

SIZE = 32
output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def plane(name, x):
    bpy.ops.mesh.primitive_plane_add(size=2, location=(x, 0, 0))
    obj = bpy.context.object
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    obj.data.materials.append(material)
    tree = material.node_tree
    return obj, material, tree, tree.nodes.get("Principled BSDF")


# A coloured 3D noise on Base Color and, through a node group, a 4D noise on Roughness.
noisy, material, tree, bsdf = plane("Noisy", 0)
colour = tree.nodes.new("ShaderNodeTexNoise")
colour.inputs["Scale"].default_value = 7.3
colour.inputs["Detail"].default_value = 3.0
colour.inputs["Distortion"].default_value = 0.4
tree.links.new(colour.outputs["Color"], bsdf.inputs["Base Color"])
group = bpy.data.node_groups.new("Grain", "ShaderNodeTree")
group.interface.new_socket("Value", in_out="OUTPUT", socket_type="NodeSocketFloat")
grain = group.nodes.new("ShaderNodeTexNoise")
grain.noise_dimensions = "4D"
grain.inputs["W"].default_value = 0.13
grain.inputs["Scale"].default_value = 4.1
coordinates = group.nodes.new("ShaderNodeTexCoord")
group.links.new(coordinates.outputs["Generated"], grain.inputs["Vector"])
group.links.new(grain.outputs[0], group.nodes.new("NodeGroupOutput").inputs["Value"])
instance = tree.nodes.new("ShaderNodeGroup")
instance.node_tree = group
tree.links.new(instance.outputs["Value"], bsdf.inputs["Roughness"])
# A live material beside it, with a Noise node that reaches nothing.
still, live, live_tree, live_bsdf = plane("Live", 3)
value = live_tree.nodes.new("ShaderNodeValue")
value.outputs[0].default_value = 0.4
live_tree.links.new(value.outputs[0], live_bsdf.inputs["Roughness"])
live_tree.nodes.new("ShaderNodeTexNoise")


def pngs(path):
    """The RGBA8 PNG images of a .margo file, in file order, and its bytes (the writer leaves PNG rows unfiltered)."""
    blob = path.read_bytes()
    found, at = [], blob.find(b"\x89PNG")
    while at >= 0:
        cursor, data, size = at + 8, b"", None
        while True:
            length, kind = struct.unpack_from(">I4s", blob, cursor)
            body = blob[cursor + 8:cursor + 8 + length]
            if kind == b"IHDR":
                size = struct.unpack(">II", body[:8])
            data += body if kind == b"IDAT" else b""
            cursor += 12 + length
            if kind == b"IEND":
                break
        raw = np.frombuffer(zlib.decompress(data), np.uint8).reshape(size[1], size[0] * 4 + 1)
        assert not raw[:, 0].any()
        found.append(raw[:, 1:].reshape(size[1], size[0], 4))
        at = blob.find(b"\x89PNG", cursor)
    return found, blob


state = (len(bpy.data.images), len(tree.nodes), scene.render.engine)
target = output / "bake-noise.margo"
export_scene(bpy.context, target, bake_size=SIZE, lights_cameras=False, live_nodes=True, bake_noise=True)
assert state == (len(bpy.data.images), len(tree.nodes), scene.render.engine), "the export must restore the scene"
images, blob = pngs(target)
assert len(images) == 2, f"base colour and metallic-roughness, not {len(images)} images"
assert blob.count(b'"margo:nodes"') == 1, "the material without noise on its surface stays live"

# The oracle: Cycles' own emission bake of each noise socket, set up here from scratch with the exporter's settings.
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 4
emission = tree.nodes.new("ShaderNodeEmission")
emission.inputs["Strength"].default_value = 1
output_node = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.is_active_output)
bake_target = tree.nodes.new("ShaderNodeTexImage")
for other in bpy.context.view_layer.objects:
    other.select_set(other == noisy)
bpy.context.view_layer.objects.active = noisy


def oracle(source):
    image = bpy.data.images.new("Oracle", SIZE, SIZE, alpha=True, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    bake_target.image = image
    tree.links.new(source, emission.inputs["Color"])
    tree.links.new(emission.outputs[0], output_node.inputs["Surface"])
    tree.nodes.active = bake_target
    bpy.ops.object.bake(type="EMIT")
    pixels = np.empty(SIZE * SIZE * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return np.clip(pixels.reshape(SIZE, SIZE, 4)[::-1], 0, 1)


linear = oracle(colour.outputs["Color"])[..., :3]
srgb = np.where(linear <= 0.0031308, linear * 12.92, 1.055 * np.power(linear, 1 / 2.4) - 0.055)
expected_colour = np.round(srgb * 255).astype(np.uint8)
expected_rough = np.round(oracle(instance.outputs["Value"])[..., 0] * 255).astype(np.uint8)
assert len(np.unique(expected_colour)) > 20 and len(np.unique(expected_rough)) > 20, "the noise must vary"
base, rough = images
different = int((base[..., :3] != expected_colour).sum()), int((rough[..., 1] != expected_rough).sum())
assert different == (0, 0), f"texels differ from the Cycles bake: {different}"

# Without bake_noise the same Noise stays live (live nodes take no node groups, so only the direct link remains).
tree.links.new(bsdf.outputs[0], output_node.inputs["Surface"])
tree.nodes.remove(emission)
tree.nodes.remove(bake_target)
tree.links.new(colour.outputs["Fac"], bsdf.inputs["Roughness"])
plain = output / "live-noise.margo"
export_scene(bpy.context, plain, lights_cameras=False, live_nodes=True)
images, blob = pngs(plain)
assert not images and blob.count(b'"margo:nodes"') == 2, "live_nodes alone keeps Noise live"
tree.links.new(instance.outputs["Value"], bsdf.inputs["Roughness"])


def refused(fragment, **options):
    try:
        export_scene(bpy.context, output / "refused.margo", lights_cameras=False, live_nodes=True, bake_noise=True, **options)
    except ValueError as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError(f"the export must refuse: {fragment}")


refused("set bake_size", bake_size=0)
# Animation inside the group would be frozen by a one-frame bake.
for frame, w in ((1, 0.1), (3, 0.9)):
    grain.inputs["W"].default_value = w
    grain.inputs["W"].keyframe_insert("default_value", frame=frame)
refused("Material 'Noisy'", bake_size=SIZE)
refused("its node tree is animated", bake_size=SIZE)
(output / "bake-noise.json").write_text(json.dumps({"size": SIZE, "different": different}), encoding="utf-8")
print("MARGO_BAKE_NOISE_OK")
