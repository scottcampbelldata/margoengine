"""Cat: one orange cat walks an out-and-back loop on the front sidewalk with stepping legs and a swishing tail."""
import math

import bake
import kit

CATS = [
    dict(name='Cat_1', coat='#e08a3c', chest='#f6efe2', path=((-1.0, -2.12, 0.16), (1.2, -2.12, 0.16))),
]


def _smooth(t):
    return t * t * (3 - 2 * t)


def _cat(atlas, spec, root):
    name, coat, chest = spec['name'], 'paint:' + spec['coat'], 'paint:' + spec['chest']
    cat = kit.empty(name, (0, 0, 0), root)
    sitting = 'sit' in spec
    if sitting:
        atlas.add(kit.sphere(name + '_Body', 0.075, (0, 0, 0.09), None, cat, scale=(1.1, 0.95, 1.35)), coat)
        atlas.add(kit.sphere(name + '_Chest', 0.05, (0.05, 0, 0.11), None, cat, scale=(0.8, 0.9, 1.3)), chest)
        head_at = (0.04, 0, 0.215)
        tail_at, tail_dir = (-0.07, 0, 0.03), (-1, 0, 0)
        atlas.add(kit.boxes(name + '_Paws', [((0.04, 0.025, 0.02), (0.07, side * 0.03, 0.01)) for side in (-1, 1)], None, cat), chest)
    else:
        atlas.add(kit.sphere(name + '_Body', 0.07, (0, 0, 0.14), None, cat, scale=(1.9, 0.95, 0.95)), coat)
        atlas.add(kit.sphere(name + '_Chest', 0.06, (0.08, 0, 0.13), None, cat, scale=(0.9, 0.85, 0.9)), chest)
        head_at = (0.16, 0, 0.21)
        tail_at, tail_dir = (-0.12, 0, 0.16), (-1, 0, 0.6)
        for leg, (lx, ly) in (('FL', (0.08, 0.035)), ('FR', (0.08, -0.035)), ('BL', (-0.08, 0.035)), ('BR', (-0.08, -0.035))):
            hip = kit.empty('%s_Leg_%s' % (name, leg), (lx, ly, 0.13), cat)
            atlas.add(kit.cylinder('%s_Leg_%s_Bone' % (name, leg), 0.017, 0.12, (0, 0, -0.06), None, hip, segments=8), coat)
            atlas.add(kit.sphere('%s_Leg_%s_Paw' % (name, leg), 0.02, (0.006, 0, -0.12), None, hip, scale=(1.3, 1, 0.7), segments=8, rings=5), chest)
    for patch_color, (px, py, pz, r) in zip(spec.get('patches', ()), ((-0.02, 0.05, 0.12, 0.04), (0.0, -0.05, 0.08, 0.035))):
        atlas.add(kit.sphere(name + '_Patch_' + patch_color[1:], r, (px, py, pz), None, cat, scale=(1.2, 0.6, 1.1)), 'paint:' + patch_color)
    hx, hy, hz = head_at
    atlas.add(kit.sphere(name + '_Head', 0.055, head_at, None, cat, scale=(1.0, 1.05, 0.92)), coat)
    atlas.add(kit.sphere(name + '_Muzzle', 0.026, (hx + 0.045, 0, hz - 0.015), None, cat, scale=(0.8, 1.2, 0.8)), chest)
    atlas.add(kit.sphere(name + '_Nose', 0.008, (hx + 0.065, 0, hz - 0.005), None, cat, segments=8, rings=4), 'paint:#e88a8a')
    for side in (-1, 1):
        atlas.add(kit.cylinder('%s_Ear_%d' % (name, side), 0.022, 0.05, (hx - 0.005, side * 0.032, hz + 0.05), None, cat, rot=(side * 0.25, 0, 0), segments=6, radius_top=0.0), coat)
        atlas.add(kit.sphere('%s_Eye_%d' % (name, side), 0.011, (hx + 0.045, side * 0.024, hz + 0.012), None, cat, segments=8, rings=4), 'paint:#d9c23a')
        atlas.add(kit.sphere('%s_Pupil_%d' % (name, side), 0.006, (hx + 0.054, side * 0.024, hz + 0.012), None, cat, segments=6, rings=4), 'paint:#111111')
    # Tail: a chain of four jointed segments, each swinging a little later than the one before.
    parent, origin = cat, tail_at
    segment = (tail_dir[0] * 0.055, 0, tail_dir[2] * 0.055 + 0.012)
    for k in range(1, 5):
        joint = kit.empty('%s_Tail_%d' % (name, k), origin, parent)
        atlas.add(kit.tube('%s_Tail_%d_Seg' % (name, k), [(0, 0, 0), segment], 0.014 - 0.002 * k, None, joint, sides=6), coat if k < 4 or spec['coat'] != '#26262b' else chest)
        kit.swing(joint, 2, 14 + 4 * k, 4 if not sitting else 3, phase=0.07 * k)
        parent, origin = joint, segment
    return cat


def _walk(cat, a, b):
    """Out along a->b, turn, back, turn; legs step the whole time. Seamless over the clip."""
    yaw0 = math.atan2(b[1] - a[1], b[0] - a[0])
    for frame in range(kit.FRAME_START, kit.FRAME_END + 1, 3):
        t = (frame - kit.FRAME_START) / (kit.FRAME_END - kit.FRAME_START)
        if t <= 0.45:
            f, yaw = _smooth(t / 0.45), yaw0
        elif t <= 0.5:
            f, yaw = 1.0, yaw0 + math.pi * _smooth((t - 0.45) / 0.05)
        elif t <= 0.95:
            f, yaw = 1.0 - _smooth((t - 0.5) / 0.45), yaw0 + math.pi
        else:
            f, yaw = 0.0, yaw0 + math.pi + math.pi * _smooth((t - 0.95) / 0.05)
        kit.key(cat, frame, location=tuple(a[i] + (b[i] - a[i]) * f for i in range(3)), rotation_euler=(0, 0, yaw))
    for leg, phase in (('FL', 0.0), ('BR', 0.0), ('FR', 0.5), ('BL', 0.5)):
        kit.swing(kit.SCENE.objects['%s_Leg_%s' % (cat.name, leg)], 1, 28, 16, phase=phase, step=3)


def build(root):
    atlas = bake.Atlas('Cats_Atlas', 1024, roughness=0.8)
    group = kit.empty('Cats', (0, 0, 0), root)
    for spec in CATS:
        cat = _cat(atlas, spec, group)
        if 'sit' in spec:
            cat.location = spec['sit']
            cat.rotation_euler = (0, 0, spec['yaw'])
        else:
            _walk(cat, *spec['path'])
    return group
