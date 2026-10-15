"""Four narrow shop houses facing -Y, with awnings, lit windows, AC units and a roof spinner."""
import math
import random

import kit

GROUND = 0.14   # sidewalk top
FLOOR0 = 1.0    # shop floor height
FLOOR = 0.9     # upper floor height

SHOPS = [
    dict(name='Shop_A', x=-1.6, y=1.9, w=2.0, d=1.8, floors=2, body='#e8dcc4', trim='#7a4a2e', awning='#2f5d8a', roof='gable'),
    dict(name='Shop_B', x=0.6, y=1.9, w=2.2, d=1.8, floors=4, body='#8fb8ad', trim='#3d5a55', awning='#c8452f', roof='flat'),
    dict(name='Shop_C', x=2.8, y=1.9, w=2.0, d=1.8, floors=3, body='#c8634a', trim='#5b2f24', awning='#e7c24a', roof='parapet'),
    dict(name='Shop_D', x=2.9, y=-0.4, w=1.8, d=2.0, floors=2, body='#d9b98a', trim='#6a4b2c', awning='#3f7a5e', roof='gable'),
]


def top(name):
    shop = next(s for s in SHOPS if s['name'] == name)
    return GROUND + FLOOR0 + FLOOR * (shop['floors'] - 1)


def _shop(spec, index, root, rng):
    w, d, floors = spec['w'], spec['d'], spec['floors']
    height = FLOOR0 + FLOOR * (floors - 1)
    body, trim = kit.material(spec['name'] + '_body', spec['body'], 0.85), kit.material(spec['name'] + '_trim', spec['trim'], 0.7)
    glass, lit = kit.material('window_dark', '#2b3a44', 0.2), kit.material('window_lit', '#ffe2a8', 0.3, emission='#ffd08a', strength=2.0)
    shop = kit.empty(spec['name'], (spec['x'], spec['y'], GROUND), root)
    kit.box(spec['name'] + '_Body', (w, d, height), (0, 0, height / 2), body, shop)
    kit.boxes(spec['name'] + '_Bands', [((w + 0.06, d + 0.06, 0.06), (0, 0, FLOOR0 + FLOOR * f)) for f in range(floors - 1)] + [((w + 0.08, d + 0.08, 0.08), (0, 0, height))], trim, shop)
    front = -d / 2 - 0.02
    dark_windows, lit_windows = [], []
    for f in range(1, floors):
        z = FLOOR0 + FLOOR * (f - 1) + FLOOR * 0.5
        for x in (-w * 0.25, w * 0.25):
            (lit_windows if rng.random() < 0.4 else dark_windows).append(((0.5, 0.04, 0.42), (x, front, z)))
    if dark_windows:
        kit.boxes(spec['name'] + '_Windows', dark_windows, glass, shop)
    if lit_windows:
        kit.boxes(spec['name'] + '_Windows_Lit', lit_windows, lit, shop)
    kit.boxes(spec['name'] + '_Sills', [((0.6, 0.1, 0.05), (x, front - 0.03, z - 0.24)) for (_, (x, _, z)) in dark_windows + lit_windows], trim, shop)
    kit.box(spec['name'] + '_Shopfront', (w * 0.7, 0.04, 0.62), (0, front, 0.42), lit, shop)
    kit.box(spec['name'] + '_Awning', (w * 0.85, 0.5, 0.04), (0, front - 0.22, 0.98), kit.material(spec['name'] + '_awning', spec['awning'], 0.8), shop, rot=(math.radians(-18), 0, 0))
    kit.boxes(spec['name'] + '_Noren', [((0.18, 0.01, 0.32), (x, front - 0.04, 0.6)) for x in (-0.2, 0, 0.2)], kit.material('noren', '#24345a', 0.9, double_sided=True), shop)
    # roof
    tile = kit.material('roof_tile', '#7c3b32', 0.8)
    if spec['roof'] == 'gable':
        kit.prism(spec['name'] + '_Roof', w + 0.25, d + 0.25, 0.5, (0, 0, height + 0.04), tile, shop)
    elif spec['roof'] == 'flat':
        kit.boxes(spec['name'] + '_Parapet', [((w, 0.08, 0.2), (0, sy * (d / 2 - 0.04), height + 0.1)) for sy in (-1, 1)] + [((0.08, d, 0.2), (sx * (w / 2 - 0.04), 0, height + 0.1)) for sx in (-1, 1)], trim, shop)
    else:
        kit.boxes(spec['name'] + '_Parapet', [((w + 0.08, 0.1, 0.35), (0, -d / 2, height + 0.17)), ((w * 0.5, 0.1, 0.25), (0, -d / 2, height + 0.45))], trim, shop)
    # AC unit with spinning fan on the front, top floor
    unit = kit.material('ac_unit', '#d6d8d4', 0.6)
    fan_metal = kit.material('ac_fan', '#5d6166', 0.5, metallic=0.6)
    z = height - FLOOR * 0.5 if floors > 1 else 0.8
    kit.box(spec['name'] + '_AC', (0.45, 0.3, 0.35), (w / 2 - 0.3, front - 0.15, z), unit, shop, bevel=0.02)
    fan = kit.empty('AC_Fan_%d' % index, (w / 2 - 0.3, front - 0.31, z), shop)
    fan.rotation_mode = 'ZXY'
    fan.rotation_euler = (math.radians(90), 0, 0)
    kit.boxes('AC_Fan_%d_Blades' % index, [((0.22, 0.03, 0.05), (0, 0, 0), (0, math.radians(a), 0)) for a in (0, 60, 120)], fan_metal, fan)
    kit.spin(fan, 2, 6 + index)
    return shop


def build(root):
    rng = random.Random(7)
    for index, spec in enumerate(SHOPS, start=1):
        _shop(spec, index, root, rng)
    # Shop_C: balcony with laundry pole
    c = next(s for s in SHOPS if s['name'] == 'Shop_C')
    rail = kit.material('balcony_rail', '#3a3d40', 0.5, metallic=0.7)
    z = GROUND + FLOOR0 + FLOOR * 0.05
    kit.box('Shop_C_Balcony', (1.2, 0.4, 0.06), (c['x'], c['y'] - c['d'] / 2 - 0.2, z), rail, root)
    kit.boxes('Shop_C_Balcony_Rail', [((0.02, 0.02, 0.4), (c['x'] + x, c['y'] - c['d'] / 2 - 0.38, z + 0.2)) for x in (-0.58, -0.3, 0, 0.3, 0.58)] + [((1.2, 0.03, 0.03), (c['x'], c['y'] - c['d'] / 2 - 0.38, z + 0.4))], rail, root)
    kit.tube('Shop_C_Laundry_Pole', [(c['x'] - 0.6, c['y'] - c['d'] / 2 - 0.3, z + 0.75), (c['x'] + 0.6, c['y'] - c['d'] / 2 - 0.3, z + 0.75)], 0.012, rail, root)
    kit.boxes('Shop_C_Laundry', [((0.22, 0.01, 0.3), (c['x'] + x, c['y'] - c['d'] / 2 - 0.3, z + 0.58)) for x in (-0.35, 0, 0.3)], kit.material('laundry', '#f2efe6', 0.9, double_sided=True), root)
    # Shop_B: fire escape on the +X side
    b = next(s for s in SHOPS if s['name'] == 'Shop_B')
    steel = kit.material('fire_escape', '#4b4f54', 0.6, metallic=0.5)
    platforms = [((0.4, 1.2, 0.04), (b['x'] + b['w'] / 2 + 0.2, b['y'] - 0.1, GROUND + FLOOR0 + FLOOR * f)) for f in range(b['floors'] - 1)]
    kit.boxes('Shop_B_Fire_Escape', platforms, steel, root)
    # Shop_C roof spinner (turbine vent)
    vent = kit.material('vent', '#a7abb0', 0.4, metallic=0.8)
    spinner = kit.empty('Roof_Spinner', (c['x'] + 0.5, c['y'] + 0.3, top('Shop_C') + 0.1), root)
    kit.cylinder('Roof_Spinner_Drum', 0.12, 0.2, (0, 0, 0.1), vent, spinner)
    kit.boxes('Roof_Spinner_Fins', [((0.02, 0.26, 0.18), (0, 0, 0.1), (0, 0, math.radians(a))) for a in range(0, 180, 30)], vent, spinner)
    kit.spin(spinner, 2, 4)
