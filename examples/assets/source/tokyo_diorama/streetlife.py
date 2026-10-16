"""Street life: utility poles and wires, vending machines, post box, bicycles, cones, signs, greenery, tram stop, alley clutter, birds."""
import math
import random

from mathutils import Vector

import bake
import kit
import foliage
import signs

G = 0.16
POLE_1, POLE_2 = (-3.0, -1.95), (3.95, -1.95)
STOP_SIGN = (4.05, 0.4)  # beside Building_3's rear corner, clear of its side doorway
BENCH_SEAT_HEIGHT = 0.22  # seat top above the pavement, scaled to the diorama's doorways


def _pole(atlas, name, x, y, height=5.0):
    pole = kit.empty(name, (x, y, G), None)
    atlas.add(kit.cylinder(name + '_Shaft', 0.075, height, (x, y, G + height / 2), None, None, segments=12, radius_top=0.055), 'paint:#8d8478')
    atlas.add(kit.boxes(name + '_Arms', [((1.5, 0.09, 0.09), (x, y, G + height - 0.4)), ((1.1, 0.09, 0.09), (x, y, G + height - 0.8))], None, None), 'wood_dark')
    atlas.add(kit.boxes(name + '_Insulators', [((0.05, 0.05, 0.1), (x + dx, y, G + z + 0.09)) for dx, z in ((-0.65, height - 0.4), (0, height - 0.4), (0.65, height - 0.4), (-0.45, height - 0.8), (0.45, height - 0.8))], None, None), 'paint:#e9e4da')
    atlas.add(kit.boxes(name + '_Steps', [((0.14, 0.03, 0.03), (x, y, G + 1.6 + 0.25 * k), (0, 0, (k % 2) * math.pi / 2)) for k in range(10)], None, None), 'metal_dark')
    return pole, [(x + dx, y, G + z + 0.12) for dx, z in ((-0.65, height - 0.4), (0, height - 0.4), (0.65, height - 0.4), (-0.45, height - 0.8), (0.45, height - 0.8))]


def _bicycle(atlas, name, x, y, yaw):
    bike = kit.empty(name, (x, y, G), None)
    bike.rotation_euler = (0, 0, yaw)
    bike.scale = (0.7, 0.7, 0.7)  # match the small doorways while keeping wheel contact at the pavement
    for part, cx in (('Rear', -0.27), ('Front', 0.27)):
        atlas.add(kit.tube('%s_Wheel_%s' % (name, part), kit.ring((cx, 0, 0.2), 0.19, 'Y', n=24), 0.014, None, bike, sides=4), 'rubber')
        atlas.add(kit.boxes('%s_Spokes_%s' % (name, part), [((0.36, 0.004, 0.004), (cx, 0, 0.2), (0, math.radians(a), 0)) for a in range(0, 180, 30)], None, bike), 'metal_light')
    atlas.add(kit.tube(name + '_Frame', [(-0.27, 0, 0.2), (-0.05, 0, 0.42), (0.2, 0, 0.42), (0.27, 0, 0.2), (0.0, 0, 0.22), (-0.27, 0, 0.2)], 0.016, None, bike, sides=5), 'paint:#2b6cb0' if 'Alley' not in name else 'paint:#c8452f')
    atlas.add(kit.tube(name + '_Fork', [(0.2, 0, 0.42), (0.23, 0, 0.55)], 0.012, None, bike, sides=4), 'metal_light')
    atlas.add(kit.tube(name + '_Bars', [(0.21, -0.14, 0.56), (0.23, 0, 0.55), (0.21, 0.14, 0.56)], 0.01, None, bike, sides=4), 'metal_light')
    atlas.add(kit.box(name + '_Seat', (0.13, 0.06, 0.03), (-0.08, 0, 0.5), None, bike, bevel=0.01), 'rubber')
    atlas.add(kit.box(name + '_Basket', (0.14, 0.18, 0.1), (0.32, 0, 0.5), None, bike), 'metal_dark')
    return bike


def _vending(atlas, name, x, y, yaw, color):
    vm = kit.empty(name, (x, y, G), None)
    vm.rotation_euler = (0, 0, yaw)
    vm.scale = (0.74, 0.74, 0.74)  # vending-machine scale next to the doors (about one door high)
    atlas.add(kit.box(name + '_Body', (0.62, 0.46, 1.28), (0, 0, 0.64), None, vm, bevel=0.025), 'paint:' + color)
    atlas.add(kit.box(name + '_Plinth', (0.6, 0.44, 0.08), (0, 0, 0.04), None, vm), 'metal_dark')
    signs.panel(name + '_Face', 'vending', 0.54, (0, -0.236, 0.7), vm)
    atlas.add(kit.box(name + '_Coin_Panel', (0.1, 0.03, 0.18), (0.22, -0.24, 0.5), None, vm), 'metal_light')
    atlas.add(kit.box(name + '_Bin', (0.26, 0.26, 0.5), (0.48, -0.05, 0.25), None, vm, bevel=0.02), 'paint:#eef0ee')
    atlas.add(kit.cylinder(name + '_Bin_Hole', 0.06, 0.01, (0.48, -0.18, 0.4), None, vm, rot=(math.radians(90), 0, 0), segments=12), 'rubber')
    return vm


def _ground(x, y):
    """Surface height: sidewalk block or road."""
    return G if -3.3 <= x <= 4.2 and -2.2 <= y <= 3.4 else 0.04


def _cone(atlas, name, x, y):
    z = _ground(x, y)
    atlas.add(kit.cylinder(name, 0.09, 0.4, (x, y, z + 0.235), None, None, segments=14, radius_top=0.015), 'paint:#f26b1d')
    atlas.add(kit.cylinder(name + '_Band', 0.066, 0.07, (x, y, z + 0.275), None, None, segments=14, radius_top=0.05), 'paint:#f4f2ec')
    atlas.add(kit.box(name + '_Base', (0.24, 0.24, 0.035), (x, y, z + 0.0175), None, None, bevel=0.01), 'paint:#2a2a2a')


def _planter(atlas, name, x, y, rng, flowers=True):
    atlas.add(kit.box(name, (0.45, 0.28, 0.22), (x, y, G + 0.11), None, None, bevel=0.012), 'cedar')
    atlas.add(kit.box(name + '_Soil', (0.4, 0.24, 0.02), (x, y, G + 0.22), None, None), 'soil')
    foliage.hedge(atlas, name + '_Hedge', (x, y, G + 0.22 + 0.1), (0.42, 0.26, 0.2), None, bloom=0.35 if flowers else 0.0, seed=rng.randint(0, 10 ** 6))


def _bird(atlas, name, pos, yaw, rng):
    bird = kit.empty(name, pos, None)
    bird.rotation_euler = (0, 0, yaw)
    color = rng.choice(('paint:#4a4f57', 'paint:#6b5a48', 'paint:#3a3d42'))
    atlas.add(kit.sphere(name + '_Body', 0.045, (0, 0, 0.04), None, bird, scale=(1.4, 0.9, 0.9), segments=10, rings=6), color)
    atlas.add(kit.sphere(name + '_Head', 0.028, (0.05, 0, 0.075), None, bird, segments=10, rings=6), color)
    atlas.add(kit.cylinder(name + '_Beak', 0.008, 0.025, (0.08, 0, 0.073), None, bird, rot=(0, math.radians(90), 0), segments=6, radius_top=0.0), 'paint:#e0a92e')
    atlas.add(kit.box(name + '_Tail', (0.06, 0.03, 0.01), (-0.07, 0, 0.05), None, bird, rot=(0, math.radians(-20), 0)), color)
    return bird


def build(root):
    rng = random.Random(42)
    atlas = bake.Atlas('Props_Atlas', 2048, roughness=0.65)
    group = kit.empty('Street_Life', (0, 0, 0), root)

    def parent(ob):
        ob.parent = group
        return ob

    pole1, ends1 = _pole(atlas, 'Utility_Pole_1', *POLE_1)
    pole2, ends2 = _pole(atlas, 'Utility_Pole_2', *POLE_2)
    atlas.add(kit.cylinder('Transformer', 0.17, 0.48, (POLE_1[0] + 0.24, POLE_1[1] + 0.12, G + 3.6), None, None, segments=14), 'paint:#9aa3a6')
    atlas.add(kit.cylinder('Street_Lamp_Pole', 0.04, 2.6, (1.75, -2.0, G + 1.3), None, None, segments=10), 'metal_dark')
    atlas.add(kit.tube('Street_Lamp_Arm', [(1.75, -2.0, G + 2.55), (1.75, -2.2, G + 2.7), (1.75, -2.45, G + 2.66)], 0.025, None, None, sides=6), 'metal_dark')
    kit.box('Street_Lamp_Head', (0.12, 0.22, 0.05), (1.75, -2.45, G + 2.62), kit.material('lamp_warm', '#fff3d6', 0.3, emission='#ffe2a8', strength=4.0), None)

    # Power lines: pole to pole, service drops to facades, and runs off the slab edge.
    wires = []
    for a, b in zip(ends1[:3], ends2[:3]):
        wires.append((a, b, 0.45))
    wires += [(ends1[3], (-2.7, -0.6, G + 2.6), 0.2), (ends1[4], (-0.5, -1.6, G + 2.9), 0.25), (ends1[0], (-5.6, -0.8, G + 3.9), 0.35),
              (ends1[1], (-4.6, -4.7, G + 3.7), 0.3), (ends2[0], (5.7, -1.2, G + 3.8), 0.3), (ends2[2], (5.3, -4.6, G + 3.6), 0.3),
              (ends2[3], (3.6, -0.6, G + 1.8), 0.15), (ends2[4], (1.2, -1.6, G + 3.4), 0.2), (ends1[2], (-1.0, 0.7, G + 4.2), 0.3)]
    black = 'rubber'
    perches = []
    for i, (a, b, drop) in enumerate(wires, start=1):
        pts = kit.sag(a, b, drop, n=20)
        atlas.add(kit.tube('Power_Line_%d' % i, pts, 0.011, None, None, sides=4), black)
        if i in (1, 2):
            perches += [pts[k] for k in (5, 7, 13)]

    # Signs on poles and kerb.
    signs.panel('Street_Name_Plate', 'street', 0.5, (POLE_1[0], POLE_1[1] - 0.09, G + 2.3), None)
    signs.panel('No_Bikes_Sign', 'no_bikes', 0.3, (POLE_2[0], POLE_2[1] - 0.09, G + 1.9), None)
    sx, sy = STOP_SIGN
    atlas.add(kit.cylinder('Stop_Sign_Pole', 0.025, 1.6, (sx, sy, G + 0.8), None, None, segments=8), 'metal_light')
    atlas.add(kit.cylinder('Stop_Sign', 0.2, 0.02, (sx, sy - 0.02, G + 1.55), None, None, rot=(math.radians(90), 0, 0), segments=3), 'paint:#d23a2f')
    atlas.add(kit.cylinder('Stop_Sign_Border', 0.23, 0.015, (sx, sy - 0.01, G + 1.55), None, None, rot=(math.radians(90), 0, 0), segments=3), 'paint:#f4f2ec')

    # Furniture.
    _vending(atlas, 'Vending_Machine_1', 3.92, 1.35, math.radians(90), '#d9473b')
    _vending(atlas, 'Vending_Machine_2', 3.92, 2.0, math.radians(90), '#2b6cb0')
    # Japanese pillar post box at post-box scale (about two thirds of a door), on the open corner by the pole,
    # clear of the cafe awning and doors: red body, domed cap, letter slot and the white 〒 plate.
    post = kit.empty('Post_Box', (-2.95, -1.62, G), None)
    atlas.add(kit.cylinder('Post_Box_Body', 0.12, 0.5, (0, 0, 0.25), None, post, segments=20), 'paint:#c62d2d')
    atlas.add(kit.cylinder('Post_Box_Band', 0.125, 0.03, (0, 0, 0.5), None, post, segments=20), 'paint:#9e1f1f')
    atlas.add(kit.sphere('Post_Box_Dome', 0.125, (0, 0, 0.515), None, post, scale=(1, 1, 0.5), segments=20, rings=8), 'paint:#c62d2d')
    atlas.add(kit.box('Post_Box_Slot', (0.13, 0.03, 0.022), (0, -0.115, 0.42), None, post), 'rubber')
    atlas.add(kit.box('Post_Box_Plate', (0.09, 0.02, 0.1), (0, -0.118, 0.27), None, post), 'paint:#f4f2ec')
    atlas.add(kit.text_mesh('Post_Box_Mark', '〒', 0.07, (0, -0.13, 0.27), None, post, rot=(math.radians(90), 0, 0)), 'paint:#c62d2d')
    # Park under the cafe window, clear of its door/menu board and outside the cat's walking lane.
    _bicycle(atlas, 'Bicycle_1', -1.95, -1.85, 0.0)
    _bicycle(atlas, 'Bicycle_2', -0.53, -0.7, math.radians(88))  # clear of the ramen side-door step
    for i, (x, y) in enumerate(((3.85, -2.05), (3.6, -2.05), (2.3, -3.74), (2.62, -3.76)), start=1):
        _cone(atlas, 'Traffic_Cone_%d' % i, x, y)
    for i, (x, y) in enumerate(((-3.05, -1.22), (-3.05, -0.08), (2.0, -1.95)), start=1):
        _planter(atlas, 'Planter_%d' % i, x, y, rng)
    atlas.add(kit.box('Hedge', (5.9, 0.2, 0.12), (0.4, 3.31, G + 0.06), None, None, bevel=0.015), 'cedar')  # planter bed
    for k in range(4):
        foliage.hedge(atlas, 'Hedge_%d' % (k + 1), (-1.825 + 1.45 * k, 3.31, G + 0.12 + 0.17), (1.35, 0.22, 0.34), None, bloom=0.12, seed=k)
    foliage.topiary(atlas, 'Street_Tree', (-3.02, 3.1, G), 1.0, None, bloom=0.3, pot=False, seed=21)
    atlas.add(kit.boxes('Street_Tree_Pit', [((0.5, 0.05, 0.05), (-3.02, 3.1 + dy, G + 0.025)) for dy in (-0.225, 0.225)]
                        + [((0.05, 0.4, 0.05), (-3.02 + dx, 3.1, G + 0.025)) for dx in (-0.225, 0.225)], None, None), 'concrete')
    atlas.add(kit.box('Street_Tree_Soil', (0.4, 0.4, 0.01), (-3.02, 3.1, G + 0.005), None, None), 'soil')

    # Tram stop on the left kerb.
    stop = kit.empty('Tram_Stop', (-3.0, 0.9, G), None)
    for dy in (-0.4, 0.4):
        atlas.add(kit.cylinder('Tram_Stop_Post_%+.1f' % dy, 0.025, 1.3, (0, dy, 0.65), None, stop, segments=8), 'metal_dark')
    atlas.add(kit.box('Tram_Stop_Roof', (0.45, 1.05, 0.04), (0.02, 0, 1.3), None, stop, rot=(0, math.radians(-8), 0)), 'paint:#3d5a55')
    seat_thickness, back_height = 0.04, 0.22
    leg_height = BENCH_SEAT_HEIGHT - seat_thickness
    atlas.add(kit.boxes('Tram_Stop_Bench', [((0.22, 0.7, seat_thickness), (0.05, 0, BENCH_SEAT_HEIGHT - seat_thickness / 2)),
                                          ((0.04, 0.7, back_height), (0.15, 0, BENCH_SEAT_HEIGHT + back_height / 2))], None, stop), 'cedar')
    supports = [((0.035, 0.04, leg_height), (0.05, dy, leg_height / 2)) for dy in (-0.26, 0.26)]
    supports += [((0.22, 0.07, 0.02), (0.05, dy, 0.01)) for dy in (-0.26, 0.26)]
    atlas.add(kit.boxes('Tram_Stop_Bench_Supports', supports, None, stop), 'metal_dark')
    signs.panel('Tram_Stop_Sign', 'number', 0.2, (-0.03, -0.55, 1.05), stop, rot=(0, 0, math.radians(-90)))

    # Alley between Building_1 and Building_2: clutter, a string of lanterns overhead.
    alley = kit.empty('Alley_1', (-0.6, -0.6, G), None)
    atlas.add(kit.boxes('Alley_Crates', [((0.24, 0.24, 0.2), (0.18, -0.95, 0.1)), ((0.24, 0.24, 0.2), (0.19, -0.95, 0.3)), ((0.22, 0.22, 0.2), (0.18, -1.2, 0.1))], None, alley), 'cedar')
    atlas.add(kit.cylinder('Alley_Drum', 0.13, 0.4, (0.18, 0.55, 0.2), None, alley, segments=14), 'paint:#2f5d8a')
    atlas.add(kit.cylinder('Alley_Drum_Lid', 0.14, 0.03, (0.18, 0.55, 0.41), None, alley, segments=14), 'paint:#24496c')
    for k, dy in enumerate((0.7, 0.85)):
        atlas.add(kit.cylinder('Alley_Gas_%d' % k, 0.07, 0.45, (0.18, dy, 0.24), None, alley, segments=12), 'paint:#9aa3a6')
        atlas.add(kit.sphere('Alley_Gas_Top_%d' % k, 0.07, (0.18, dy, 0.46), None, alley, scale=(1, 1, 0.6), segments=10, rings=6), 'paint:#9aa3a6')
    string = kit.sag((-0.3, -0.9, 1.9), (0.3, -0.9, 1.85), 0.12, n=10)
    atlas.add(kit.tube('Alley_Lantern_String', string, 0.006, None, alley, sides=4), 'rubber')
    glow = kit.material('lantern_red_lit', '#e0442f', 0.5, emission='#ff5a32', strength=2.2)
    for k, p in enumerate(string[2:-1:2]):
        kit.sphere('Alley_Lantern_%d' % k, 0.045, (p.x, p.y, p.z - 0.07), glow, alley, scale=(1, 1, 1.3), segments=10, rings=6)
    _planter(atlas, 'Alley_Planter', -0.72, 0.42, rng, flowers=False)
    atlas.add(kit.box('Beer_Crates', (0.3, 0.4, 0.42), (3.78, -1.35, G + 0.21), None, None), 'paint:#f2c94c')

    # Birds on wires and parapets.
    spots = perches[:2] + [Vector((2.4, -0.5, G + 1.95 + 0.62))]
    for i, p in enumerate(spots, start=1):
        _bird(atlas, 'Bird_%d' % i, (p.x, p.y, p.z - 0.005), rng.uniform(0, math.tau), rng)

    for ob in [o for o in kit.SCENE.objects if o.parent is None and o.name not in ('Diorama_Root', 'Street_Life')]:
        parent(ob)
    return group
