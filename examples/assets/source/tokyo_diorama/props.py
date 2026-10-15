"""Street clutter: utility pole and sagging power lines, banners, vending machine, post box, plants, bench, bicycle."""
import math

import buildings
import kit

G = buildings.GROUND


def _pole(root):
    wood, steel = kit.material('pole_wood', '#5a4636', 0.9), kit.material('pole_steel', '#7b7f84', 0.5, metallic=0.6)
    pole = kit.empty('Utility_Pole', (-2.45, -1.7, G), root)
    kit.cylinder('Utility_Pole_Shaft', 0.07, 4.6, (0, 0, 2.3), wood, pole, segments=10, radius_top=0.05)
    kit.boxes('Utility_Pole_Arms', [((1.4, 0.08, 0.08), (0, 0, 4.25)), ((1.0, 0.08, 0.08), (0, 0, 3.85))], wood, pole)
    kit.cylinder('Utility_Pole_Transformer', 0.16, 0.42, (0.22, 0.12, 3.35), steel, pole, segments=12)
    kit.boxes('Utility_Pole_Insulators', [((0.05, 0.05, 0.08), (x, 0, z + 0.08)) for x, z in ((-0.6, 4.25), (0, 4.25), (0.6, 4.25), (-0.45, 3.85), (0.45, 3.85))], kit.material('insulator', '#e9e4da', 0.4), pole)
    return pole


def _wires(root):
    black = kit.material('wire', '#1d1e20', 0.6, double_sided=True)
    px, py = -2.45, -1.7
    a, b = buildings.SHOPS[0], buildings.SHOPS[1]
    runs = [
        ((px - 0.6, py, G + 4.33), (a['x'] - 0.4, a['y'] - a['d'] / 2, buildings.top('Shop_A') - 0.1), 0.25),
        ((px, py, G + 4.33), (b['x'] - 0.6, b['y'] - b['d'] / 2, buildings.top('Shop_B') - 0.6), 0.3),
        ((px + 0.6, py, G + 4.33), (4.6, -2.2, G + 3.6), 0.35),          # runs off the slab, front right
        ((px - 0.45, py, G + 3.93), (-5.2, -0.4, G + 3.2), 0.3),         # runs off the slab, left
        ((px + 0.45, py, G + 3.93), (2.9 - 0.7, -1.4, G + 1.8), 0.2),    # to Shop_D
        ((px - 0.6, py, G + 4.33), (-4.8, -3.6, G + 3.4), 0.3),          # off the front-left corner
    ]
    for i, (start, end, drop) in enumerate(runs, start=1):
        kit.tube('Power_Line_%d' % i, kit.sag(start, end, drop), 0.012, black, root, sides=4)


def _banners(root):
    pole_mat = kit.material('banner_pole', '#2f3134', 0.5, metallic=0.5)
    colors = [('#2f7f7a', '#f4efe2'), ('#c8452f', '#fff3d6'), ('#f1e6c8', '#c8452f')]
    for i, (x, y) in enumerate(((1.75, -0.45), (1.75, -1.0), (1.75, -1.55)), start=1):
        cloth, mark = colors[i - 1]
        kit.cylinder('Banner_%d_Pole' % i, 0.015, 1.7, (x, y, G + 0.85), pole_mat, root, segments=8)
        flag = kit.empty('Banner_%d' % i, (x, y, G + 1.62), root)
        kit.box('Banner_%d_Cloth' % i, (0.32, 0.01, 1.05), (0.17, 0, -0.55), kit.material('banner_%d' % i, cloth, 0.9, double_sided=True), flag)
        kit.boxes('Banner_%d_Marks' % i, [(size, (0.17 + x2, -0.008, -0.55 + z)) for size, (x2, _, z) in kit.glyph_specs(0.24, 0.8, seed=20 + i, cells=1, depth=0.004)], kit.material('banner_mark_%d' % i, mark, 0.9), flag)
        kit.swing(flag, 2, 9, 2, phase=0.27 * i)


def _street_furniture(root):
    red = kit.material('vending_red', '#d9473b', 0.5)
    vend = kit.empty('Vending_Machine', (-0.55, 0.78, G), root)
    kit.box('Vending_Machine_Body', (0.62, 0.46, 1.25), (0, 0, 0.625), red, vend, bevel=0.02)
    kit.box('Vending_Machine_Display', (0.48, 0.02, 0.56), (0, -0.235, 0.86), kit.material('vending_display', '#cfeeff', 0.2, emission='#bfe8ff', strength=2.2), vend)
    kit.boxes('Vending_Machine_Buttons', [((0.05, 0.02, 0.03), (-0.18 + 0.09 * k, -0.24, 0.5)) for k in range(5)], kit.material('vending_button', '#f4d35e', 0.4, emission='#f4d35e', strength=1.0), vend)

    post_red = kit.material('post_red', '#c62d2d', 0.45)
    post = kit.empty('Post_Box', (-1.75, -1.45, G), root)
    kit.cylinder('Post_Box_Body', 0.17, 0.72, (0, 0, 0.36), post_red, post, segments=16)
    kit.sphere('Post_Box_Dome', 0.17, (0, 0, 0.72), post_red, post, scale=(1, 1, 0.55))
    kit.box('Post_Box_Slot', (0.16, 0.02, 0.03), (0, -0.17, 0.58), kit.material('post_slot', '#1f1f1f', 0.8), post)

    timber, iron = kit.material('bench_timber', '#a0703f', 0.8), kit.material('bench_iron', '#33363a', 0.5, metallic=0.6)
    bench = kit.empty('Bench', (-1.5, 0.72, G), root)
    kit.boxes('Bench_Slats', [((1.1, 0.12, 0.04), (0, y, 0.42)) for y in (-0.1, 0.04)] + [((1.1, 0.04, 0.12), (0, 0.12, 0.62))], timber, bench)
    kit.boxes('Bench_Legs', [((0.05, 0.3, 0.42), (x, 0, 0.21)) for x in (-0.48, 0.48)], iron, bench)

    frame = kit.material('bicycle_frame', '#2b6cb0', 0.4, metallic=0.4)
    bike = kit.empty('Bicycle', (1.15, 0.62, G), root)
    for name, cx in (('Bicycle_Wheel_Rear', -0.32), ('Bicycle_Wheel_Front', 0.32)):
        kit.tube(name, kit.ring((cx, 0, 0.24), 0.22, 'Y'), 0.015, iron, bike, sides=4)
    kit.tube('Bicycle_Frame', [(-0.32, 0, 0.24), (-0.05, 0, 0.5), (0.25, 0, 0.5), (0.32, 0, 0.24), (0.0, 0, 0.26), (-0.32, 0, 0.24)], 0.018, frame, bike, sides=5)
    kit.boxes('Bicycle_Seat_Bars', [((0.14, 0.05, 0.03), (-0.1, 0, 0.6)), ((0.03, 0.3, 0.03), (0.27, 0, 0.62))], iron, bike)
    bike.rotation_euler = (0, 0, math.radians(8))


def _greenery(root):
    pot, leaf, leaf2 = kit.material('pot', '#b5653c', 0.85), kit.material('leaf', '#4f8a3c', 0.85), kit.material('leaf_light', '#6aa84f', 0.85)
    for i, (x, y, s) in enumerate(((-2.4, 0.9, 1.0), (-0.1, 0.82, 0.8), (-0.9, -1.5, 1.1), (0.15, 0.82, 0.7), (2.35, 0.8, 0.9)), start=1):
        kit.cylinder('Plant_%d_Pot' % i, 0.13 * s, 0.24 * s, (x, y, G + 0.12 * s), pot, root, segments=10, radius_top=0.16 * s)
        kit.ico('Plant_%d_Leaves' % i, 0.2 * s, (x, y, G + 0.36 * s), leaf if i % 2 else leaf2, root, scale=(1, 1, 1.2))
    trunk = kit.material('trunk', '#6b4a33', 0.9)
    tx, ty = -2.2, -0.3
    kit.tube('Tree_Trunk', [(tx, ty, G), (tx + 0.05, ty, G + 0.9), (tx - 0.05, ty + 0.05, G + 1.5)], 0.06, trunk, root, sides=6)
    for k, (dx, dy, dz, r) in enumerate(((0, 0, 1.6, 0.42), (0.25, 0.1, 1.4, 0.3), (-0.22, -0.05, 1.45, 0.32))):
        kit.ico('Tree_Canopy_%d' % (k + 1), r, (tx - 0.05 + dx, ty + 0.05 + dy, G + dz), leaf2 if k else leaf, root)


def _signs_and_rails(root):
    blade = kit.empty('Shop_A_Blade_Sign', (-0.75, 1.0 - 0.02, G + 1.55), root)
    kit.box('Shop_A_Blade_Sign_Board', (0.06, 0.3, 0.8), (0, -0.18, 0), kit.material('blade_board', '#f6e7c8', 0.5, emission='#fff0cf', strength=1.4), blade)
    kit.boxes('Shop_A_Blade_Sign_Marks', [((0.02, s[0] * 0.5, s[2]), (-0.035, -0.18 + l[0] * 0.5, l[2])) for s, l in kit.glyph_specs(0.24, 0.62, seed=31, cells=1)], kit.material('blade_marks', '#7a1f1f', 0.6), blade)
    for spec, seed, lit in zip(buildings.SHOPS, (41, 42, 43, 44), (True, False, True, False)):
        y = spec['y'] - spec['d'] / 2 - 0.06
        holder = kit.empty(spec['name'] + '_Sign', (spec['x'], y, G + 1.2), root)
        face = kit.material('shop_sign_lit' if lit else 'shop_sign', '#fbf1d8' if lit else '#2f2a26', 0.5, emission='#ffe6b0' if lit else None, strength=1.6 if lit else 0.0)
        kit.box(spec['name'] + '_Sign_Board', (spec['w'] * 0.6, 0.05, 0.22), (0, 0, 0), face, holder)
        kit.boxes(spec['name'] + '_Sign_Marks', [(size, (x, -0.03, z)) for size, (x, _, z) in kit.glyph_specs(spec['w'] * 0.5, 0.18, seed=seed)], kit.material('shop_sign_marks_dark' if lit else 'shop_sign_marks_light', '#3a2a22' if lit else '#f1d9a0', 0.6), holder)
    red_rail = kit.material('red_rail', '#b23a30', 0.5)
    c = buildings.SHOPS[2]
    kit.boxes('Railing', [((0.05, 0.05, 0.5), (c['x'] - 0.9 + 0.3 * k, -1.62, G + 0.25)) for k in range(7)] + [((1.85, 0.04, 0.05), (c['x'] - 0.0, -1.62, G + z)) for z in (0.25, 0.48)], red_rail, root)
    crate = kit.material('crate', '#b08453', 0.85)
    kit.boxes('Crates', [((0.34, 0.3, 0.26), (0.85, -1.55, G + 0.13)), ((0.34, 0.3, 0.26), (1.2, -1.55, G + 0.13)), ((0.3, 0.28, 0.24), (1.02, -1.57, G + 0.38))], crate, root)


def build(root):
    _pole(root)
    _wires(root)
    _banners(root)
    _street_furniture(root)
    _greenery(root)
    _signs_and_rails(root)
