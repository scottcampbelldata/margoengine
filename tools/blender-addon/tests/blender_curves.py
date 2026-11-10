"""Run only in a separate factory-startup/background Blender process: a floor, Bezier, poly and NURBS curve objects, a
hair curves object with Catmull-Rom curves, a point cloud and a volume made from a cube, exported to curves.margo with
curves=True. Blender's own numbers go to curves-truth.json beside it: each curve object's evaluated polyline (what
Blender's Convert to Mesh gives), each point cloud's positions and each volume's grids, voxel count and some voxel
values, in Margo's Y-up metres. The files are packages/blender/tests/fixtures/curves.margo and curves-truth.json
(Blender 5.2.3 LTS); tests/curves.test.js compares them."""
from pathlib import Path
import importlib.util
import json
import math
import os
import sys
import tempfile
import bpy
from mathutils import Vector

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
link = scene.collection.objects.link

bpy.ops.mesh.primitive_plane_add(size=4)
bpy.context.active_object.name = "Floor"


def curve_object(name, location, rotation=(0, 0, 0)):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    obj = bpy.data.objects.new(name, data)
    obj.location, obj.rotation_euler = location, rotation
    link(obj)
    return data


# Bezier: an open spline with free, aligned and vector handles (the vector segment stays straight), and a cyclic one.
path = curve_object("Path", (0, 0, 1), (0, 0, math.radians(30)))
spline = path.splines.new("BEZIER")
spline.bezier_points.add(3)
spline.resolution_u = 6
for point, (co, left, right, kind) in zip(spline.bezier_points, (
        ((0, 0, 0), (-0.5, -0.3, 0), (0.5, 0.3, 0.2), "FREE"),
        ((1, 1, 0.5), (0.6, 1, 0.3), (1.4, 1, 0.7), "ALIGNED"),
        ((2, 0, 0), (2, 0, 0), (2, 0, 0), "VECTOR"),
        ((3, 0.5, 0), (3, 0.5, 0), (3, 0.5, 0), "VECTOR"))):
    point.co, point.handle_left_type, point.handle_right_type = co, kind, kind
    if kind != "VECTOR":
        point.handle_left, point.handle_right = left, right
    point.radius, point.tilt = 1 + co[0] * 0.25, co[0] * 0.1
ring = path.splines.new("BEZIER")
ring.bezier_points.add(3)
ring.use_cyclic_u, ring.resolution_u = True, 4
for point, co in zip(ring.bezier_points, ((0, -2, 0), (1, -3, 0), (0, -4, 0), (-1, -3, 0))):
    point.co, point.handle_left_type, point.handle_right_type = co, "AUTO", "AUTO"
# Poly and NURBS: an open poly line, an endpoint NURBS of order 4 with a heavy weight, a uniform cyclic one of order 3
# and a cyclic one of order 4 with endpoint set (Blender ignores endpoint on a cyclic spline).
lines = curve_object("Lines", (-2, 1, 0.5))
poly = lines.splines.new("POLY")
poly.points.add(2)
for point, co in zip(poly.points, ((0, 0, 0, 1), (0, 1, 0.5, 1), (0.5, 2, 0, 1))):
    point.co = co
for name, cyclic, endpoint, order, resolution in (("Endpoint", False, True, 4, 5), ("Uniform", True, False, 3, 4), ("Closed", True, True, 4, 3)):
    nurbs = lines.splines.new("NURBS")
    nurbs.points.add(4)
    for i, point in enumerate(nurbs.points):
        point.co = (1 + i * 0.5, math.sin(i) + (3 if cyclic else 0), 0.3 * (i % 2), 1)
        point.weight = 3.0 if i == 2 else 1.0
    nurbs.use_cyclic_u, nurbs.use_endpoint_u, nurbs.order_u, nurbs.resolution_u = cyclic, endpoint, order, resolution
# Hair curves: Catmull-Rom, an open curve and a cyclic one.
hair = bpy.data.hair_curves.new("Hair")
hair.add_curves([4, 5])
for i, point in enumerate(hair.points):
    point.position = (math.cos(i) * 0.4, math.sin(i) * 0.4, i * 0.2)
hair.set_types(type="CATMULL_ROM")
cyclic = hair.attributes.new("cyclic", "BOOLEAN", "CURVE")
cyclic.data[1].value = True
resolution = hair.attributes.new("resolution", "INT", "CURVE")
for i, value in enumerate((5, 3)):
    resolution.data[i].value = value
hair_object = bpy.data.objects.new("Hair", hair)
hair_object.location = (1.5, 1.5, 0)
link(hair_object)
# A point cloud with radii and a colour.
cloud = bpy.data.pointclouds.new("Cloud")
cloud.resize(64)
colour = cloud.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
for i, point in enumerate(cloud.points):
    point.co = (math.cos(i * 0.7) * (0.2 + i * 0.01), math.sin(i * 0.7) * (0.2 + i * 0.01), i * 0.02)
    point.radius = 0.01 + i * 0.0005
    colour.data[i].color = (i / 63, 0.5, 1 - i / 63, 1)
cloud_object = bpy.data.objects.new("Cloud", cloud)
cloud_object.location = (-1.5, -1.5, 0.2)
link(cloud_object)
# A volume: a cube's interior as a density grid, through the Mesh to Volume modifier. Its faces sit between voxel
# centres (0.65 m across, 0.1 m voxels): at 0.6 m the top face fell exactly on a row of centres, so whether that row
# counted was a floating-point tie, decided one way by Blender 5.2.3 on Windows and the other by 5.3 on the Mac.
bpy.ops.mesh.primitive_cube_add(size=0.65, location=(10, 10, 10))
source = bpy.context.active_object
source.name = "VolumeSource"
source.hide_set(True)
source.hide_render = True
volume = bpy.data.volumes.new("Smoke")
volume_object = bpy.data.objects.new("Smoke", volume)
volume_object.location = (1, -1, 1)
volume_object.rotation_euler = (0, 0, math.radians(45))
link(volume_object)
modifier = volume_object.modifiers.new("Fill", "MESH_TO_VOLUME")
modifier.object, modifier.resolution_mode, modifier.voxel_size, modifier.density = source, "VOXEL_SIZE", 0.1, 0.8

export_scene(bpy.context, str(output / "curves.margo"), bake_size=0, lights_cameras=False, curves=True)

# Blender's own numbers. Blender Z-up local coordinates to Y-up metres, as the exporter writes.
def yup(co):
    return [co[0], co[2], -co[1]]


depsgraph = bpy.context.evaluated_depsgraph_get()
truth = {"polylines": {}, "points": {}, "volumes": {}}
path_object = bpy.data.objects["Path"]
truth["worlds"] = {"Path": yup(path_object.matrix_world @ path_object.data.splines[0].bezier_points[0].co)}
for obj in (bpy.data.objects["Path"], bpy.data.objects["Lines"]):
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    truth["polylines"][obj.name] = [yup(v.co) for v in mesh.vertices]
    bpy.data.meshes.remove(mesh)
cloud_geometry = cloud_object.evaluated_get(depsgraph).evaluated_geometry()
evaluated = cloud_geometry.pointcloud
truth["points"]["Cloud"] = {"positions": [yup(p.co) for p in evaluated.points], "radius": [p.radius for p in evaluated.points]}
import openvdb
volume_geometry = volume_object.evaluated_get(depsgraph).evaluated_geometry()
grids = volume_geometry.volume.grids
grids.load()
handle, path = tempfile.mkstemp(suffix=".vdb")
os.close(handle)
grids.save(path)
for grid in openvdb.readAll(path)[0]:
    accessor = grid.getConstAccessor()
    lo, hi = grid.evalActiveVoxelBoundingBox()
    probes = [[lo[0], lo[1], lo[2]], [(lo[0] + hi[0]) // 2, (lo[1] + hi[1]) // 2, (lo[2] + hi[2]) // 2], [hi[0], hi[1], hi[2]]]
    truth["volumes"][grid.name] = {"activeVoxels": grid.activeVoxelCount(), "box": [list(lo), list(hi)],
                                   "probes": [[ijk, accessor.getValue(tuple(ijk))] for ijk in probes],
                                   "world": [list(grid.transform.indexToWorld(tuple(ijk))) for ijk in probes]}
    truth["volumes"][grid.name]["scene"] = [yup(volume_object.matrix_world @ Vector(w)) for w in truth["volumes"][grid.name]["world"]]
os.unlink(path)
# Hair curves have no mesh of their own: Blender's Convert to Mesh operator gives their evaluated polyline (last, as it
# replaces the object).
with bpy.context.temp_override(active_object=hair_object, selected_objects=[hair_object], selected_editable_objects=[hair_object]):
    bpy.ops.object.convert(target="MESH")
truth["polylines"]["Hair"] = [yup(v.co) for v in bpy.data.objects["Hair"].data.vertices]
(output / "curves-truth.json").write_text(json.dumps(truth, indent=1) + "\n", encoding="utf-8")
print("wrote", output)
