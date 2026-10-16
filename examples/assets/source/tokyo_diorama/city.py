"""Ground: slab, road, kerbed sidewalk, crosswalk and road lettering, manholes, the tram track loop and the tram's route."""
import math

from mathutils import Vector

import bake
import kit
import makersmark
import tram as hero_tram

SLAB_W, SLAB_D = 10.0, 8.0
BLOCK = (-3.3, 4.2, -2.2, 3.4)       # sidewalk block x0, x1, y0, y1
GROUND = 0.16                         # sidewalk top; buildings stand here
ROAD_TOP = 0.04                       # asphalt top: rails, paint, manholes and road cones sit here
RAIL_GAUGE = 0.3


def _line(a, b, step):
    a, b = Vector(a), Vector(b)
    n = max(1, int((b - a).length / step))
    return [a.lerp(b, i / n) for i in range(n)]


def path_points(step=0.1):
    """Front straight (y=-3.1), quarter arc round the front-left corner, left straight (x=-4.2)."""
    pts = _line((3.8, -3.1, 0), (-3.15, -3.1, 0), step)
    cx, cy, r = -3.15, -2.05, 1.05
    n = int(r * math.pi / 2 / step)
    pts += [Vector((cx + r * math.cos(math.radians(270 - 90 * i / n)), cy + r * math.sin(math.radians(270 - 90 * i / n)), 0)) for i in range(n)]
    pts += _line((-4.2, -2.05, 0), (-4.2, 2.8, 0), step) + [Vector((-4.2, 2.8, 0))]
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


def build(root):
    atlas = bake.Atlas('Ground_Atlas', 2048, roughness=0.8)
    x0, x1, y0, y1 = BLOCK
    atlas.add(kit.rounded_slab('Slab', SLAB_W, SLAB_D, 1.0, 0.55, (0, 0, 0), None, root), 'wood_dark')
    atlas.add(kit.rounded_slab('Slab_Base', SLAB_W + 0.16, SLAB_D + 0.16, 1.08, 0.12, (0, 0, -0.5), None, root), 'paint:#2b2420')
    makersmark.build(root)
    atlas.add(kit.rounded_slab('Road', SLAB_W - 0.2, SLAB_D - 0.2, 0.92, 0.04, (0, 0, 0.04), None, root), 'asphalt')
    atlas.add(kit.box('Sidewalk', (x1 - x0, y1 - y0, 0.12), ((x0 + x1) / 2, (y0 + y1) / 2, GROUND - 0.06), None, root), 'paving')
    curb = [((x1 - x0 + 0.1, 0.1, 0.13), ((x0 + x1) / 2, y0, GROUND - 0.06)), ((0.1, y1 - y0, 0.13), (x0, (y0 + y1) / 2, GROUND - 0.06)),
            ((0.1, y1 - y0, 0.13), (x1, (y0 + y1) / 2, GROUND - 0.06))]
    atlas.add(kit.boxes('Curbs', curb, None, root), 'concrete')

    # Road paint: crosswalk on the right-hand street, stop line, painted lettering, lane edge dashes.
    lane = x1 + 0.37  # centre of the side street (kerb at x1, road edge at 4.85)
    stripes = [((0.12, 0.7, 0.004), (lane - 0.2 + 0.2 * k, -1.2, ROAD_TOP + 0.002)) for k in range(3)]
    atlas.add(kit.boxes('Crosswalk', stripes, None, root), 'paint:#efece4')
    atlas.add(kit.box('Stop_Line', (0.54, 0.08, 0.004), (lane, -0.55, ROAD_TOP + 0.002), None, root), 'paint:#efece4')
    # Stacked along the lane like Japanese road paint, upright for drivers heading -Y toward the stop line.
    atlas.add(kit.text_mesh('Road_Text', '止\nま\nれ', 1.5, (lane, 0.35, ROAD_TOP + 0.0015), None, root, rot=(0, 0, math.radians(180)), width=0.34, space_line=0.82), 'paint:#efece4')
    dashes = [((0.3, 0.05, 0.004), (x, -2.42, ROAD_TOP + 0.002)) for x in [-2.6 + 0.6 * k for k in range(11)]]
    atlas.add(kit.boxes('Lane_Dashes', dashes, None, root), 'paint:#e9c84a')
    manholes = [(-3.55, 0.6), (lane, 1.6)]  # between the kerb and the track, never under the sleepers
    for i, (mx, my) in enumerate(manholes, start=1):
        atlas.add(kit.cylinder('Manhole_%d' % i, 0.18, 0.006, (mx, my, ROAD_TOP + 0.003), None, root, segments=24), 'metal_dark')
        atlas.add(kit.boxes('Manhole_%d_Ribs' % i, [((0.26, 0.018, 0.003), (mx, my + dy, ROAD_TOP + 0.0075)) for dy in (-0.08, -0.04, 0, 0.04, 0.08)], None, root), 'metal_dark')

    # Track: rails, sleepers, and the tram that runs on them.
    at, length = path_sampler()
    overrun = 0.9  # rails continue past the route ends so the tram's end bogies never leave them

    def along(s):
        if 0.0 <= s <= length:
            return at(s)
        p, h = at(min(max(s, 0.0), length))
        extra = s if s < 0 else s - length
        return p + Vector((math.cos(h), math.sin(h), 0)) * extra, h

    left, right, sleepers = [], [], []
    s = -overrun
    while s <= length + overrun:
        p, h = along(s)
        n = Vector((-math.sin(h), math.cos(h), 0))
        left.append(p + n * RAIL_GAUGE + Vector((0, 0, ROAD_TOP + 0.035 + 0.022)))   # rail tube resting on the sleepers
        right.append(p - n * RAIL_GAUGE + Vector((0, 0, ROAD_TOP + 0.035 + 0.022)))
        if round(s / 0.1) % 3 == 0:
            sleepers.append(((0.12, 0.86, 0.035), p + Vector((0, 0, ROAD_TOP + 0.0175)), (0, 0, h)))
        s += 0.1
    atlas.add(kit.tube('Track_Rails', left, 0.022, None, root), 'metal_light')
    atlas.add(kit.tube('Track_Rail_R', right, 0.022, None, root), 'metal_light')
    atlas.add(kit.boxes('Track_Sleepers', sleepers, None, root), 'wood_dark')
    stops = []
    for s in (-overrun, length + overrun):
        p, h = along(s)
        stops.append(((0.16, 0.8, 0.22), p + Vector((0, 0, ROAD_TOP + 0.11)), (0, 0, h)))
    atlas.add(kit.boxes('Track_Buffer_Stops', stops, None, root), 'paint:#c8452f')

    tram = hero_tram.build(root)
    previous = None
    for frame in range(kit.FRAME_START, kit.FRAME_END + 1, 6):
        t = (frame - kit.FRAME_START) / (kit.FRAME_END - kit.FRAME_START)
        p, h = at(length * (1 - math.cos(math.tau * t)) / 2)  # out and back, easing at both ends
        if previous is not None:
            h = previous + math.remainder(h - previous, math.tau)  # never key across the +/-pi branch cut
        previous = h
        kit.key(tram, frame, location=(p.x, p.y, 0.09), rotation_euler=(0, 0, h))
