# Base colour as a person sees it, through real Blender: each file imported by Blender's own importer, every material's
# base colour sent straight to an emission surface, drawn by Cycles on the CPU from one fixed camera, same frame for both.
import bpy, sys, json, math
from mathutils import Vector
a = sys.argv[sys.argv.index('--') + 1:]
kind, path, out_png = a[0], a[1], a[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
if kind == 'glb':
    bpy.ops.import_scene.gltf(filepath=path, guess_original_bind_pose=False)
elif kind == 'stl':
    bpy.ops.wm.stl_import(filepath=path)
elif kind == 'ply':
    bpy.ops.wm.ply_import(filepath=path)
else:
    bpy.ops.wm.obj_import(filepath=path, forward_axis='NEGATIVE_Z', up_axis='Y')
def helper(o):
    return any(c.name.startswith('glTF_not_exported') for c in o.users_collection)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
kd_of = {}
if kind == 'obj':
    name = None
    for line in open(path[:-3] + 'mtl'):
        p = line.split()
        if p[:1] == ['newmtl']: name = p[1]
        if p[:1] == ['Kd']: kd_of[name] = tuple(float(v) for v in p[1:4])
for o in meshes:
    if helper(o):
        o.hide_render = True
for m in bpy.data.materials:
    if not m.use_nodes:
        continue
    t = m.node_tree
    bsdf = next((n for n in t.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    out = next((n for n in t.nodes if n.type == 'OUTPUT_MATERIAL'), None)
    if not bsdf or not out:
        continue
    em = t.nodes.new('ShaderNodeEmission')
    base = bsdf.inputs['Base Color']
    if base.is_linked and kind == 'obj':
        # Blender's OBJ importer drops Kd once a map_Kd is linked; MTL says the two multiply, so do what MTL says.
        kd = kd_of.get(m.name.split('.')[0], (1, 1, 1))
        mul = t.nodes.new('ShaderNodeVectorMath'); mul.operation = 'MULTIPLY'
        t.links.new(base.links[0].from_socket, mul.inputs[0])
        mul.inputs[1].default_value = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in kd]
        t.links.new(mul.outputs[0], em.inputs['Color'])
    elif base.is_linked:
        t.links.new(base.links[0].from_socket, em.inputs['Color'])
    elif kind == 'obj':
        # Kd is written sRGB; Blender reads it as linear. Decode, to compare UVs and not that.
        em.inputs['Color'].default_value = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in base.default_value[:3]] + [1]
    else:
        em.inputs['Color'].default_value = base.default_value
    t.links.new(em.outputs[0], out.inputs['Surface'])
    m.blend_method = 'OPAQUE' if hasattr(m, 'blend_method') else None
bpy.context.view_layer.update()
dg = bpy.context.evaluated_depsgraph_get()
lo = Vector((1e30,) * 3); hi = Vector((-1e30,) * 3)
for o in meshes:
    if helper(o):
        continue
    ev = o.evaluated_get(dg); me = ev.to_mesh()
    for v in me.vertices:
        w = ev.matrix_world @ v.co
        for i in range(3):
            lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
    ev.to_mesh_clear()
c = (lo + hi) / 2
size = max(hi - lo)
if kind in ('stl', 'ply'):
    print('BOUNDS', [round(v, 5) for v in list(lo) + list(hi)])
    sys.exit(0)
cam = bpy.data.cameras.new('c'); cam.type = 'ORTHO'; cam.ortho_scale = size * 1.2
co = bpy.data.objects.new('c', cam); bpy.context.scene.collection.objects.link(co)
d = Vector((0.6, -1.0, 0.45)).normalized()
co.location = c + d * size * 3
co.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()
s = bpy.context.scene
s.camera = co
s.render.engine = 'CYCLES'
s.cycles.device = 'CPU'
s.cycles.samples = 16
s.cycles.use_denoising = False
s.render.resolution_x = s.render.resolution_y = 384
s.render.film_transparent = True
s.view_settings.view_transform = 'Standard'
s.render.filepath = out_png
s.render.image_settings.file_format = 'PNG'
s.render.image_settings.color_mode = 'RGBA'
w = bpy.data.worlds.new('w'); s.world = w
bpy.ops.render.render(write_still=True)
print('BOUNDS', [round(v, 5) for v in list(lo) + list(hi)])
