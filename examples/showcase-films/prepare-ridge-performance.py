"""Skin the Tripo ridge horse and bake the film's walk, trot and stops in Blender."""

import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector


FPS = 48
DURATION = 90
TRAIL_START = -42.0
SCALE = 2.67
CENTER = 0.066
RIG = "Ridge horse"
CLIP = "Ridge performance"
TAU = 2 * math.pi


def smooth(value, lo=0, hi=1):
    t = np.clip((value - lo) / (hi - lo), 0, 1)
    return t * t * (3 - 2 * t)


def grade(z):
    return .93 * np.sin(z / 26) + .48 * np.sin(z / 11) + .11 * np.sin(z / 3.2) + .029


def point(raw):
    x, y, z = raw
    return Vector((SCALE * z, SCALE * (x - CENTER), SCALE * (y - .002)))


def make_legs():
    legs = []
    for name, side, hind in [('LH', 1, True), ('LF', 1, False),
                             ('RH', -1, True), ('RF', -1, False)]:
        if hind:
            hock_x, ankle_x, sole_x = (.374, .356, .329) if side > 0 else (.335, .289, .262)
            rows = [(0.283, .557, .072), (.223, .385, .086),
                    (hock_x, .216, .082), (ankle_x, .071, .092),
                    (sole_x, .002, .096)]
            labels = ['Thigh', 'Gaskin', 'Hind cannon', 'Hind hoof']
        else:
            rows = [(-.103, .584, .073), (-.187, .478, .069), (-.105, .343, .061),
                    (-.145, .211, .060), (-.144, .068, .064), (-.155, .029, .065),
                    (-.157, .002, .065)]
            labels = ['Scapula', 'Upper arm', 'Forearm', 'Fore cannon', 'Fore pastern', 'Fore hoof']
        positions = [point((forward, height, side * across)) for forward, height, across in rows]
        names = [f'{label}.{name}' for label in labels]
        legs.append((name, hind, positions, names))
    return legs


def build_rig(source):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    mesh, = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    original_world = mesh.matrix_world.copy()
    mesh.parent = None
    mesh.matrix_world.identity()
    raw = np.array([(p.x, p.z, -p.y) for p in (original_world @ v.co for v in mesh.data.vertices)])
    for vertex, coord in zip(mesh.data.vertices, raw):
        vertex.co = point(coord)
    mesh.data.update()
    mesh.name = 'Bay horse coat'
    bpy.context.view_layer.objects.active = mesh
    bpy.ops.object.select_all(action='DESELECT')
    mesh.select_set(True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.remove_doubles(threshold=0.00008)
    bpy.ops.object.mode_set(mode='OBJECT')
    raw = np.array([(v.co.y / SCALE + CENTER, v.co.z / SCALE + .002, v.co.x / SCALE)
                    for v in mesh.data.vertices])
    for p in mesh.data.polygons:
        p.use_smooth = True

    armature = bpy.data.armatures.new(RIG)
    rig = bpy.data.objects.new(RIG, armature)
    bpy.context.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    rig.show_in_front = True
    bpy.ops.object.mode_set(mode='EDIT')

    def add(name, start, end, parent=None):
        bone = armature.edit_bones.new(name)
        bone.head, bone.tail = start, end
        if parent:
            bone.parent = armature.edit_bones[parent]
            bone.use_connect = (bone.parent.tail - start).length < 1e-6

    add('Barrel', point((.105, .465, 0)), point((-.16, .5, 0)))
    add('Pelvis', point((.133, .545, 0)), point((.337, .528, 0)), 'Barrel')
    add('Neck', point((-.163, .493, 0)), point((-.344, .694, 0)), 'Barrel')
    add('Poll', point((-.344, .694, 0)), point((-.458, .562, 0)), 'Neck')
    add('Tail base', point((.358, .584, 0)), point((.424, .453, 0)), 'Pelvis')
    add('Tail tip', point((.424, .453, 0)), point((.435, .115, 0)), 'Tail base')
    legs = make_legs()
    for _, hind, positions, names in legs:
        parent = 'Pelvis' if hind else 'Barrel'
        for j, name in enumerate(names):
            add(name, positions[j], positions[j + 1], names[j - 1] if j else parent)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    for bone in rig.pose.bones:
        if bone.name == 'Pelvis' or bone.name.startswith(('Scapula.', 'Thigh.')):
            bone.lock_location = (True, True, True)

    x, y, z = raw.T
    weights = {'Barrel': np.ones(len(x))}
    # Keep the underside rigid across the middle of the rib cage. The elbows and
    # flanks share load only in the lateral transition around each limb root.
    for name, hind, _, names in legs:
        side = 1 if name.startswith('L') else -1
        lateral = smooth(side * z, .007, .023)
        lateral_root = smooth(side * z, .016, .091)
        if hind:
            root = smooth(y, .338, .438)
            leg = smooth(x, .086, .166)
            tail_edge = .395 + .034 * smooth(np.abs(z), .035, .076)
            leg *= 1 - smooth(x, tail_edge, tail_edge + .024)
            root_weight = lateral_root * smooth(x, .119, .239) * (1 - smooth(y, .42, .585))
            total = lateral * leg * (1 - root) + root_weight * root
            stops = [(.071, .019), (.216, .033), (.385, .07)]
        else:
            fore_aft = smooth(x, -.256, -.191) * (1 - smooth(x, -.108, -.047))
            root = smooth(y, .291, .394)
            leg = smooth(x, -.264, -.212) * (1 - smooth(x, -.091, -.063))
            root_weight = lateral_root * fore_aft * (1 - smooth(y, .35, .554))
            total = lateral * leg * (1 - root) + root_weight * root
            stops = [(.029, .008), (.068, .013), (.211, .028), (.343, .061), (.471, .048)]
        lower = np.ones(len(x))
        for bone, (pivot, width) in zip(reversed(names), stops):
            upper = smooth(y, pivot - width, pivot + width)
            weights[bone] = (lower - upper) * total
            lower = upper
        weights[names[0]] = lower * total
        weights['Barrel'] -= total

    neck = (1 - smooth(x, -.28, -.161)) * smooth(y, .445, .548)
    head = (1 - smooth(x, -.367, -.321)) * neck
    tail = smooth(x, .373, .421) * (1 - smooth(np.abs(z), .031, .072))
    tip = tail * (1 - smooth(y, .394, .488))
    for bone, amount in [('Neck', neck - head), ('Poll', head), ('Tail base', tail - tip), ('Tail tip', tip)]:
        weights[bone] = amount * np.maximum(0, weights['Barrel'])
        weights['Barrel'] -= weights[bone]
    pelvis = smooth(x, .075, .265) * smooth(y, .356, .487)
    weights['Pelvis'] = pelvis * np.maximum(0, weights['Barrel'])
    weights['Barrel'] -= weights['Pelvis']

    names = list(weights)
    matrix = np.maximum(0, np.stack(list(weights.values()), axis=1))
    joints = np.argsort(matrix, axis=1)[:, -4:]
    groups = [mesh.vertex_groups.new(name=name) for name in names]
    for vertex, selected in enumerate(joints):
        values = matrix[vertex, selected]
        for index, weight in zip(selected, values / values.sum()):
            if weight > .001:
                groups[int(index)].add([vertex], float(weight), 'REPLACE')
    mesh.parent = rig
    modifier = mesh.modifiers.new('Equine deformation', 'ARMATURE')
    modifier.object = rig
    modifier.use_deform_preserve_volume = True
    for material in mesh.data.materials:
        for node in material.node_tree.nodes:
            if node.type == 'BSDF_PRINCIPLED':
                node.inputs['Metallic'].default_value = 0
                node.inputs['Roughness'].default_value = .66
    return rig, legs


def curve_times():
    t = np.arange(-2 * FPS, (DURATION + 2) * FPS + 1) / FPS
    first = 1.50 * (1 - smooth(t, 20.9, 23.15))
    walk = 1.48 * smooth(t, 32, 33.44) * (1 - smooth(t, 78.45, 81.0))
    trot_blend = smooth(t, 40.05, 42.15) * (1 - smooth(t, 63.7, 66.2))
    speeds = first + walk + (3.22 - 1.48) * trot_blend
    distance = np.r_[0, np.cumsum((speeds[:-1] + speeds[1:]) / (2 * FPS))]
    distance -= distance[2 * FPS]
    cadence = (1.02 + .51 * trot_blend) * smooth(speeds, 0, .85)
    phase = np.r_[0, np.cumsum((cadence[:-1] + cadence[1:]) / (2 * FPS))]
    return t, speeds, distance, trot_blend, phase


def cycle_times(duration, gait_speed, is_trot):
    count = round(duration * FPS)
    frames = np.arange(-2 * count, 3 * count + 1)
    times = frames / FPS
    return (times, np.full(len(times), gait_speed), times * gait_speed,
            np.full(len(times), float(is_trot)), frames / count)


def foot_motion(index, rest, timeline, on_trail):
    t, speed, distance, trot, phase = timeline
    walk_offset = [0, .255, .50, .755][index]
    trot_offset = [0, .50, .50, 1.0][index]
    ordered = phase - (walk_offset + (trot_offset - walk_offset) * trot)
    steps = np.floor(ordered + 1e-8)
    crossings = np.flatnonzero(steps[1:] > steps[:-1]) + 1
    contacts = list(t[crossings])
    # Each stop finishes on a level landing with one limb settling at a time.
    stops = [23.15, 81.] if on_trail else []
    neutral = [stop - .14 - .16 * [1, 3, 0, 2][index] for stop in stops]
    contacts = [v for v in contacts if all(not (n - .40 < v < stop) for n, stop in zip(neutral, stops))]
    contacts = sorted([t[0], *contacts, *neutral])
    holds = np.array([x in neutral for x in contacts])
    contacts = np.array(contacts)
    mix = np.interp(contacts, t, trot)
    nominal_period = 1 / (1.02 + .51 * mix)
    duty = .61 - .19 * mix
    delta = np.r_[np.diff(contacts), 20]
    duration = np.minimum(delta, nominal_period * 1.12)
    release = contacts + duration * duty
    release[holds] = contacts[holds] + delta[holds] - np.minimum(.46, delta[holds] * .38)
    starts = np.interp(contacts, t, distance)
    ends = np.interp(release, t, distance)
    centers = rest + (starts + ends) / 2
    for i, hold in enumerate(holds):
        if hold:
            centers[i] = rest + np.interp(stops[neutral.index(contacts[i])], t, distance)
    k = np.clip(np.searchsorted(contacts, t, side='right') - 1, 0, len(contacts) - 1)
    k1 = np.minimum(k + 1, len(contacts) - 1)
    u = np.clip((t - release[k]) / np.maximum(.001, contacts[k1] - release[k]), 0, 1)
    plant = centers[k] + (centers[k1] - centers[k]) * smooth(u)
    clearance = (.145 + .095 * trot) * np.sin(np.pi * u) ** 1.28
    effort = smooth(np.maximum(speed, np.interp(contacts[k1], t, speed)), 0, 1.22)
    clearance *= effort
    stance_progress = np.clip((t - contacts[k]) / np.maximum(.001, release[k] - contacts[k]), 0, 1)
    load = np.sin(np.pi * stance_progress) ** 1.3 * smooth(speed, .05, 1.32)
    # Hoof rolls around its leading edge late in support, tucks in early
    # swing, and opens out as the toe reaches for the following contact.
    pitch = .36 * smooth(stance_progress, .73, 1) * (1 - smooth(u, 0, .22))
    pitch *= ~holds[k]
    pitch += np.interp(u, [0, .18, .36, .65, .84, 1], [0, .48, .63, .24, -.18, 0]) * effort
    pitch *= smooth(np.maximum(speed, np.interp(contacts[k1], t, speed)), 0, .56)
    fold = np.interp(u, [0, .12, .29, .45, .64, .84, 1], [0, .32, 1, .96, .52, .16, 0])
    beats = [[round(float(time), 4), index, float(np.interp(time, t, speed))]
             for time in contacts if 0 < time < DURATION and
             (np.interp(time, t, speed) > .14 or time in neutral)]
    heel_to_toe = .068
    up = clearance + heel_to_toe * np.abs(np.sin(pitch))
    if on_trail:
        up += grade(TRAIL_START + plant) - grade(TRAIL_START + distance)
    local = plant - distance + heel_to_toe * (1 - np.cos(pitch)) * np.sign(pitch)
    return local, up, pitch, fold, load, beats


def circle_joint(start, end, radius, reach, sign):
    axis = end - start
    distance = axis.length
    axis /= max(1e-7, distance)
    along = (radius * radius + distance * distance - reach * reach) / max(1e-7, 2 * distance)
    offset = math.sqrt(max(0, radius * radius - along * along))
    forward = Vector((0, axis.z, -axis.y)).normalized()
    return start + along * axis + sign * offset * forward


def aimed(rest, start, end):
    old_axis = rest.to_3x3().col[1]
    orient = old_axis.rotation_difference((end - start).normalized()) @ rest.to_quaternion()
    return Matrix.Translation(start) @ orient.to_matrix().to_4x4()


def qx(angle):
    return Quaternion((1, 0, 0), angle)


def at_pivot(rest, rotation, shift):
    p = rest.translation
    return Matrix.Translation(p + shift) @ rotation.to_matrix().to_4x4() @ (
        Matrix.Translation(-p) @ rest
    )


def fore_target(points, motion, index, body_delta, gait, reach):
    blade, socket, _, _, fetlock, coronet, sole = points
    forward, up, roll, fold, load, _ = motion
    protraction = forward[index] + sole.y
    placed_sole = Vector((sole.x, -forward[index], up[index]))
    hoof_rotation = qx(float(roll[index]))
    foot = placed_sole + hoof_rotation @ (coronet - sole)
    # Under load the fetlock drops as the pastern leans behind the hoof.
    # The hoof rolls independently from the pastern in late stance and swing.
    pastern_angle = -.31 * (1 + .27 * gait) * load[index] + .28 * roll[index] + .13 * fold[index]
    ankle = foot + qx(float(pastern_angle)) @ (fetlock - coronet)
    blade_axis = socket - blade
    aim = body_delta.inverted() @ ankle - blade
    preferred = -(.21 + .064 * gait) * math.tanh(protraction / .32)
    tip = qx(preferred) @ blade_axis
    toward = math.atan2(blade_axis.y * aim.z - blade_axis.z * aim.y,
                        blade_axis.y * aim.y + blade_axis.z * aim.z)
    toward = max(-.27, min(.45, toward))
    assist = smooth((aim - tip).length, reach - .074, reach - .008)
    return float(preferred + (toward - preferred) * assist), ankle, foot, hoof_rotation


def fore_poses_at(poses, points, motion, trot, reach):
    targets = [fore_target(points, motion, i, delta, trot[i], reach) for i, delta in enumerate(poses)]
    # Lead and follow through the shoulder rotation over several keys.
    # An instantaneous reach correction at hoof lift-off reads as a joint snap.
    sigma = .062 * FPS
    radius = math.ceil(3 * sigma)
    window = np.exp(-.5 * (np.arange(-radius, radius + 1) / sigma) ** 2)
    angles = np.convolve(np.pad([t[0] for t in targets], (radius, radius), mode='edge'),
                         window / window.sum(), mode='valid')
    blade, socket = points[:2]
    offset = socket - blade
    return [(pose @ blade, pose @ (blade + qx(angle) @ offset), *target[1:])
            for pose, angle, target in zip(poses, angles, targets)]


def segment_lengths(points):
    return [(b - a).length for a, b in zip(points, points[1:])]


def rear_poses_at(poses, points, motion):
    _, _, _, fetlock, sole = points
    forward, up, roll, _, _, _ = motion
    swing = fetlock - sole
    out = []
    for pose, z, rise, angle in zip(poses, forward, up, roll):
        rotation = qx(float(angle))
        hoof = Vector((sole.x, -z, rise))
        axle = pose @ points[0]
        out.append((None, axle, hoof + rotation @ swing, None, rotation))
    return out


def hind_stifle_limits(distance, lengths):
    thigh, shin, cannon = lengths
    denominator = 2 * thigh * distance
    neutral = thigh * thigh + distance * distance
    lo = abs(shin - cannon) + .006
    hi = shin + cannon - .014
    return tuple(math.acos(max(-1., min(1., (neutral - reach * reach) / denominator))) for reach in (lo, hi))


def hind_stifle(seat, ankle, lengths, fraction):
    line = ankle - seat
    distance = line.length
    direction = line / distance
    ahead = Vector((0, direction.z, -direction.y)).normalized()
    lo, hi = hind_stifle_limits(distance, lengths)
    bend = lo + (hi - lo) * fraction
    return seat + lengths[0] * (math.cos(bend) * direction + math.sin(bend) * ahead)


def hind_rest_share(points, lengths):
    approach = points[3] - points[0]
    neutral = (points[1] - points[0]).angle(approach)
    lo, hi = hind_stifle_limits(approach.length, lengths)
    return float(np.clip((neutral - lo) / (hi - lo), .1, .92))


def supporting_body(leg_poses, reaches, count):
    floor_clearance = np.zeros(count)
    for poses, reach in zip(leg_poses, reaches):
        for i, (_, socket, ankle, _, _) in enumerate(poses):
            span = socket - ankle
            depth = math.sqrt(max(0., reach * reach - span.x * span.x - span.y * span.y))
            floor_clearance[i] = max(floor_clearance[i], span.z - depth)
    # Spread the body drop around weight acceptance while keeping the scapula
    # attached. The smoothed envelope still covers every reach constraint.
    radius = round(.14 * FPS)
    wide = np.pad(floor_clearance, (radius, radius), mode='edge')
    envelope = np.lib.stride_tricks.sliding_window_view(wide, 2 * radius + 1).max(axis=1)
    weights = np.hanning(2 * radius + 1)
    return np.convolve(np.pad(envelope, (radius, radius), mode='edge'), weights / weights.sum(), mode='valid')


def bake(rig, legs, clip=CLIP, duration=DURATION, gait_speed=None):
    on_trail = gait_speed is None
    times = curve_times() if on_trail else cycle_times(duration, gait_speed, clip == 'Trot')
    t, speed, distance, trot, phase = times
    data = [foot_motion(i, -pts[-1].y, times, on_trail) for i, (_, _, pts, _) in enumerate(legs)]
    rest = {bone.name: bone.matrix_local.copy() for bone in rig.data.bones}
    parent = {bone.name: bone.parent.name if bone.parent else None for bone in rig.data.bones}
    inverse = {name: ((rest[parent[name]].inverted() @ m) if parent[name] else m).inverted()
               for name, m in rest.items()}
    names = [bone.name for bone in rig.pose.bones]
    samples = {name: [] for name in names}
    previous = {}
    i0 = int(np.searchsorted(t, 0.0))
    frame_count = round(duration * FPS)
    effort = smooth(speed, 0, 1.25)
    theta = phase * TAU
    body_height = effort * ((.015 + .024 * trot) * -np.cos(2 * theta - .61) - .002)
    turn = .012 * np.sin(theta) * effort * (1 - trot)
    pitch = -(.021 * np.sin(theta - .61) + .007 * np.sin(2 * theta)) * effort
    breath = TAU * t / (3.7 if on_trail else duration)
    height = body_height + .0026 * np.sin(breath)
    barrel_rest = rest['Barrel']
    to_body = barrel_rest.inverted()
    body_poses = [at_pivot(barrel_rest, qx(float(angle)), Vector((shift, 0, rise))) @ to_body
                  for angle, shift, rise in zip(pitch, turn, height)]
    pelvis_rest = rest['Pelvis']
    to_pelvis = pelvis_rest.inverted()
    pelvic_pitch = effort * (.022 * np.sin(2 * theta - .43) - .008 * np.sin(theta))
    pelvic_roll = .029 * (data[0][4] - data[2][4])
    pelvis_poses = [body @ at_pivot(pelvis_rest, qx(float(p)) @ Quaternion((0, 1, 0), float(r)),
                                  Vector((0, 0, 0))) @ to_pelvis
                    for body, p, r in zip(body_poses, pelvic_pitch, pelvic_roll)]
    lengths = [segment_lengths(points[:4] if hind else points[1:5]) for _, hind, points, _ in legs]
    rest_shares = [hind_rest_share(points, lengths[j]) if hind else None
                   for j, (_, hind, points, _) in enumerate(legs)]
    reaches = [sum(lengths[j]) - (.044 if hind else .018) for j, (_, hind, _, _) in enumerate(legs)]
    leg_poses = [
        rear_poses_at(pelvis_poses, points, data[j]) if hind
        else fore_poses_at(body_poses, points, data[j], trot, reaches[j])
        for j, (_, hind, points, _) in enumerate(legs)
    ]
    settle = supporting_body(leg_poses, reaches, len(body_poses))
    for i in range(i0, i0 + frame_count + 1):
        amount = effort[i]
        at = t[i]
        beat_angle = theta[i]
        running = trot[i]
        breath_cycle = breath[i]
        body_delta = body_poses[i]
        settle_shift = Vector((0, 0, settle[i]))
        body_delta.translation -= settle_shift
        pelvis_delta = pelvis_poses[i]
        pelvis_delta.translation -= settle_shift
        world = {'Barrel': body_delta @ barrel_rest, 'Pelvis': pelvis_delta @ pelvis_rest}
        head_look = at * 1.37 if on_trail else breath_cycle
        tail_sway = at * 2.6 if on_trail else breath_cycle
        for name, angle, sway in [
            ('Neck', amount * (.049 - .027 * running) * math.sin(beat_angle + .71) + .021 * math.sin(head_look),
             (1 - amount) * .07 * math.sin(head_look)),
            ('Poll', -.022 * amount * math.sin(beat_angle + .44), .023 * math.sin(head_look + .2)),
            ('Tail base', .055 * math.sin(beat_angle - .72) * amount, .14 * math.sin(tail_sway)),
            ('Tail tip', .08 * math.sin(beat_angle - 1.5) * amount, .095 * math.sin(tail_sway - .8)),
        ]:
            root = world[parent[name]] @ rest[parent[name]].inverted()
            world[name] = root @ at_pivot(rest[name], Quaternion((0, 0, 1), sway) @ qx(angle), Vector((0, 0, 0)))

        for j, (_, hind, points, bones) in enumerate(legs):
            _, _, _, lift, load, _ = data[j]
            blade, top, ankle, foot_head, roll_q = leg_poses[j][i]
            top = top - settle_shift
            l0, l1, l2 = lengths[j]
            direct = (ankle - top).length
            if direct > l0 + l1 + l2 - .009:
                raise ValueError(f'{clip} {bones[0]} overreaches at {at:.3f}s')
            if hind:
                # The stifle points forward and the hock folds behind it. The
                # stifle uses a fraction of the reachable angle so it stays
                # clear of the fully extended configuration at push-off.
                neutral = rest_shares[j]
                working = .69 - .08 * lift[i] + .06 * load[i]
                elbow = hind_stifle(top, ankle, lengths[j], neutral + (working - neutral) * amount)
                foot_bone = bones[3]
                foot_head = ankle
                chain = bones[:3]
            else:
                shoulder, *chain, pastern, foot_bone = bones
                world[shoulder] = aimed(rest[shoulder], blade - settle_shift, top)
                world[pastern] = aimed(rest[pastern], ankle, foot_head)
                _, _, elbow_rest, knee_rest, ankle_rest, _, _ = points
                bend_rest = math.pi - (elbow_rest - knee_rest).angle(ankle_rest - knee_rest)
                bend = .055 + (1.02 + .23 * running) * lift[i]
                bend = bend_rest * (1 - amount) + bend * amount
                lower = math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * math.cos(bend))
                lower = float(np.clip(lower, max(abs(l1 - l2) + .002, direct - l0 + .002),
                                      min(l1 + l2 - .001, direct + l0 - .002)))
                elbow = circle_joint(top, ankle, l0, lower, -1)
            knee = circle_joint(elbow, ankle, l1, l2, -1 if hind else 1)
            for k, (start, end_point) in enumerate(zip((top, elbow, knee), (elbow, knee, ankle))):
                world[chain[k]] = aimed(rest[chain[k]], start, end_point)
            world[foot_bone] = Matrix.Translation(foot_head) @ (roll_q @ rest[foot_bone].to_quaternion()).to_matrix().to_4x4()

        for name in names:
            local = world[parent[name]].inverted() @ world[name] if parent[name] else world[name]
            basis = inverse[name] @ local
            p, q, _ = basis.decompose()
            if name in previous and q.dot(previous[name]) < 0:
                q.negate()
            previous[name] = q
            samples[name].append((*p, *q))
    scene = bpy.context.scene
    scene.render.fps = FPS
    scene.frame_start = 0
    scene.frame_end = frame_count
    action = bpy.data.actions.new(clip)
    action.use_fake_user = True
    action.use_frame_range = True
    action.frame_start, action.frame_end = 0, frame_count
    action.use_cyclic = not on_trail
    frames = np.arange(frame_count + 1)
    for name in names:
        bone = rig.pose.bones[name]
        bone.rotation_mode = 'QUATERNION'
        poses = np.asarray(samples[name], dtype=np.float32)
        fixed_attachment = name == 'Pelvis' or name.startswith(('Scapula.', 'Upper arm.', 'Thigh.'))
        if fixed_attachment and np.max(np.linalg.norm(poses[:, :3], axis=1)) > .00002:
            raise ValueError(f'{clip} has a moving limb attachment on {name}.')
        maximum_rotation = next((limit for prefix, limit in [('Scapula.', 6), ('Thigh.', 9), ('Gaskin.', 11)]
                                 if name.startswith(prefix)), None)
        if maximum_rotation is not None:
            adjacent = np.abs(np.sum(poses[:-1, 3:] * poses[1:, 3:], axis=1))
            if np.min(adjacent) < math.cos(math.radians(maximum_rotation) / 2):
                raise ValueError(f'{clip} has a rotation snap on {name}.')
        if not on_trail:
            if np.linalg.norm(poses[0, :3] - poses[-1, :3]) > .002 or (
                    abs(np.dot(poses[0, 3:], poses[-1, 3:])) < .99998):
                raise ValueError(f'{clip} does not close on {name}.')
            poses[-1] = poses[0]
        for prop, start, count in [('location', 0, 3), ('rotation_quaternion', 3, 4)]:
            if prop == 'location' and np.max(np.abs(poses[:, :3])) < .00001:
                continue
            for axis in range(count):
                fcurve = action.fcurves.new(bone.path_from_id(prop), index=axis, action_group=name)
                fcurve.keyframe_points.add(len(frames))
                fcurve.keyframe_points.foreach_set('co', np.c_[frames, poses[:, start + axis]].ravel())
                for key in fcurve.keyframe_points:
                    key.interpolation = 'LINEAR'
                fcurve.update()
    rig.animation_data_create().action = action
    rig.animation_data.action_slot = action.slots[0]
    if not on_trail:
        return action
    body = [[round(float(z), 5), round(float(w), 4)] for z, w in
            zip(distance[i0:i0 + frame_count + 1], trot[i0:i0 + frame_count + 1])]
    contacts = sorted(beat for values in data for beat in values[-1])
    if len(contacts) < 210 or any(24 < beat[0] < 31 for beat in contacts):
        raise ValueError('Baked hoof contacts do not match the film timeline.')
    print('Baked contacts:', len(contacts), 'torso settle (m):', round(float(settle.max()), 4))
    return {'fps': FPS, 'fromZ': TRAIL_START, 'body': body, 'contacts': contacts}


def export_glb(destination):
    bpy.ops.export_scene.gltf(
        filepath=str(destination), export_format='GLB',
        export_animations=True, export_force_sampling=False, export_animation_mode='ACTIONS',
        export_anim_single_armature=True,
        export_cameras=False, export_lights=False, export_influence_nb=4,
    )


def main():
    source, work, blend = (Path(p).resolve() for p in sys.argv[sys.argv.index('--') + 1:])
    rig, legs = build_rig(source)
    motion = bake(rig, legs)
    scene = bpy.context.scene
    scene.frame_set(0)
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(blend), compress=True)
    export_glb(work / 'ridge-bay-performance.glb')
    (work / 'ridge-bay-performance.json').write_text(json.dumps(motion, separators=(',', ':')))

    rig.animation_data.action = None
    bpy.data.actions.remove(bpy.data.actions[CLIP])
    walk = bake(rig, legs, 'Walk', 1.0, 1.50)
    trot = bake(rig, legs, 'Trot', 2 / 3, 3.22)
    bake(rig, legs, 'Idle', 4.0, 0.0)
    for action in (walk, trot):
        track = rig.animation_data.nla_tracks.new()
        track.name = action.name
        track.strips.new(action.name, 0, action)
        track.mute = True
    scene.frame_set(0)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend.with_name('ridge-bay-horse.blend')), compress=True)
    export_glb(blend.with_name('ridge-bay-horse.glb'))


if __name__ == '__main__':
    main()

