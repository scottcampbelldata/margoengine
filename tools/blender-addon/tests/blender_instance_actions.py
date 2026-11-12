"""CC0 Margo-authored scene for KB5247a: a collection instance under an animated instancer and an animated pivot.

The instance must follow both in the exported object actions. Evaluated Blender worlds of the instance (from the
dependency graph's object instances) and of its instancer are the oracle, never exporter maths.
"""
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
scene.render.fps = 24

# The source collection is excluded from the view layer, so only its instance is exported.
source = bpy.data.collections.new("Source")
scene.collection.children.link(source)
bpy.ops.mesh.primitive_cube_add()
box = bpy.context.object
box.name = "Box"
for collection in list(box.users_collection):
    collection.objects.unlink(box)
source.objects.link(box)
box.location = (0.5, 0, 0)
source.instance_offset = (0.25, 0, 0)
bpy.context.view_layer.layer_collection.children["Source"].exclude = True

pivot = bpy.data.objects.new("Pivot", None)
scene.collection.objects.link(pivot)
pivot.location = (1, 2, 0)
instancer = bpy.data.objects.new("Instancer", None)
instancer.instance_type = "COLLECTION"
instancer.instance_collection = source
instancer.parent = pivot
scene.collection.objects.link(instancer)
for obj, path, first, last in (
    (pivot, "rotation_euler", (0, 0, 0), (0, 0, 1.2)),
    (instancer, "location", (2, 0, 0), (2, 3, 1)),
):
    setattr(obj, path, first)
    obj.keyframe_insert(path, frame=1)
    setattr(obj, path, last)
    obj.keyframe_insert(path, frame=9)
    obj.animation_data.action.name = obj.name + "Action"
    for layer in obj.animation_data.action.layers:
        for strip in layer.strips:
            for bag in strip.channelbags:
                for curve in bag.fcurves:
                    for key in curve.keyframe_points:
                        key.interpolation = "LINEAR"
scene.frame_set(4)
saved = [(obj, obj.animation_data.action, obj.animation_data.action_slot) for obj in (pivot, instancer)]
export_scene(bpy.context, output / "instances.margo", object_animation=True, lights_cameras=False)

from mathutils import Matrix
basis = Matrix.Rotation(-1.5707963267948966, 4, "X")
defaults = {obj.name: (obj.location.copy(), obj.rotation_euler.copy()) for obj in (pivot, instancer)}
truth = {"clips": {}}


def flat(matrix):
    converted = basis @ matrix @ basis.inverted()
    return [converted[r][c] for c in range(4) for r in range(4)]


for owner, action, slot in saved:
    for obj, _, _ in saved:
        obj.animation_data.action = None
        obj.animation_data.use_nla = False
        obj.location, obj.rotation_euler = defaults[obj.name]
    owner.animation_data.action = action
    owner.animation_data.action_slot = slot
    samples = []
    for frame in range(1, 10):
        scene.frame_set(frame)
        depsgraph = bpy.context.evaluated_depsgraph_get()
        worlds = {"Instancer": flat(instancer.evaluated_get(depsgraph).matrix_world)}
        found = [i.matrix_world.copy() for i in depsgraph.object_instances if i.is_instance and i.object.original == box]
        assert len(found) == 1, f"expected one instance of Box, found {len(found)}"
        worlds["Box"] = flat(found[0])
        samples.append(worlds)
    truth["clips"][action.name] = samples
(output / "instances-truth.json").write_text(json.dumps(truth), encoding="utf-8")
print("MARGO_INSTANCES_OK")
