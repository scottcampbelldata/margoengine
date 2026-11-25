"""KB5339f: muted nodes and links export as Blender evaluates them. Each case wires muted constructs into the Emission
Colour and Roughness of a Principled BSDF whose own socket values differ, then a Cycles bake of the untouched material
(emission and roughness passes) is the truth for all three exporter paths: the bake, the live node graph and the direct
export. Run with:
blender --background --factory-startup --python tools/blender-addon/tests/blender_mute.py -- <folder>"""
from pathlib import Path
import importlib.util
import json
import struct
import sys
import bpy
import numpy as np

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.bake import bake_material, principled
from margo_export.exporter import export_scene
from margo_export.nodes import graph, noise_trees

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.device, scene.cycles.samples = "CPU", 1
bpy.ops.mesh.primitive_plane_add(size=2)
plane = bpy.context.object

OWN = ((0.11, 0.12, 0.13, 1), 0.31)  # the Principled sockets' own emission colour and roughness


def rgb(tree, color=(0.9, 0.2, 0.1)):
    node = tree.nodes.new("ShaderNodeRGB")
    node.outputs[0].default_value = (*color, 1)
    return node.outputs[0]


def value(tree, v):
    node = tree.nodes.new("ShaderNodeValue")
    node.outputs[0].default_value = v
    return node.outputs[0]


def math(tree, a=0.7, b=0.6):
    node = tree.nodes.new("ShaderNodeMath")
    node.inputs[0].default_value, node.inputs[1].default_value = a, b
    return node


def muted_pass(tree, emission, rough):
    """A muted node passes the linked input: the first Math input, the Mix node's linked B."""
    m = math(tree)
    tree.links.new(value(tree, 0.8), m.inputs[0])
    tree.links.new(m.outputs[0], rough)
    mix = tree.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    tree.links.new(rgb(tree), mix.inputs[7])
    tree.links.new(mix.outputs[2], emission)
    m.mute = mix.mute = True


def muted_drop(tree, emission, rough):
    """A muted node with nothing linked leaves the socket its own value; so does a node with no internal link."""
    m = math(tree)
    tree.links.new(m.outputs[0], rough)
    m.mute = True
    source = value(tree, 0.8)
    source.node.mute = True
    tree.links.new(source, emission)


def muted_links(tree, emission, rough):
    """A muted link feeds nothing, into a Principled socket or into a node on the way."""
    tree.links.new(rgb(tree), emission).is_muted = True
    m = math(tree, 0.25, 0.05)
    tree.links.new(value(tree, 0.8), m.inputs[0]).is_muted = True
    tree.links.new(m.outputs[0], rough)


def muted_chain(tree, emission, rough):
    """Muted nodes and reroutes in a row: the source comes through all of them, past a muted reroute."""
    a, b = math(tree), math(tree)
    first, second = tree.nodes.new("NodeReroute"), tree.nodes.new("NodeReroute")
    tree.links.new(value(tree, 0.8), first.inputs[0])
    tree.links.new(first.outputs[0], a.inputs[0])
    tree.links.new(a.outputs[0], b.inputs[0])
    tree.links.new(b.outputs[0], second.inputs[0])
    tree.links.new(second.outputs[0], rough)
    a.mute = b.mute = second.mute = True
    empty = tree.nodes.new("NodeReroute")
    tree.links.new(empty.outputs[0], emission)


def muted_surface(tree, emission, rough):
    """A muted Mix Shader passes its linked shader on; muted links to Volume and Displacement feed nothing."""
    shader = rough.node
    out = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
    mix = tree.nodes.new("ShaderNodeMixShader")
    tree.links.new(shader.outputs[0], mix.inputs[1])
    tree.links.new(mix.outputs[0], out.inputs["Surface"])
    mix.mute = True
    tree.links.new(tree.nodes.new("ShaderNodeVolumeAbsorption").outputs[0], out.inputs["Volume"]).is_muted = True
    tree.links.new(rgb(tree), out.inputs["Displacement"]).is_muted = True
    tree.links.new(value(tree, 0.6), rough)


CASES = (muted_pass, muted_drop, muted_links, muted_chain, muted_surface)


def make(case):
    material = bpy.data.materials.new(case.__name__)
    if bpy.app.version < (5, 0, 0):
        material.use_nodes = True
    tree = material.node_tree
    shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
    shader.inputs["Emission Color"].default_value = OWN[0]
    shader.inputs["Emission Strength"].default_value = 1
    shader.inputs["Roughness"].default_value = OWN[1]
    case(tree, shader.inputs["Emission Color"], shader.inputs["Roughness"])
    plane.data.materials.clear()
    plane.data.materials.append(material)
    return material


def cycles(material, kind):
    """The mean texel of one Cycles bake pass of the material as it is wired."""
    tree = material.node_tree
    target = tree.nodes.new("ShaderNodeTexImage")
    image = bpy.data.images.new(f"truth-{kind}", 4, 4, float_buffer=True)
    image.colorspace_settings.name = "Non-Color"
    target.image = image
    tree.nodes.active = target
    plane.select_set(True)
    bpy.context.view_layer.objects.active = plane
    bpy.ops.object.bake(type=kind, margin=0)
    pixels = np.empty(64, np.float32)
    image.pixels.foreach_get(pixels)
    material.node_tree.nodes.remove(target)
    bpy.data.images.remove(image)
    return pixels.reshape(16, 4).mean(axis=0)


def close(got, want, what):
    assert np.allclose(got, want, atol=2e-3), f"{what}: exported {np.round(got, 5).tolist()}, Cycles {np.round(want, 5).tolist()}"


def live_value(data, entry):
    """The value a live-graph input holds, for graphs of constants and Math Add (the only nodes these cases keep)."""
    if "parameter" in entry:
        return data["parameters"][entry["parameter"]]["value"]
    node = data["nodes"][entry["link"]]
    if node["op"] == "math":
        assert node["operation"] == "ADD", node
        return [live_value(data, node["inputs"][0])[0] + live_value(data, node["inputs"][1])[0]]
    assert node["op"] == "value", f"a node Blender skips stayed in the live graph: {node}"
    return live_value(data, node["inputs"][0])


report = {}
for case in CASES:
    name = case.__name__
    material = make(case)
    truth = (cycles(material, "EMIT")[:3], cycles(material, "ROUGHNESS")[0])
    report[name] = {"emission": truth[0].tolist(), "roughness": float(truth[1])}

    data = graph(bpy.context, material, plane)
    emission = live_value(data, data["surface"]["emission"])
    close(emission[:3] if len(emission) > 2 else emission * 3, truth[0], f"{name} live emission")
    close(live_value(data, data["surface"]["roughness"])[:1], [truth[1]], f"{name} live roughness")

    links = sorted((l.from_node.name, l.to_node.name, l.is_muted) for l in material.node_tree.links)
    baked = bake_material(bpy.context, plane, material, 4)
    assert sorted((l.from_node.name, l.to_node.name, l.is_muted) for l in material.node_tree.links) == links, f"{name}: the bake rewired the material"
    for channel, want in (("emission", truth[0]),):
        got = baked[channel][..., :3].reshape(-1, 3).mean(axis=0) if baked[channel] is not None else np.array(baked["factors"]["emissive"])
        close(got, want, f"{name} baked {channel}")
    got = baked["metal_rough"][..., 1].mean() if baked["metal_rough"] is not None else baked["factors"]["roughness"]
    close([got], [truth[1]], f"{name} baked roughness")

# The direct export (no bake): a texture comes through a muted node and a reroute, muted links and a muted Normal Map
# leave the sockets their own values, and a muted Mix Shader passes the Principled shader.
material = bpy.data.materials.new("direct")
if bpy.app.version < (5, 0, 0):
    material.use_nodes = True
tree = material.node_tree
shader = next(n for n in tree.nodes if n.type == "BSDF_PRINCIPLED")
out = next(n for n in tree.nodes if n.type == "OUTPUT_MATERIAL")
shader.inputs["Roughness"].default_value = OWN[1]
texture = tree.nodes.new("ShaderNodeTexImage")
texture.image = bpy.data.images.new("checker", 2, 2)
tree.links.new(rgb(tree), texture.inputs["Vector"]).is_muted = True
through, bend = math(tree), tree.nodes.new("NodeReroute")
tree.links.new(texture.outputs["Color"], through.inputs[0])
tree.links.new(through.outputs[0], bend.inputs[0])
tree.links.new(bend.outputs[0], shader.inputs["Base Color"])
through.mute = True
bump = tree.nodes.new("ShaderNodeNormalMap")
tree.links.new(texture.outputs["Color"], bump.inputs["Color"])
tree.links.new(bump.outputs[0], shader.inputs["Normal"])
bump.mute = True
for name in ("Metallic", "Roughness", "Alpha", "Emission Strength", "Coat Normal", "Transmission Weight"):
    tree.links.new(value(tree, 0.9), shader.inputs[name]).is_muted = True
mix = tree.nodes.new("ShaderNodeMixShader")
tree.links.new(shader.outputs[0], mix.inputs[1])
tree.links.new(mix.outputs[0], out.inputs["Surface"])
mix.mute = True
plane.data.materials.clear()
plane.data.materials.append(material)
export_scene(bpy.context, output / "direct.margo", bake_size=0)
raw = (output / "direct.margo").read_bytes()
offset, length = struct.unpack_from("<II", raw, 68)
exported = json.loads(raw[offset:offset + length])["materials"][0]
pbr = exported["pbrMetallicRoughness"]
assert "baseColorTexture" in pbr and "normalTexture" not in exported and "extensions" not in exported, exported
close([pbr["roughnessFactor"], pbr["metallicFactor"], pbr["baseColorFactor"][3]], [OWN[1], 0, 1], "direct factors")
assert exported.get("alphaMode", "OPAQUE") == "OPAQUE", exported

# A muted surface shader drops out as an unlinked surface does.
material = make(muted_drop)
principled(material)[1].mute = True
for read in (lambda: principled(material), lambda: graph(bpy.context, material, plane)):
    try:
        read()
    except ValueError as error:
        assert "surface output" in str(error), error
    else:
        raise AssertionError("A muted surface shader still exported")

# A Noise Texture behind a muted link or node does not feed the material.
material = make(muted_drop)
tree = material.node_tree
noise = tree.nodes.new("ShaderNodeTexNoise")
link = tree.links.new(noise.outputs[0], principled(material)[1].inputs["Roughness"])
assert noise_trees(material)
link.is_muted = True
assert noise_trees(material) is None
link.is_muted = False
noise.mute = True
assert noise_trees(material) is None

(output / "mute-truth.json").write_text(json.dumps(report), encoding="utf-8")
print("Margo mute export:", len(CASES), "cases;", bpy.app.version_string)
