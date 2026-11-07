"""Run only in a separate factory-startup/background Blender process, started by scripts/modern-blender-tests.js: the
add-on's live link serves a red plane, waits until the page has it, turns the plane blue as an artist would, waits
until the page has that too, then stops. Background Blender runs no timers, so the script calls the link's tick
itself; the depsgraph handler is Blender's own. Prints `MARGO_LIVE <url>` once the server listens."""
from pathlib import Path
import importlib.util
import sys
import bpy

addon = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("margo_export", addon / "__init__.py", submodule_search_locations=[str(addon)])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
from margo_export import live_export
from margo_export.live import LiveLink

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_plane_add(size=2)
plane = bpy.context.active_object
plane.name = plane.data.name = "Live"
plane.data.uv_layers.remove(plane.data.uv_layers[0])
material = bpy.data.materials.new("Paint")
plane.data.materials.append(material)
shader = next(n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
shader.inputs["Base Color"].default_value = (0.8, 0.05, 0.05, 1)
bpy.context.view_layer.update()

link = LiveLink(live_export(bake_size=0))
print("MARGO_LIVE", link.start(), flush=True)
link.tick()
assert link.server.version == 1 and link.error is None, link.error
assert link.server.wait_served(1, 60), "the page never fetched the first version"
# The edit: Blender's depsgraph handler marks the link dirty, and the next tick publishes version 2.
shader.inputs["Base Color"].default_value = (0.05, 0.05, 0.8, 1)
bpy.context.view_layer.update()
assert link.dirty, "a material edit did not reach the live link's depsgraph handler"
link.tick()
assert link.server.version == 2, link.server.version
assert link.server.wait_served(2, 60), "the page never fetched the edited version"
link.stop()
print("Margo live link: 2 versions served;", bpy.app.version_string, flush=True)
