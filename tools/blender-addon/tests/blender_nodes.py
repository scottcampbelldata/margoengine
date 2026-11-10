"""CC0 Margo-authored live graph, sampled Blender socket and Cycles emission oracle."""
from pathlib import Path
import importlib.util
import json
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.exporter import export_scene

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 3
scene.render.fps = 2
bpy.ops.mesh.primitive_plane_add(size=4)
plane = bpy.context.object
material = bpy.data.materials.new("Live")
material.use_nodes = True
plane.data.materials.append(material)
tree = material.node_tree
bsdf = tree.nodes.get("Principled BSDF")
value = tree.nodes.new("ShaderNodeValue")
value.name = "Amount"
for f, v in ((1, 0.25), (2, 0.5), (3, 0.75)):
    value.outputs[0].default_value = v
    value.outputs[0].keyframe_insert("default_value", frame=f)
math = tree.nodes.new("ShaderNodeMath")
math.operation = "MULTIPLY_ADD"
math.inputs[1].default_value = 0.5
math.inputs[2].default_value = 0.125
tree.links.new(value.outputs[0], math.inputs[0])
ramp = tree.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.1, 0.2, 0.3, 1)
ramp.color_ramp.elements[1].color = (0.7, 0.6, 0.5, 1)
tree.links.new(math.outputs[0], ramp.inputs[0])
mix = tree.nodes.new("ShaderNodeMix")
mix.data_type = "RGBA"
mix.inputs[0].default_value = 0.25
mix.inputs[7].default_value = (0.2, 0.4, 0.6, 1)
tree.links.new(ramp.outputs[0], mix.inputs[6])
tree.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
tree.links.new(mix.outputs[2], bsdf.inputs["Emission Color"])
bsdf.inputs["Emission Strength"].default_value = 1
noise = tree.nodes.new("ShaderNodeTexNoise")
noise.name = "Live Noise"
noise.noise_dimensions = "4D"
noise.inputs["W"].default_value = 0.13
tree.links.new(noise.outputs["Fac"], bsdf.inputs["Roughness"])
scene.frame_set(2)
state = (scene.frame_current, scene.frame_subframe, len(bpy.data.images), len(bpy.data.meshes))
export_scene(bpy.context, output / "nodes.margo", live_nodes=True, lights_cameras=False)
assert state == (scene.frame_current, scene.frame_subframe, len(bpy.data.images), len(bpy.data.meshes))
# Black-box Cycles emission bake validates math, ramp and Mix together, independently of the runtime compiler.
scene.render.engine = "CYCLES"
scene.cycles.device = "CPU"
scene.cycles.samples = 1
image = bpy.data.images.new("Oracle", width=4, height=4, float_buffer=True)
target = tree.nodes.new("ShaderNodeTexImage")
target.image = image
tree.nodes.active = target
bpy.context.view_layer.objects.active = plane
truth = []
for frame in (1, 2, 3):
    scene.frame_set(frame)
    bpy.ops.object.bake(type="EMIT")
    pixels = list(image.pixels)
    truth.append({"seconds": (frame-1)/2, "color": pixels[:3]})
(output / "nodes-truth.json").write_text(json.dumps(truth), encoding="utf-8")
# Unsupported reachable nodes fail by name, never silently bake under live_nodes.
bad = tree.nodes.new("ShaderNodeTexVoronoi")
tree.links.new(bad.outputs[0], bsdf.inputs["Metallic"])
try:
    export_scene(bpy.context, output / "bad.margo", live_nodes=True)
except ValueError as e:
    assert bad.name in str(e) and "disable live_nodes" in str(e)
else:
    raise AssertionError("unsupported graph must reject")
print("MARGO_NODES_OK")
