"""Pins the documented lightmap limit for collection instances (docs/limits.md, packages/blender/README.md; KB5247c).

Cycles bakes the original mesh objects of the view layer. A collection instance is an empty that instances a
collection, so it gets no lightmap of its own: every instance shares its source object's bake. If the add-on ever
bakes instances on their own, this check fails and the limit text must change with it.
"""
from pathlib import Path
import importlib.util
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export.lightmaps import lightmaps

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.cycles.samples = 1
scene.cycles.use_denoising = False
material = bpy.data.materials.new("Diffuse")
material.use_nodes = True

source_collection = bpy.data.collections.new("Source")
scene.collection.children.link(source_collection)
bpy.ops.mesh.primitive_plane_add(size=2)
source = bpy.context.object
source.name = "SourcePlane"
source.data.materials.append(material)
for collection in list(source.users_collection):
    collection.objects.unlink(source)
source_collection.objects.link(source)

instances = []
for index in range(2):
    empty = bpy.data.objects.new(f"Instance{index}", None)
    empty.instance_type = "COLLECTION"
    empty.instance_collection = source_collection
    empty.location = (4 * (index + 1), 0, 0)
    scene.collection.objects.link(empty)
    instances.append(empty)

sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
scene.collection.objects.link(sun)
bpy.context.view_layer.update()

with lightmaps(bpy.context, 16) as records:
    baked = set(records)
    assert baked == {source.as_pointer()}, f"expected one bake (the source mesh), got {len(baked)}"
    for empty in instances:
        assert empty.as_pointer() not in baked, f"{empty.name} was baked on its own"
print("lightmap instances: the source mesh is baked once; 2 collection instances share it")
