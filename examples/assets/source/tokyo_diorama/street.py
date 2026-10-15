"""Slab, street, sidewalk, tram track and the tram that rolls along it."""
import math

from mathutils import Vector

import kit

RAIL_GAUGE = 0.28


def _line(a, b, step):
    a, b = Vector(a), Vector(b)
    n = max(1, int((b - a).length / step))
    return [a.lerp(b, i / n) for i in range(n)]


def path_points(step=0.1):
    """Front straight (y=-2.55), quarter arc around the front-left corner, left straight (x=-3.3)."""
    pts = _line((3.0, -2.55, 0), (-1.9, -2.55, 0), step)
    cx, cy, r = -1.9, -1.15, 1.4
    n = int(r * math.pi / 2 / step)
    pts += [Vector((cx + r * math.cos(math.radians(270 - 90 * i / n)), cy + r * math.sin(math.radians(270 - 90 * i / n)), 0)) for i in range(n)]
    pts += _line((-3.3, -1.15, 0), (-3.3, 1.9, 0), step) + [Vector((-3.3, 1.9, 0))]
    return pts


def path_sampler():
    pts = path_points()
    lengths = [0.0]
    for a, b in zip(pts, pts[1:]):
        lengths.append(lengths[-1] + (b - a).length)

    def at(s):
        s = min(max(s, 0.0), lengths[-1])
        i = next(j for j in range(len(lengths) - 1) if lengths[j + 1] >= s)
        a, b = pts[i], pts[i + 1]
        t = (s - lengths[i]) / max((b - a).length, 1e-9)
        d = (b - a).normalized()
        return a.lerp(b, t), math.atan2(d.y, d.x)

    return at, lengths[-1]


def _tram(root):
    green, cream = kit.material('tram_green', '#3f7a5e', 0.55), kit.material('tram_cream', '#efe3c4', 0.6)
    dark, glass = kit.material('tram_dark', '#26282c', 0.8), kit.material('tram_glass', '#9cc3cf', 0.15, emission='#fff1c9', strength=0.6)
    lamp = kit.material('tram_lamp', '#fff6d8', 0.3, emission='#fff1c2', strength=4.0)
    tram = kit.empty('Tram', (0, 0, 0.04), root)
    kit.box('Tram_Lower', (2.0, 0.8, 0.38), (0, 0, 0.36), green, tram, bevel=0.03)
    kit.box('Tram_Upper', (2.0, 0.8, 0.42), (0, 0, 0.76), cream, tram, bevel=0.03)
    kit.box('Tram_Roof', (1.9, 0.72, 0.1), (0, 0, 1.02), green, tram, bevel=0.04)
    kit.boxes('Tram_Windows', [((0.34, 0.82, 0.26), (x, 0, 0.78)) for x in (-0.66, -0.22, 0.22, 0.66)] + [((0.04, 0.6, 0.26), (sx * 1.0, 0, 0.78)) for sx in (-1, 1)], glass, tram)
    kit.boxes('Tram_Wheels', [((0.3, 0.06, 0.3), (x, y, 0.15)) for x in (-0.65, 0.65) for y in (-0.36, 0.36)], dark, tram)
    kit.boxes('Tram_Lamps', [((0.04, 0.12, 0.08), (sx * 1.01, 0, 0.45)) for sx in (-1, 1)], lamp, tram)
    kit.tube('Tram_Pantograph', [(0.2, 0, 1.07), (0, 0, 1.35), (-0.2, 0, 1.07)], 0.015, dark, tram)
    return tram


def build(root):
    kit.rounded_slab('Slab', 8.0, 6.0, 1.2, 0.5, (0, 0, 0), kit.material('slab', '#6b4f3a', 0.85), root)
    kit.rounded_slab('Street', 7.8, 5.8, 1.1, 0.04, (0, 0, 0.04), kit.material('asphalt', '#4a4b52', 0.9), root)
    kit.box('Sidewalk', (6.5, 4.75, 0.1), (0.55, 0.475, 0.09), kit.material('pavers', '#b9ad9b', 0.85), root)

    rail, sleeper = kit.material('rail', '#8e9196', 0.35, metallic=0.9), kit.material('sleeper', '#5a4636', 0.9)
    at, length = path_sampler()
    left, right, sleepers = [], [], []
    s = 0.0
    while s <= length:
        p, h = at(s)
        n = Vector((-math.sin(h), math.cos(h), 0))
        left.append(p + n * RAIL_GAUGE + Vector((0, 0, 0.07)))
        right.append(p - n * RAIL_GAUGE + Vector((0, 0, 0.07)))
        if round(s / 0.1) % 3 == 0:
            sleepers.append(((0.12, 0.8, 0.03), p + Vector((0, 0, 0.05)), (0, 0, h)))
        s += 0.1
    rails = kit.tube('Track_Rails', left, 0.02, rail, root)
    kit.tube('Track_Rail_R', right, 0.02, rail, rails)
    kit.boxes('Track_Sleepers', sleepers, sleeper, root)

    tram = _tram(root)
    for frame in range(kit.FRAME_START, kit.FRAME_END + 1, 6):
        t = (frame - kit.FRAME_START) / (kit.FRAME_END - kit.FRAME_START)
        p, h = at(length * (1 - math.cos(math.tau * t)) / 2)  # out and back, easing at both ends
        kit.key(tram, frame, location=(p.x, p.y, 0.04), rotation_euler=(0, 0, h))
