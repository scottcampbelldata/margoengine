# Opens a file in real Blender through its own importers and prints what a user would get. Argument: JSON list of files.
import bpy, sys, json, os, mathutils
args = sys.argv[sys.argv.index('--') + 1:]
out_path, files = args[0], args[1:]
res = {}
def clear():
    bpy.ops.wm.read_factory_settings(use_empty=True)
def load(f):
    e = os.path.splitext(f)[1].lower()
    if e in ('.glb', '.gltf'): bpy.ops.import_scene.gltf(filepath=f, guess_original_bind_pose=False)
    elif e == '.stl': bpy.ops.wm.stl_import(filepath=f)
    elif e == '.obj': bpy.ops.wm.obj_import(filepath=f)
    elif e == '.ply': bpy.ops.wm.ply_import(filepath=f)
    elif e in ('.usdz', '.usd', '.usda', '.usdc'): bpy.ops.wm.usd_import(filepath=f)
    else: raise Exception('no importer for ' + e)
def helper(o):
    return any(c.name.startswith('glTF_not_exported') for c in o.users_collection)
def stats():
    # Rest pose on both sides: a source with clips imports posed at the first frame of one of them.
    helpers = [o.name for o in bpy.context.scene.objects if helper(o)]
    for o in bpy.context.scene.objects:
        if o.type == 'ARMATURE': o.data.pose_position = 'REST'
    for m in bpy.data.meshes:
        if m.shape_keys:
            if m.shape_keys.animation_data: m.shape_keys.animation_data.action = None
            for k in m.shape_keys.key_blocks[1:]: k.value = 0
    for o in bpy.context.scene.objects:
        if o.animation_data: o.animation_data.action = None
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    tris = verts = 0; lo = [1e30]*3; hi = [-1e30]*3; meshes = 0; flipped = 0; area_out = 0.0
    for o in bpy.context.scene.objects:
        if o.type != 'MESH' or helper(o): continue
        meshes += 1
        ev = o.evaluated_get(dg); me = ev.to_mesh(); me.calc_loop_triangles()
        tris += len(me.loop_triangles); verts += len(me.vertices)
        M = ev.matrix_world
        for v in me.vertices:
            w = M @ v.co
            for i in range(3):
                lo[i] = min(lo[i], w[i]); hi[i] = max(hi[i], w[i])
        ev.to_mesh_clear()
    mats = sorted(m.name for m in bpy.data.materials if m.users)
    imgs = sorted((i.size[0], i.size[1]) for i in bpy.data.images if i.size[0])
    acts = sorted((a.name, round(a.frame_range[1] - a.frame_range[0], 2)) for a in bpy.data.actions)
    arm = sum(1 for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    bones = sum(len(o.data.bones) for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    sk = sum(len(m.shape_keys.key_blocks) - 1 for m in bpy.data.meshes if m.shape_keys)
    return dict(meshes=meshes, tris=tris, verts=verts, min=lo, max=hi, materials=len(mats), images=imgs, actions=len(acts), actionLen=[a[1] for a in acts], armatures=arm, bones=bones, shapeKeys=sk, helpers=helpers)
for f in files:
    clear()
    try:
        load(f); res[f] = stats()
    except Exception as e:
        res[f] = dict(error=str(e)[:400])
json.dump(res, open(out_path, 'w'), indent=0)
