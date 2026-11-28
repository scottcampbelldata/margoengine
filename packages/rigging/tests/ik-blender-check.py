# The outside referee for ik-blender-check.mjs: Blender builds each limb as two bones, finds which turn of the lower
# bone is anatomical flexion from the anatomy alone (a forearm folds forward, a shin folds back), limits its own IK
# solver to that side, and solves the same targets. Run by ik-blender-check.mjs:
#   blender -b --python ik-blender-check.py -- in.json out.json
import bpy, json, math, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:]
with open(argv[0]) as f:
    data = json.load(f)

# The engine's body: x to its left, y up, z forward. Blender: z up.
def to_b(p):
    return Vector((p[0], -p[2], p[1]))

def from_b(v):
    return [v.x, v.z, -v.y]

out = {'blender': bpy.app.version_string, 'limbs': []}
for limb in data['limbs']:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    arm = bpy.data.armatures.new('rig')
    obj = bpy.data.objects.new('rig', arm)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    root, mid, end = (to_b(limb[k]) for k in ('root', 'mid', 'end'))
    left = to_b([1, 0, 0])
    upper = arm.edit_bones.new('upper')
    upper.head, upper.tail = root, mid
    lower = arm.edit_bones.new('lower')
    lower.head, lower.tail = mid, end
    lower.parent = upper
    lower.use_connect = True
    for bone in (upper, lower):
        along = (bone.tail - bone.head).normalized()
        # Z across the bone and the body's left-right line, so the bone's X is that line: the hinge's axis.
        bone.align_roll(left.cross(along))
    bpy.ops.object.mode_set(mode='POSE')
    pose = obj.pose.bones['lower']
    pose.rotation_mode = 'XYZ'
    # Which turn about X is flexion: turn 0.3 rad and see where the end goes.
    forward = to_b([0, 0, 1])
    probe = math.radians(limb['probe'])
    pose.rotation_euler = (probe, 0, 0)
    bpy.context.view_layer.update()
    moved = (pose.tail - end).dot(forward)
    wanted = 1 if limb['kind'] == 'arm' else -1
    sign = 1 if moved * wanted > 0 else -1
    pose.rotation_euler = (sign * probe, 0, 0)
    bpy.context.view_layer.update()
    flexed = from_b(pose.tail)
    pose.rotation_euler = (0, 0, 0)
    pose.lock_ik_y = True
    pose.lock_ik_z = True
    pose.use_ik_limit_x = True
    stop = math.radians(limb['maxFlexion'])
    pose.ik_min_x, pose.ik_max_x = (0, stop) if sign > 0 else (-stop, 0)
    target = bpy.data.objects.new('target', None)
    bpy.context.scene.collection.objects.link(target)
    ik = pose.constraints.new('IK')
    ik.target = target
    ik.chain_count = 2
    ik.iterations = 500
    solved = []
    for point in limb['targets']:
        target.location = to_b(point)
        bpy.context.view_layer.update()
        graph = bpy.context.evaluated_depsgraph_get()
        posed = obj.evaluated_get(graph).pose.bones
        u, l = posed['upper'], posed['lower']
        du = (u.tail - u.head).normalized()
        dl = (l.tail - l.head).normalized()
        # The lower bone's turn about its own X against the upper bone: signed flexion as Blender's solver left it.
        local = (u.matrix.to_3x3().inverted() @ l.matrix.to_3x3()).to_euler('XYZ')
        solved.append({
            'flexion': math.degrees(du.angle(dl)),
            'turn': math.degrees(local.x) * sign,
            'mid': from_b(l.head),
            'end': from_b(l.tail),
            'miss': (l.tail - to_b(point)).length,
        })
    out['limbs'].append({'name': limb['name'], 'sign': sign, 'flexed': flexed, 'solved': solved})

with open(argv[1], 'w') as f:
    json.dump(out, f)
