"""Five densely detailed buildings on the sidewalk block, each baked into its own atlas.

Faces: 'front' (-Y), 'back' (+Y), 'left' (-X), 'right' (+X). Facade coordinates are (u, n, v): u runs left to right as
seen from outside, n points outward from the wall, v is height above the building's ground.
"""
import math
import random
from collections import defaultdict

import bake
import kit
import foliage
import signs

GROUND = 0.16
FLOOR0, FLOOR = 1.1, 0.85

BUILDINGS = [
    dict(name='Building_1', atlas='B1_Atlas', x=(-2.7, -0.9), y=(-1.6, 0.4), floors=3, wall='plaster_beige', base='cedar', trim='paint:#6a4630',
         roof='gable', tile='tile_red', shop='cafe', faces=('front', 'left', 'right'), styles=('sash', 'shoji'), balcony=(2,), seed=1),
    dict(name='Building_2', atlas='B2_Atlas', x=(-0.3, 1.6), y=(-1.6, 0.4), floors=4, wall='plaster_mint', base='brick', trim='paint:#3d5a55',
         roof='flat', clutter=('tank', 'roof_ac', 'antenna', 'railing'), shop='ramen', faces=('front', 'left', 'right'), styles=('sash', 'louvre', 'sash'), balcony=(3,), seed=2),
    dict(name='Building_3', atlas='B3_Atlas', x=(1.75, 3.6), y=(-1.6, 0.6), floors=2, wall='plaster_cracked', base='wood_dark', trim='paint:#4a3424',
         roof='gable', tile='tile_grey', shop='stall', faces=('front', 'right', 'left'), styles=('lattice',), balcony=(), seed=3, atlas_size=1024),
    dict(name='Building_4', atlas='B4_Atlas', x=(-2.7, 0.7), y=(0.7, 3.2), floors=5, wall='plaster_grey', base='concrete', trim='paint:#5a5f66',
         roof='flat', clutter=('garden', 'railing', 'roof_ac', 'shed'), shop='books', faces=('front', 'left', 'back', 'right'), styles=('sash', 'shutter', 'sash', 'louvre'), balcony=(2, 4), balcony_face='back', seed=4),
    dict(name='Building_5', atlas='B5_Atlas', x=(1.0, 3.6), y=(0.9, 3.2), floors=3, wall='plaster_salmon', base='brick', trim='paint:#7a4030',
         roof='flat', clutter=('billboard', 'tank', 'railing'), shop='shutter', shop_face='right', faces=('front', 'right', 'back', 'left'), styles=('sash', 'shoji'), balcony=(2,), balcony_face='back', seed=5),
]


def clearance(spec, face):
    """Open space in front of a face before the nearest neighbouring building (inf when nothing faces it)."""
    (x0, x1), (y0, y1) = spec['x'], spec['y']
    gaps = [math.inf]
    for o in BUILDINGS:
        (ox0, ox1), (oy0, oy1) = o['x'], o['y']
        if o is spec:
            continue
        if face in ('front', 'back') and ox0 < x1 and ox1 > x0:
            gaps.append(y0 - oy1 if face == 'front' else oy0 - y1)
        elif face in ('left', 'right') and oy0 < y1 and oy1 > y0:
            gaps.append(x0 - ox1 if face == 'left' else ox0 - x1)
    return min(g for g in gaps if g >= 0)

_counters = defaultdict(int)


def _next(prefix):
    _counters[prefix] += 1
    return '%s_%d' % (prefix, _counters[prefix])


def reset():
    _counters.clear()


class Building:
    def __init__(self, spec, root):
        self.spec = spec
        self.w = spec['x'][1] - spec['x'][0]
        self.d = spec['y'][1] - spec['y'][0]
        self.h = FLOOR0 + FLOOR * (spec['floors'] - 1)
        self.parent = kit.empty(spec['name'], ((spec['x'][0] + spec['x'][1]) / 2, spec['y'][0], GROUND), root)
        self.atlas = bake.Atlas(spec['atlas'], spec.get('atlas_size', 2048), roughness=0.75)
        self.batches = defaultdict(list)
        self.flat = defaultdict(list)
        self.rng = random.Random(spec['seed'])

    # -- facade mapping
    def width(self, face):
        return self.w if face in ('front', 'back') else self.d

    def pt(self, face, u, n, v):
        w, d = self.w, self.d
        if face == 'front':
            return (u, -n, v)
        if face == 'back':
            return (-u, d + n, v)
        if face == 'left':
            return (-w / 2 - n, d / 2 - u, v)
        return (w / 2 + n, d / 2 + u, v)

    @staticmethod
    def size(face, su, sn, sv):
        return (su, sn, sv) if face in ('front', 'back') else (sn, su, sv)

    @staticmethod
    def yaw(face):
        return {'front': 0.0, 'right': math.pi / 2, 'back': math.pi, 'left': -math.pi / 2}[face]

    @staticmethod
    def tilt(face, a):
        return {'front': (a, 0, 0), 'back': (-a, 0, 0), 'left': (0, -a, 0), 'right': (0, a, 0)}[face]

    def box(self, kind, face, su, sn, sv, u, n, v, rot=None):
        spec = (self.size(face, su, sn, sv), self.pt(face, u, n, v))
        self.batches[kind].append(spec + ((rot,) if rot else ()))

    def flatbox(self, mat, face, su, sn, sv, u, n, v):
        self.flat[mat].append((self.size(face, su, sn, sv), self.pt(face, u, n, v)))

    def part(self, ob, *kinds):
        return self.atlas.add(ob, *kinds)

    def finish(self):
        for kind, specs in self.batches.items():
            self.atlas.add(kit.boxes('%s_%s' % (self.spec['name'], kind.replace(':', '_').replace('#', '')), specs, None, self.parent), kind)
        for mat, specs in self.flat.items():
            kit.boxes('%s_%s' % (self.spec['name'], mat.name[3:]), specs, mat, self.parent)


# ---------------------------------------------------------------- shared materials

def _mats():
    return dict(
        glass=kit.material('glass_dark', '#27353b', 0.06, metallic=0.4),
        lit=kit.material('glass_lit', '#ffe0a3', 0.3, emission='#ffcf8a', strength=1.6),
        shoji=kit.material('shoji_lit', '#fff3dc', 0.6, emission='#ffe9c4', strength=0.9),
        interior=kit.material('shop_interior', '#d9a86a', 0.7, emission='#ffc27a', strength=0.9),
        lantern_red=kit.material('lantern_red_lit', '#e0442f', 0.5, emission='#ff5a32', strength=2.2),
        lantern_white=kit.material('lantern_white_lit', '#fff1d6', 0.5, emission='#ffe3b0', strength=2.0),
        curtains=[kit.material('curtain_%d' % i, c, 0.9, double_sided=True) for i, c in enumerate(('#e9a6a6', '#9fc7e6', '#f2d27a', '#b8d8a8', '#f4f0e6'))],
        cloth=[kit.material('laundry_%d' % i, c, 0.9, double_sided=True) for i, c in enumerate(('#f6f3ea', '#e66f5c', '#5b8bd6', '#f2c94c', '#8ed1b7'))],
    )


# ---------------------------------------------------------------- facade elements

def window(b, m, face, u, v, w, h, style):
    """Window centred at (u, v) bottom edge at v; frame, glass, sill, hood and style-specific detail."""
    trim, t = b.spec['trim'], 0.04
    lit = b.rng.random() < 0.45
    cz = v + h / 2
    for su, sv, du, dv in ((w + 2 * t, t, 0, h / 2 + t / 2), (w + 2 * t, t, 0, -h / 2 - t / 2), (t, h, -w / 2 - t / 2, 0), (t, h, w / 2 + t / 2, 0)):
        b.box(trim, face, su, 0.06, sv, u + du, 0.02, cz + dv)
    b.box('concrete', face, w + 0.16, 0.11, 0.05, u, 0.05, v - t - 0.02)
    b.box(trim, face, w + 0.12, 0.08, 0.04, u, 0.035, v + h + t + 0.03)
    if style == 'shoji':
        b.flatbox(m['shoji'], face, w, 0.01, h, u, 0.004, cz)
        for k in range(1, 4):
            b.box('hinoki', face, 0.018, 0.02, h, u - w / 2 + w * k / 4, 0.012, cz)
        for k in range(1, 4):
            b.box('hinoki', face, w, 0.02, 0.018, u, 0.012, v + h * k / 4)
        return
    b.flatbox(m['lit'] if lit else m['glass'], face, w, 0.01, h, u, 0.004, cz)
    if style == 'lattice':
        n = max(4, int(w / 0.055))
        for k in range(n + 1):
            b.box('hinoki', face, 0.016, 0.025, h, u - w / 2 + w * k / n, 0.03, cz)
        for dv in (-h * 0.3, h * 0.3):
            b.box('hinoki', face, w, 0.025, 0.02, u, 0.035, cz + dv)
    elif style == 'shutter':
        b.box('metal_dark', face, w + 0.1, 0.1, 0.12, u, 0.06, v + h + 0.1)
        b.box('corrugated', face, w, 0.02, h * 0.55, u, 0.03, v + h - h * 0.275)
    elif style == 'louvre':
        for k in range(6):
            b.box(trim, face, w, 0.035, 0.018, u, 0.03, v + h * (k + 0.5) / 6, rot=Building.tilt(face, -0.5))
    else:  # sash
        b.box(trim, face, 0.03, 0.03, h, u, 0.02, cz)
        if lit:
            mat = b.rng.choice(m['curtains'])
            for side in (-1, 1):
                b.flatbox(mat, face, w * 0.22, 0.008, h * 0.92, u + side * w * 0.36, 0.007, cz)


def ac_unit(b, face, u, v, idx_holder):
    """Outdoor AC unit on a bracket with a spinning fan, side vents and a duct running down the wall."""
    p = b.pt(face, u, 0.15, v)
    unit = kit.box(kit_name(b, 'AC'), b.size(face, 0.44, 0.26, 0.32), p, None, b.parent, bevel=0.02)
    b.part(unit, 'paint:#e6e3da')
    for du in (-0.15, 0.15):
        b.box('metal_dark', face, 0.03, 0.3, 0.03, u + du, 0.14, v - 0.18)
    holder = kit.empty(kit_name(b, 'AC_Holder'), b.pt(face, u - 0.06, 0.285, v), b.parent)
    holder.rotation_euler = (0, 0, Building.yaw(face))
    fan = kit.empty(_next('AC_Fan'), (0, 0, 0), holder)
    fan.rotation_mode = 'ZXY'
    fan.rotation_euler = (math.radians(90), 0, 0)
    b.part(kit.boxes(fan.name + '_Blades', [((0.2, 0.035, 0.012), (0, 0, 0), (0, 0, math.radians(a))) for a in (0, 60, 120)], None, fan), 'metal_dark')
    b.part(kit.tube(fan.name + '_Grille', kit.ring((0, 0, 0), 0.11, 'Y', n=20), 0.008, None, holder, sides=4), 'metal_dark')
    b.part(kit.boxes(fan.name + '_Bars', [((0.22, 0.008, 0.008), (0, -0.01, 0)), ((0.008, 0.008, 0.22), (0, -0.01, 0))], None, holder), 'metal_dark')
    kit.spin(fan, 2, 5 + b.rng.randint(0, 4))
    for k in range(5):
        b.box('metal_dark', face, 0.012, 0.01, 0.2, u + 0.12 + k * 0.018, 0.285, v)
    b.box('paint:#d9d5c9', face, 0.06, 0.06, 0.06, u + 0.25, 0.04, v)  # refrigerant line into the wall


def kit_name(b, part):
    return _next('%s_%s' % (b.spec['name'], part))


def drainpipe(b, face, u, top):
    pts = [b.pt(face, u, 0.06, v) for v in (top + 0.05, top - 0.1)] + [b.pt(face, u, 0.05, 0.05)]
    b.part(kit.tube(kit_name(b, 'Pipe'), pts, 0.032, None, b.parent, sides=8), 'metal_dark')
    for v in [0.4 + 0.7 * k for k in range(int(top / 0.7))]:
        b.box('metal_dark', face, 0.09, 0.06, 0.03, u, 0.03, v)


def cables(b, face, v):
    w = b.width(face)
    a, c = b.pt(face, -w / 2 + 0.1, 0.03, v), b.pt(face, w / 2 - 0.1, 0.03, v - 0.05)
    for k in range(2):
        b.part(kit.tube(kit_name(b, 'Cable'), kit.sag((a[0], a[1], a[2] - 0.04 * k), (c[0], c[1], c[2] - 0.03 * k), 0.06 + 0.03 * k, n=12), 0.008, None, b.parent, sides=4), 'rubber')
    for u in (-w / 2 + 0.1, w / 2 - 0.1):
        b.box('metal_dark', face, 0.03, 0.04, 0.05, u, 0.02, v)


def balcony(b, m, face, v):
    w = b.width(face) * 0.78
    b.box('concrete', face, w, 0.45, 0.06, 0, 0.225, v)
    posts = int(w / 0.12)
    for k in range(posts + 1):
        b.box('metal_dark', face, 0.018, 0.018, 0.42, -w / 2 + w * k / posts, 0.44, v + 0.24)
    b.box('metal_dark', face, w, 0.035, 0.035, 0, 0.44, v + 0.45)
    b.box('metal_dark', face, w, 0.025, 0.025, 0, 0.44, v + 0.08)
    for side in (-1, 1):
        b.box('metal_dark', face, 0.018, 0.45, 0.42, side * w / 2, 0.225, v + 0.24)
    pole_a, pole_b = b.pt(face, -w / 2 + 0.05, 0.3, v + 0.72), b.pt(face, w / 2 - 0.05, 0.3, v + 0.72)
    b.part(kit.tube(kit_name(b, 'Laundry_Pole'), [pole_a, pole_b], 0.01, None, b.parent, sides=5), 'metal_light')
    for k in range(b.rng.randint(2, 4)):
        uu = -w / 2 + 0.15 + k * 0.2
        b.flatbox(b.rng.choice(m['cloth']), face, 0.16, 0.01, 0.24, uu, 0.3, v + 0.58)
    if b.rng.random() < 0.6:
        b.flatbox(b.rng.choice(m['cloth']), face, w * 0.4, 0.02, 0.3, w * 0.2, 0.46, v + 0.33)  # futon airing on the rail
    pos = b.pt(face, -w / 2 + 0.16, 0.3, v + 0.03)  # on the balcony slab
    b.part(kit.cylinder(kit_name(b, 'Balcony_Pot'), 0.06, 0.1, (pos[0], pos[1], pos[2] + 0.05), None, b.parent, segments=12, radius_top=0.075), 'terracotta')
    foliage.bush(b.atlas, kit_name(b, 'Balcony_Bush'), (pos[0], pos[1], pos[2] + 0.1 + 0.06), 0.1, b.parent, bloom=0.2, seed=b.rng.randint(0, 10 ** 6))


def blade_sign(b, face, u, v, sid, width=0.26):
    """Vertical sign projecting perpendicular from the wall, lettering on both sides."""
    pos = b.pt(face, u, 0.2 + width / 2, v)
    yaw = Building.yaw(face) + math.pi / 2
    ob, height = signs.panel(kit_name(b, 'Blade'), sid, width, pos, b.parent, rot=(0, 0, yaw), double=True)
    b.box('metal_dark', face, 0.03, width + 0.06, height + 0.06, u, 0.2 + width / 2, v)
    for dv in (-height * 0.35, height * 0.35):
        b.box('metal_dark', face, 0.02, 0.2, 0.02, u, 0.1, v + dv)
    return ob


def face_sign(b, face, u, v, sid, width, n=0.06):
    pos = b.pt(face, u, n, v)
    ob, height = signs.panel(kit_name(b, 'Sign'), sid, width, pos, b.parent, rot=(0, 0, Building.yaw(face)))
    b.box('metal_dark', face, width + 0.05, 0.04, height + 0.05, u, n - 0.025, v)
    return ob


def lantern(b, m, face, u, v, red=True):
    pos = b.pt(face, u, 0.18, v)
    kit.cylinder(kit_name(b, 'Lantern'), 0.075, 0.2, pos, m['lantern_red' if red else 'lantern_white'], b.parent, segments=14)
    for dz in (-0.105, 0.105):
        b.part(kit.cylinder(kit_name(b, 'Lantern_Cap'), 0.05, 0.02, (pos[0], pos[1], pos[2] + dz), None, b.parent, segments=10), 'paint:#1d1714')
    b.box('metal_dark', face, 0.015, 0.18, 0.015, u, 0.09, v + 0.16)


def awning(b, face, u, v, w, colors):
    depth, a = min(0.5, clearance(b.spec, face) - 0.06), 0.35  # shallower over a narrow alley
    slats = max(4, int(w / 0.1))
    for k in range(slats):
        uu = u - w / 2 + w * (k + 0.5) / slats
        b.box('paint:' + colors[k % 2], face, w / slats, depth, 0.02, uu, depth / 2 * math.cos(a), v - depth / 2 * math.sin(a), rot=Building.tilt(face, a))
    b.box('paint:' + colors[0], face, w, 0.02, 0.1, u, depth * math.cos(a), v - depth * math.sin(a) - 0.05)
    for side in (-1, 1):
        a3 = b.pt(face, u + side * w / 2, 0.0, v - 0.3)
        c3 = b.pt(face, u + side * w / 2, depth * math.cos(a) - 0.02, v - depth * math.sin(a))
        b.part(kit.tube(kit_name(b, 'Awning_Arm'), [a3, c3], 0.01, None, b.parent, sides=4), 'metal_dark')


def banner(b, face, u, colors_sid):
    """Nobori banner on a pole at the kerb in front of the face, swaying."""
    pos = b.pt(face, u, 0.4, 0)
    b.part(kit.cylinder(kit_name(b, 'Banner_Pole'), 0.012, 1.4, (pos[0], pos[1], pos[2] + 0.7), None, b.parent, segments=8), 'metal_dark')
    flag = kit.empty(_next('Banner'), (pos[0], pos[1], pos[2] + 1.36), b.parent)
    flag.rotation_euler = (0, 0, Building.yaw(b.face_for_banner) if hasattr(b, 'face_for_banner') else Building.yaw(face))
    signs.panel(flag.name + '_Cloth', colors_sid, 0.24, (0.13, 0, -0.42), flag, double=True)
    kit.swing(flag, 2, 10, 2, phase=b.rng.random())


# ---------------------------------------------------------------- shopfronts

def shopfront(b, m, face):
    kind = b.spec['shop']
    w = b.width(face)
    trim = b.spec['trim']
    b.box(trim, face, w, 0.08, 0.2, 0, 0.04, FLOOR0 - 0.1)  # fascia band
    if kind == 'cafe':
        b.flatbox(m['lit'], face, w * 0.5, 0.01, 0.62, -w * 0.17, 0.004, 0.52)
        for su, sv, du, dv in ((w * 0.5 + 0.08, 0.04, 0, 0.33), (w * 0.5 + 0.08, 0.06, 0, -0.33), (0.04, 0.62, -w * 0.25, 0), (0.04, 0.62, w * 0.25, 0), (0.03, 0.62, 0, 0)):
            b.box('wood_dark', face, su, 0.05, sv, -w * 0.17 + du, 0.02, 0.52 + dv)
        b.box('wood_dark', face, 0.38, 0.05, 0.86, w * 0.3, 0.02, 0.43)
        b.flatbox(m['lit'], face, 0.24, 0.01, 0.34, w * 0.3, 0.05, 0.6)
        face_sign(b, face, 0, FLOOR0 - 0.1, 'kissa', w * 0.72, n=0.09)
        awning(b, face, -w * 0.17, 0.92, w * 0.56, ('#2f5d8a', '#f2efe6'))
        for side in (-1, 1):
            pos = b.pt(face, side * (w / 2 - 0.12), 0.18, 0)
            foliage.topiary(b.atlas, kit_name(b, 'Door_Tree'), pos, 0.62, b.parent, bloom=0.3, seed=b.rng.randint(0, 10 ** 6))
        # A-frame menu board standing on the sidewalk, clear of the post box: lettered front, plain back, hinge, feet.
        lean = math.radians(12)
        ob, height = signs.panel(kit_name(b, 'Menu_Board'), 'menu', 0.2, b.pt(face, -w * 0.35, 0.42, 0.0), b.parent,
                                 rot=(-lean, 0, Building.yaw(face)))
        ob.location.z = height / 2 * math.cos(lean) + 0.005
        b.box('wood_dark', face, 0.22, 0.015, height + 0.02, -w * 0.35, 0.42 - 0.003, height / 2 * math.cos(lean) + 0.005, rot=Building.tilt(face, -lean))
        # front panel leans its top back toward the wall; the plain back panel mirrors it, meeting at the hinge
        b.box('wood_dark', face, 0.22, 0.015, height + 0.02, -w * 0.35, 0.42 - height * math.sin(lean), height / 2 * math.cos(lean) + 0.005, rot=Building.tilt(face, lean))
        b.box('metal_dark', face, 0.2, 0.03, 0.02, -w * 0.35, 0.42 - height * math.sin(lean) / 2, height * math.cos(lean))
        b.face_for_banner = face
        banner(b, face, -w * 0.47, 'coffee_v')
    elif kind == 'ramen':
        b.flatbox(m['interior'], face, w * 0.7, 0.01, 0.85, -w * 0.05, 0.002, 0.45)
        b.box('wood_dark', face, w * 0.7, 0.3, 0.06, -w * 0.05, 0.15, 0.48)   # counter
        for k in range(4):
            pos = b.pt(face, -w * 0.3 + k * 0.17, 0.33, 0)
            b.part(kit.cylinder(kit_name(b, 'Stool'), 0.06, 0.3, (pos[0], pos[1], pos[2] + 0.15), None, b.parent, segments=10), 'paint:#c8452f')
        noren, _ = signs.panel(kit_name(b, 'Noren'), 'noren_a', w * 0.6, b.pt(face, -w * 0.05, 0.05, 0.77), b.parent, rot=(0, 0, Building.yaw(face)), double=True)
        face_sign(b, face, 0, FLOOR0 - 0.1, 'ramen_h', w * 0.45, n=0.09)
        for side in (-1, 1):
            lantern(b, m, face, side * (w * 0.42), 0.82, red=True)
        b.face_for_banner = face
        banner(b, face, w * 0.45, 'ramen_v')
    elif kind == 'stall':
        b.box('wood_dark', face, w * 0.85, 0.35, 0.55, -w * 0.05, 0.2, 0.28)  # oden counter
        b.box('hinoki', face, w * 0.88, 0.4, 0.04, -w * 0.05, 0.22, 0.57)
        for k in range(3):
            pos = b.pt(face, -w * 0.3 + k * 0.28, 0.2, 0.62)
            b.part(kit.cylinder(kit_name(b, 'Pot'), 0.09, 0.08, pos, None, b.parent, segments=14), 'metal_light')
        for k in range(4):
            pos = b.pt(face, -w * 0.35 + k * 0.22, 0.62, 0)
            b.part(kit.cylinder(kit_name(b, 'Stool'), 0.06, 0.32, (pos[0], pos[1], pos[2] + 0.16), None, b.parent, segments=10), 'cedar')
        b.flatbox(m['interior'], face, w * 0.8, 0.01, 0.4, -w * 0.05, 0.002, 0.85)
        # Short noren hanging just under the canopy's front edge (top at 0.98, canopy underside ~0.99 there).
        signs.panel(kit_name(b, 'Noren'), 'noren_b', w * 0.5, b.pt(face, -w * 0.05, 0.45, 0.98 - w * 0.125), b.parent, rot=(0, 0, Building.yaw(face)), double=True)
        b.box('tile_grey', face, w * 0.95, 0.6, 0.04, -w * 0.05, 0.28, 1.06, rot=Building.tilt(face, 0.3))
        for k in range(3):
            lantern(b, m, face, -w * 0.4 + k * w * 0.35, 0.9, red=k != 1)
        # The izakaya board stands on the canopy's front lip (canopy top ~1.01 at n 0.5), clear of the windows behind.
        face_sign(b, face, -w * 0.05, 1.01 + w * 0.1, 'izakaya', w * 0.6, n=0.5)
        b.face_for_banner = face
        banner(b, face, -w * 0.5, 'sake_v')
        stall = kit.empty('Food_Stall', b.pt(face, 0, 0.3, 0), b.parent)
        stall.empty_display_size = 0.1
    elif kind == 'books':
        for row in range(3):
            v = 0.2 + row * 0.25
            b.box('cedar', face, w * 0.6, 0.25, 0.03, 0, 0.12, v)
            u = -w * 0.3 + 0.02
            while u < w * 0.3 - 0.04:
                bw = b.rng.uniform(0.025, 0.045)
                color = b.rng.choice(('#c8452f', '#2b6cb0', '#f2c94c', '#27ae60', '#ece7db', '#6d4c9b', '#e67e22'))
                b.box('paint:' + color, face, bw, 0.16, b.rng.uniform(0.13, 0.2), u + bw / 2, 0.1, v + 0.09)
                u += bw + 0.004
        b.flatbox(m['interior'], face, w * 0.62, 0.01, 0.85, 0, 0.002, 0.45)
        face_sign(b, face, 0, FLOOR0 - 0.1, 'books', w * 0.4, n=0.09)
        awning(b, face, 0, 0.94, w * 0.7, ('#2f6b4f', '#f2efe6'))
    elif kind == 'shutter':
        b.box('corrugated', face, w * 0.55, 0.03, 0.8, -w * 0.15, 0.02, 0.42)
        b.box('metal_dark', face, w * 0.6, 0.12, 0.14, -w * 0.15, 0.07, 0.88)
        b.flatbox(m['lit'], face, w * 0.25, 0.01, 0.6, w * 0.3, 0.004, 0.45)
        face_sign(b, face, w * 0.3, 0.9, 'tobacco', 0.18, n=0.06)
        face_sign(b, face, -w * 0.15, FLOOR0 - 0.1, 'open', 0.18, n=0.09)


# ---------------------------------------------------------------- roofs

def roof(b, m):
    w, d, h = b.w, b.d, b.h
    if b.spec['roof'] == 'gable':
        tile = b.spec['tile']
        rise, over = 0.6, 0.18
        # gable ends overhang less where a neighbour stands close (ridge ends included), so eaves never enter its wall
        ol, orr = (max(0.0, min(over, clearance(b.spec, s) - 0.14)) for s in ('left', 'right'))
        span, cx = w + ol + orr, (orr - ol) / 2
        b.part(kit.prism(kit_name(b, 'Roof'), span, d + 2 * over, rise, (cx, d / 2, h), None, b.parent), tile)
        slope = math.atan2(rise, d / 2 + over)
        length = math.hypot(rise, d / 2 + over)
        ribs = []
        for k in range(int(span / 0.11)):
            x = -w / 2 - ol + 0.06 + k * 0.11
            for side in (-1, 1):
                y = d / 2 + side * (d / 2 + over) / 2
                ribs.append(((0.045, length, 0.03), (x, y, h + rise / 2 + 0.015), (-side * slope, 0, 0)))
        b.part(kit.boxes(kit_name(b, 'Roof_Tiles'), ribs, None, b.parent), tile)
        b.part(kit.cylinder(kit_name(b, 'Ridge'), 0.07, span + 0.06, (cx, d / 2, h + rise + 0.02), None, b.parent, rot=(0, math.radians(90), 0), segments=10), tile)
        b.part(kit.boxes(kit_name(b, 'Ridge_Ends'), [((0.08, 0.18, 0.2), (x, d / 2, h + rise + 0.05)) for x in (-w / 2 - ol - 0.04, w / 2 + orr + 0.04)], None, b.parent), tile)
        b.box('wood_dark', 'front', span, 0.05, 0.06, cx, over, h - 0.03)
        b.box('metal_dark', 'front', span, 0.07, 0.05, cx, over + 0.03, h - 0.07)
        return
    # flat roof: parapet and clutter
    trim = b.spec['trim']
    for face in ('front', 'back'):
        b.box(trim, face, w, 0.08, 0.22, 0, -0.04, h + 0.11)
    for face in ('left', 'right'):
        b.box(trim, face, d, 0.08, 0.22, 0, -0.04, h + 0.11)
    b.box('concrete', 'front', w - 0.1, d - 0.1, 0.02, 0, -d / 2, h + 0.01)
    clutter = b.spec.get('clutter', ())
    if 'tank' in clutter:
        cx, cy = w * 0.25, d * 0.65
        b.part(kit.cylinder(kit_name(b, 'Water_Tank'), 0.28, 0.5, (cx, cy, h + 0.55), None, b.parent, segments=16), 'paint:#cfd3d2')
        b.part(kit.cylinder(kit_name(b, 'Water_Tank_Lid'), 0.29, 0.04, (cx, cy, h + 0.82), None, b.parent, segments=16, radius_top=0.1), 'paint:#b8bdbd')
        legs = [((0.04, 0.04, 0.3), (cx + dx, cy + dy, h + 0.15)) for dx in (-0.2, 0.2) for dy in (-0.2, 0.2)]
        b.part(kit.boxes(kit_name(b, 'Tank_Legs'), legs, None, b.parent), 'metal_dark')
        b.part(kit.tube(kit_name(b, 'Tank_Pipe'), [(cx, cy - 0.28, h + 0.35), (cx, cy - 0.5, h + 0.35), (cx, cy - 0.5, h + 0.05)], 0.025, None, b.parent, sides=6), 'metal_dark')
    if 'roof_ac' in clutter:
        for k in range(2):
            b.part(kit.box(kit_name(b, 'Roof_AC'), (0.44, 0.3, 0.34), (-w * 0.25 + k * 0.5, d * 0.3, h + 0.19), None, b.parent, bevel=0.02), 'paint:#e6e3da')
            b.part(kit.tube(kit_name(b, 'Roof_AC_Grille'), kit.ring((-w * 0.25 + k * 0.5 - 0.06, d * 0.3 - 0.16, h + 0.19), 0.1, 'Y', n=16), 0.008, None, b.parent, sides=4), 'metal_dark')
    if 'antenna' in clutter:
        base = (-w * 0.3, d * 0.75, h)
        b.part(kit.tube(kit_name(b, 'Antenna'), [base, (base[0], base[1], h + 1.0)], 0.015, None, b.parent, sides=5), 'metal_light')
        b.part(kit.boxes(kit_name(b, 'Antenna_Arms'), [((0.4 - 0.06 * k, 0.012, 0.012), (base[0], base[1], h + 0.6 + 0.1 * k)) for k in range(4)], None, b.parent), 'metal_light')
    if 'railing' in clutter:
        posts = [((0.02, 0.02, 0.45), (-w / 2 + 0.1 + k * (w - 0.2) / 10, 0.08, h + 0.45)) for k in range(11)]
        b.part(kit.boxes(kit_name(b, 'Roof_Railing'), posts + [((w - 0.2, 0.03, 0.03), (0, 0.08, h + 0.67))], None, b.parent), 'metal_dark')
    if 'garden' in clutter:
        for k in range(3):
            x = -w * 0.35 + k * 0.45
            b.part(kit.box(kit_name(b, 'Planter'), (0.36, 0.22, 0.18), (x, d * 0.82, h + 0.11), None, b.parent, bevel=0.01), 'cedar')
            foliage.hedge(b.atlas, kit_name(b, 'Roof_Hedge'), (x, d * 0.82, h + 0.2 + 0.08), (0.34, 0.2, 0.16), b.parent, bloom=0.15, seed=b.rng.randint(0, 10 ** 6))
    if 'shed' in clutter:
        b.part(kit.box(kit_name(b, 'Shed'), (0.7, 0.55, 0.55), (w * 0.28, d * 0.7, h + 0.3), None, b.parent), 'corrugated')
        b.box('wood_dark', 'front', 0.24, 0.02, 0.4, w * 0.28, -d * 0.7 + 0.28, h + 0.24)
    if 'billboard' in clutter:
        ob, height = signs.panel(kit_name(b, 'Billboard'), 'billboard', w * 0.75, (0, 0.25, h + 1.05), b.parent)
        b.box('metal_dark', 'front', w * 0.75 + 0.08, 0.06, height + 0.08, 0, -0.29, h + 1.05)
        for side in (-1, 1):
            b.part(kit.tube(kit_name(b, 'Billboard_Leg'), [(side * w * 0.3, 0.32, h), (side * w * 0.3, 0.32, h + 1.05)], 0.025, None, b.parent, sides=6), 'metal_dark')
            b.part(kit.tube(kit_name(b, 'Billboard_Brace'), [(side * w * 0.3, 0.32, h + 0.6), (side * w * 0.3, 0.75, h)], 0.018, None, b.parent, sides=5), 'metal_dark')
        for k in range(3):
            pos = (-w * 0.25 + k * w * 0.25, 0.1, h + 1.05 + height / 2 + 0.06)
            kit.box(kit_name(b, 'Billboard_Lamp'), (0.1, 0.12, 0.03), pos, m['lantern_white'], b.parent)


# ---------------------------------------------------------------- building

def build_one(spec, root, m):
    b = Building(spec, root)
    w, d, h = b.w, b.d, b.h
    b.part(kit.box(spec['name'] + '_Ground', (w, d, FLOOR0), (0, d / 2, FLOOR0 / 2), None, b.parent), spec['base'])
    b.part(kit.box(spec['name'] + '_Upper', (w, d, h - FLOOR0), (0, d / 2, FLOOR0 + (h - FLOOR0) / 2), None, b.parent), spec['wall'])
    for f in range(1, spec['floors']):
        for face in spec['faces']:
            b.box(spec['trim'], face, b.width(face) + 0.04, 0.04, 0.05, 0, 0.0, FLOOR0 + FLOOR * (f - 1) - 0.02)
    for face in spec['faces']:
        fw = b.width(face)
        for side in (-1, 1):
            b.box(spec['trim'], face, 0.06, 0.06, h, side * (fw / 2 - 0.03), 0.01, h / 2)
    shop_face = spec.get('shop_face', 'front')
    shopfront(b, m, shop_face)
    styles = spec['styles']
    blade_left = spec['shop'] == 'ramen'  # the ramen blade sign hangs at the front's left end
    balcony_face = spec.get('balcony_face', 'front')
    for face in spec['faces']:
        fw = b.width(face)
        open_face = clearance(spec, face) >= 0.3  # a wall a hand's width from its neighbour is blank but for pipes
        for f in range(1, spec['floors'] if open_face else 1):
            base_v = FLOOR0 + FLOOR * (f - 1)
            style = styles[(f - 1) % len(styles)]
            if face != 'front' and style == 'louvre':
                style = 'sash'
            # Reserve one end of the floor for the AC unit, then lay the windows out in the rest: units hang beside
            # windows (never over them), above the shop signs and clear of the drainpipe at the right edge.
            side, standing = 0, False
            if fw >= 1.4 and b.rng.random() < 0.6:
                side = 1 if (face == 'front' and blade_left) else b.rng.choice((-1, 1))
                # On a balcony floor the unit stands on the slab's right end, clear of the pot and laundry on the left.
                standing = face == balcony_face and f in spec['balcony']
                side = 1 if standing else side
                # no unit in a tight gap between buildings or perched over the shop canopy
                if clearance(spec, face) < 0.5 or (face == shop_face and f == 1):
                    side = 0
            reserve = max(0.74, fw * 0.11 + 0.45) if standing else 0.74
            lo, hi = -fw / 2 + (reserve if side == -1 else 0.0), fw / 2 - (reserve if side == 1 else 0.0)
            n = max(1, int((hi - lo - 0.1) / 0.62))
            for k in range(n):
                window(b, m, face, lo + (hi - lo) * (k + 0.5) / n, base_v + 0.22, min(0.5, (hi - lo) / n - 0.16), 0.46, style)
            if side and standing:  # bracket bars rest on the slab top (base_v + 0.03), unit inside the railing
                ac_unit(b, face, fw * 0.39 - 0.27, base_v + 0.225, f)
            elif side:
                ac_unit(b, face, side * (fw / 2 - 0.42), base_v + 0.3, f)
        if face != shop_face and face != 'front' and open_face:
            # side ground floor: a small window, a meter box and a proper door (frame, glazed panel, handle, step)
            window(b, m, face, -fw * 0.25, 0.45, 0.4, 0.4, 'lattice' if b.rng.random() < 0.5 else 'sash')
            b.box('paint:#d8d4c8', face, 0.22, 0.08, 0.3, fw * 0.25, 0.04, 0.75)
            if clearance(spec, face) >= 0.5:  # nobody puts a door onto a gap you cannot walk down
                door_u = fw * 0.05
                for su, sv, du, dv in ((0.58, 0.05, 0, 0.885), (0.05, 0.9, -0.265, 0.43), (0.05, 0.9, 0.265, 0.43)):
                    b.box(spec['trim'], face, su, 0.06, sv, door_u + du, 0.02, dv)
                b.box('wood_dark', face, 0.48, 0.04, 0.84, door_u, 0.015, 0.42)
                b.flatbox(m['lit'], face, 0.26, 0.01, 0.22, door_u, 0.04, 0.64)
                b.box('metal_light', face, 0.03, 0.04, 0.08, door_u + 0.17, 0.05, 0.42)
                b.box('concrete', face, 0.62, 0.16, 0.04, door_u, 0.08, 0.02)
        drainpipe(b, face, fw / 2 - 0.12, h)
        if spec['floors'] > 2:
            cables(b, face, FLOOR0 + 0.05)
    for f in spec['balcony']:
        balcony(b, m, balcony_face, FLOOR0 + FLOOR * (f - 1))
    if spec['shop'] == 'ramen':
        blade_sign(b, 'front', -b.w / 2 + 0.25, FLOOR0 + FLOOR * 1.4, 'pharmacy_v' if spec['seed'] == 4 else 'ramen_v')
    roof(b, m)
    return b  # finished by build() after cross-building signs are added


def build(root):
    reset()
    m = _mats()
    out = [build_one(spec, root, m) for spec in BUILDINGS]
    b4 = out[3]
    blade_sign(b4, 'left', 0.4, FLOOR0 + FLOOR * 2.2, 'pharmacy_v')
    face_sign(out[0], 'left', 0.1, FLOOR0 - 0.03, 'coffee', 0.26, n=0.08)   # over the side door
    face_sign(out[4], 'back', 1.0, 0.95, 'number', 0.2)                  # beside the meter box
    face_sign(out[2], 'right', -0.4, FLOOR0, 'bath', 0.4)                 # below the first-floor sills
    for b in out:
        b.finish()
    return out
