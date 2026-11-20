"""CC0 Margo-authored socket F-curves carrying Noise modifiers (KB5339d), with Blender's own value as the black-box truth.
The exporter samples each such curve with fcurve.evaluate and writes LINEAR keys; this script re-measures the export in
Blender and fails unless the keys, played as the reader plays them, give back Blender's value in single precision at every
sampled subframe (the sample or a float32 neighbour of it). The old export (frame samples interpolated linearly) misses it between frames."""
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
from margo_export.nodes import graph, noise_step, within_rounding
from bpy_extras import anim_utils

output = Path(sys.argv[sys.argv.index("--") + 1]).resolve()
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.frame_start, scene.frame_end = 1, 25
scene.render.fps = 24
bpy.ops.mesh.primitive_plane_add(size=2)
plane = bpy.context.object
material = bpy.data.materials.new("Noise")
material.use_nodes = True
plane.data.materials.append(material)
tree = material.node_tree
bsdf = tree.nodes.get("Principled BSDF")


def keyed(node_type, name, keys, socket_input, index=None):
    node = tree.nodes.new(node_type)
    node.name = name
    for frame, value in keys:
        if index is None:
            node.outputs[0].default_value = value
            node.outputs[0].keyframe_insert("default_value", frame=frame)
        else:
            node.outputs[0].default_value[index] = value
            node.outputs[0].keyframe_insert("default_value", index=index, frame=frame)
    tree.links.new(node.outputs[0], socket_input)
    return node


def curve_of(node, index=0):
    path = node.outputs[0].path_from_id("default_value")
    bag = anim_utils.action_get_channelbag_for_slot(tree.animation_data.action, tree.animation_data.action_slot)
    return next(f for f in bag.fcurves if f.data_path == path and f.array_index == index)


def noise(fcurve, **settings):
    m = fcurve.modifiers.new("NOISE")
    for key, value in settings.items():
        setattr(m, key, value)
    return m


# A Bezier ramp with three octaves of replacing noise.
amount = keyed("ShaderNodeValue", "Amount", [(1, 0.2), (12, 0.8), (25, 0.4)], bsdf.inputs["Roughness"])
noise(curve_of(amount), scale=3.0, strength=0.5, phase=1.3, depth=2)
# Finer noise (scale 0.8) added over a restricted range with blend in and out at half influence, on a linear ramp: outside
# the range the ramp alone remains and its samples reduce to few keys.
grain = keyed("ShaderNodeValue", "Grain", [(1, 0.3), (25, 0.6)], bsdf.inputs["Metallic"])
for k in curve_of(grain).keyframe_points:
    k.interpolation = "LINEAR"
m = noise(curve_of(grain), scale=0.8, strength=0.2, offset=2.5, blend_type="ADD", use_restricted_range=True,
          frame_start=6.5, frame_end=19.25, blend_in=3.0, blend_out=2.0, use_influence=True, influence=0.5)
# A colour: red carries multiplying noise after a Cycles modifier, green is a plain Bezier curve, blue stays still.
tint = tree.nodes.new("ShaderNodeRGB")
tint.name = "Tint"
tint.outputs[0].default_value = (0.2, 0.3, 0.4, 1)
for frame, r, g in ((3, 0.2, 0.9), (12, 0.8, 0.1), (20, 0.4, 0.5)):
    tint.outputs[0].default_value[0] = r
    tint.outputs[0].default_value[1] = g
    tint.outputs[0].keyframe_insert("default_value", index=0, frame=frame)
    tint.outputs[0].keyframe_insert("default_value", index=1, frame=frame)
tree.links.new(tint.outputs[0], bsdf.inputs["Base Color"])
red = curve_of(tint, 0)
red.modifiers.new("CYCLES")
noise(red, scale=5.0, strength=0.8, blend_type="MULTIPLY", depth=1, lacunarity=3.0, roughness=0.7)
# A still value under noise: one key, the noise alone moves it.
glow = keyed("ShaderNodeValue", "Glow", [(1, 2.0)], bsdf.inputs["Emission Strength"])
noise(curve_of(glow), scale=8.0, strength=4.0, phase=-0.6)

scene.frame_set(1)
data = graph(bpy.context, material, plane)
keys = {"Amount/outputs/0": [curve_of(amount)], "Grain/outputs/0": [curve_of(grain)], "Glow/outputs/0": [curve_of(glow)],
        "Tint/outputs/0": [red, curve_of(tint, 1), None, None]}


def play(curve, s):
    """The reader's evaluation of LINEAR keys (packages/blender/src/nodes.ts evaluateCurve)."""
    k = curve["keys"]
    if s <= k[0]["t"] or len(k) == 1:
        return k[0]["v"]
    if s >= k[-1]["t"]:
        return k[-1]["v"]
    lo, hi = 0, len(k) - 1
    while hi - lo > 1:
        mid = (lo + hi) >> 1
        if k[mid]["t"] <= s:
            lo = mid
        else:
            hi = mid
    a, b = k[lo], k[hi]
    return a["v"] + (b["v"] - a["v"]) * ((s - a["t"]) / (b["t"] - a["t"]))


checked = 0
for key, fcurves in keys.items():
    curves = data["parameters"][key].get("curves")
    assert curves, f"{key}: a Noise-modified F-curve must be exported as keys, not frame samples alone"
    for index, fcurve in enumerate(fcurves):
        if fcurve is None or not any(m.type == "NOISE" for m in fcurve.modifiers):
            continue
        step = noise_step(fcurve)
        assert all(k["i"] == "LINEAR" for k in curves[index]["keys"])
        for i in range(round(24 / step) + 1):
            frame = 1 + i * step
            got = play(curves[index], (frame - 1) / 24)
            assert within_rounding(got, fcurve.evaluate(frame)), f"{key}[{index}] at frame {frame}: {got} against {fcurve.evaluate(frame)}"
            checked += 1
assert [noise_step(c) for c in (curve_of(amount), curve_of(grain), red, curve_of(glow))] == [1 / 16, 1 / 16, 1 / 8, 1 / 8]
truth, between = [], []
for step in range(0, 24 * 8 + 1):
    frame = 1 + step / 8
    scene.frame_set(int(frame), subframe=frame - int(frame))
    truth.append({"seconds": (frame - 1) / 24, "values": {key: list(tree.nodes[key.split("/")[0]].outputs[0].default_value)
                  if key == "Tint/outputs/0" else [tree.nodes[key.split("/")[0]].outputs[0].default_value] for key in keys}})
# Off the sampled steps (frame + k/3 + 1/7), where the reader interpolates between samples.
for step in range(0, 24 * 3):
    frame = 1 + step / 3 + 1 / 7
    scene.frame_set(int(frame), subframe=frame - int(frame))
    between.append({"seconds": (frame - 1) / 24, "values": {key: list(tree.nodes[key.split("/")[0]].outputs[0].default_value)
                    if key == "Tint/outputs/0" else [tree.nodes[key.split("/")[0]].outputs[0].default_value] for key in keys}})
(output / "node-noise.json").write_text(json.dumps({"graph": data, "truth": truth, "between": between}), encoding="utf-8")
print("node noise samples checked", checked)
