# The lighthouse: stone tower, corbelled cornice, iron gallery, lantern
# room with helical astragals, copper dome, Fresnel lens and lamp core.
# Heights below are metres above the tower's ground level.

import math

import bmesh
import bpy
from mathutils import Matrix, Vector

from sl_common import Builder, E, apply_modifiers, log, new_object, select_only, smooth_by_angle
from sl_materials import LH_ZONES as Z
from sl_terrain import LIGHTHOUSE

G = LIGHTHOUSE[1]  # ground height of the tower
BODY0, BODY1 = 0.95, 16.6  # masonry body from the plinth to the cornice
BAND = (12.4, 14.2)  # dark red band
DECK = 17.5  # underside of the gallery deck
DECK_T = 0.25
FLOOR = DECK + DECK_T  # lantern floor and gallery walk
GLAZE0, GLAZE1 = FLOOR + 1.03, FLOOR + 3.5
FOCUS = 0.5 * (GLAZE0 + GLAZE1)  # lens centre, above ground
DOOR_AZ = math.degrees(math.atan2(9.0, -17.0))  # engine azimuth toward the cottage door
WINDOWS = [(4.3, 215.0), (7.9, 42.0), (11.2, 300.0), (15.2, 118.0), (9.6, 165.0)]


def tower_r(h):
    if h <= BODY0:
        return 3.4
    t = min(1.0, (h - BODY0) / (BODY1 - BODY0))
    return 2.5 + 0.9 * (1.0 - t) ** 1.3


def radial(az_deg, r, h):
    """Local frame on the tower: +x outward at engine azimuth az, z up."""
    return (Matrix.Translation((0, 0, G + h)) @ Matrix.Rotation(-math.radians(az_deg), 4, "Z") @
            Matrix.Translation((r, 0, 0)))


def _body_profile():
    prof = [(3.95, -0.6), (3.95, 0.12), (3.86, 0.18), (3.76, 0.22), (3.76, 0.78), (3.64, 0.86), (3.56, 0.92),
            (3.4, BODY0)]
    zones = [Z["granite"]] * (len(prof) - 1)
    hs = [BODY0]
    h = BODY0
    while h < BODY1 - 0.01:
        h = min(BODY1, h + 0.45)
        hs.append(h)
    hs = sorted(set([round(x, 3) for x in hs] + [BAND[0], BAND[1]]))
    for a, b in zip(hs[:-1], hs[1:]):
        prof.append((tower_r(b), b))
        zones.append(Z["red"] if BAND[0] <= a and b <= BAND[1] + 1e-6 else Z["wash"])
    # string course and cornice ring the corbels hang from
    r = tower_r(BODY1)
    for p in [(r + 0.1, BODY1 + 0.02), (r + 0.1, BODY1 + 0.22), (r + 0.18, BODY1 + 0.26), (r + 0.18, DECK)]:
        prof.append(p)
        zones.append(Z["wash"])
    return prof, zones


def build_tower():
    b = Builder()
    prof, zones = _body_profile()
    b.lathe(prof, 64, Matrix.Translation((0, 0, G)), zone=Z["granite"], cap_bottom=True, cap_top=True, zones=zones)
    tower = b.to_object("Lighthouse", smooth_angle=40)
    tower.data.materials.append(bpy.data.materials.get("LH_tmp") or bpy.data.materials.new("LH_tmp"))
    # openings: door and windows cut with exact booleans
    cut = Builder()
    w, hgt = 1.05, 2.25
    cut.box((1.8, w, hgt), radial(DOOR_AZ, 3.0 + 0.9, 0.22 + hgt / 2), zone=Z["granite"])
    for (h, az) in WINDOWS:
        r = tower_r(h)
        cut.box((1.6, 0.56, 0.92), radial(az, r - 0.32 + 0.8, h), zone=Z["wash"])
    cutter = cut.to_object("cutter")
    mod = tower.modifiers.new("cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    apply_modifiers(tower)
    bpy.data.objects.remove(cutter)
    # details joined into the tower
    d = Builder()
    _door(d)
    for (h, az) in WINDOWS:
        _window(d, h, az)
    _corbels(d)
    det = d.to_object("tower_detail", smooth_angle=35)
    select_only([tower, det])
    bpy.context.view_layer.objects.active = tower
    bpy.ops.object.join()
    smooth_by_angle(tower.data, 40)
    tower.data.materials.clear()
    return tower


def _door(d):
    az = DOOR_AZ
    w, hgt = 1.05, 2.25
    r0 = 3.4
    # door leaf of boards in the recess
    for i in range(4):
        y = -w / 2 + w * (i + 0.5) / 4
        d.box((0.06, w / 4 - 0.012, hgt - 0.02), radial(az, 3.0 + 0.02, 0.22 + hgt / 2) @ Matrix.Translation(
            (0, y, 0)), zone=Z["door"], bevel=0.008)
    for zz in (0.55, 1.75):
        d.box((0.05, w - 0.06, 0.16), radial(az, 3.06, zz), zone=Z["door"], bevel=0.01)
    d.uvsphere(0.04, 10, 6, radial(az, 3.12, 1.2) @ Matrix.Translation((0, w * 0.32, 0)), zone=Z["brass"])
    # granite surround: jambs, lintel, cornice
    for s in (-1, 1):
        d.box((0.42, 0.26, hgt + 0.1), radial(az, r0 + 0.05, 0.22 + (hgt + 0.1) / 2) @ Matrix.Translation(
            (0, s * (w / 2 + 0.12), 0)), zone=Z["granite"], bevel=0.02)
    d.box((0.44, w + 0.62, 0.38), radial(az, r0 + 0.06, 0.22 + hgt + 0.2), zone=Z["granite"], bevel=0.02)
    d.box((0.56, w + 0.82, 0.1), radial(az, r0 + 0.08, 0.22 + hgt + 0.44), zone=Z["granite"], bevel=0.02)
    # steps
    d.box((0.5, w + 0.5, 0.2), radial(az, r0 + 0.55, 0.1), zone=Z["granite"], bevel=0.02)
    d.box((0.45, w + 0.9, 0.2), radial(az, r0 + 0.95, -0.08), zone=Z["granite"], bevel=0.02)


def _window(d, h, az):
    r = tower_r(h)
    back = r - 0.3
    d.box((0.03, 0.54, 0.9), radial(az, back, h), zone=Z["glass"])
    # frame and glazing bars
    for s in (-1, 1):
        d.box((0.06, 0.05, 0.9), radial(az, back + 0.03, h) @ Matrix.Translation((0, s * 0.245, 0)), zone=Z["black"])
        d.box((0.06, 0.54, 0.05), radial(az, back + 0.03, h + s * 0.43), zone=Z["black"])
    d.box((0.05, 0.025, 0.85), radial(az, back + 0.03, h), zone=Z["black"])
    d.box((0.05, 0.5, 0.025), radial(az, back + 0.03, h), zone=Z["black"])
    # sill and lintel
    d.box((0.52, 0.76, 0.1), radial(az, r - 0.08, h - 0.5), zone=Z["granite"], bevel=0.015)
    d.box((0.36, 0.78, 0.16), radial(az, r - 0.12, h + 0.54), zone=Z["granite"], bevel=0.015)


def _corbels(d, n=28):
    r = tower_r(BODY1) + 0.1
    for i in range(n):
        az = 360.0 * (i + 0.5) / n
        d.box((0.3, 0.26, 0.2), radial(az, r + 0.12, DECK - 0.5), zone=Z["wash"], bevel=0.03)
        d.box((0.5, 0.26, 0.18), radial(az, r + 0.22, DECK - 0.31), zone=Z["wash"], bevel=0.03)
        d.box((0.72, 0.28, 0.14), radial(az, r + 0.33, DECK - 0.07), zone=Z["wash"], bevel=0.025)


def build_gallery():
    b = Builder()
    rr = 3.48
    prof = [(1.7, FLOOR), (1.7, DECK), (rr - 0.12, DECK), (rr, DECK + 0.06), (rr, DECK + 0.19), (rr - 0.07, FLOOR),
            (1.7, FLOOR)]
    b.lathe(prof, 96, Matrix.Translation((0, 0, G)), zone=Z["granite"])
    # railing
    rs = rr - 0.16
    top = FLOOR + 1.08
    n = 36
    for i in range(n):
        a = 2 * math.pi * i / n
        p = Vector((rs * math.cos(a), rs * math.sin(a), G + FLOOR))
        b.cyl(0.026, 0.022, top - FLOOR, 6, Matrix.Translation(p + Vector((0, 0, (top - FLOOR) / 2))), zone=Z["iron"])
        b.box((0.09, 0.09, 0.05), Matrix.Translation(p + Vector((0, 0, 0.025))) @ Matrix.Rotation(a, 4, "Z"),
              zone=Z["iron"])
        if i % 3 == 0:
            b.uvsphere(0.045, 10, 6, Matrix.Translation(p + Vector((0, 0, top - FLOOR + 0.04))), zone=Z["iron"])
    for hh, rad in ((top, 0.032), (FLOOR + 0.72, 0.016), (FLOOR + 0.36, 0.016)):
        ring = [(rs * math.cos(2 * math.pi * k / 96), rs * math.sin(2 * math.pi * k / 96), G + hh)
                for k in range(97)]
        b.tube(ring, rad, 6, zone=Z["iron"], cap=False)
    return b.to_object("Gallery", smooth_angle=50)


def _helix(r, h0, h1, a0, turn, n=14):
    return [(r * math.cos(a0 + turn * t / n), r * math.sin(a0 + turn * t / n), h0 + (h1 - h0) * t / n)
            for t in range(n + 1)]


def build_lantern():
    b = Builder()
    rb = 1.92
    # cast iron base wall with a small cornice
    prof = [(rb, FLOOR), (rb, GLAZE0 - 0.12), (rb + 0.08, GLAZE0 - 0.08), (rb + 0.08, GLAZE0 - 0.02),
            (rb - 0.02, GLAZE0)]
    b.lathe(prof, 64, Matrix.Translation((0, 0, G)), zone=Z["iron"], cap_top=True)
    # plinth ring and panel ribs on the base wall
    for i in range(16):
        a = 2 * math.pi * i / 16
        b.box((0.05, 0.06, GLAZE0 - FLOOR - 0.14),
              Matrix.Translation((0, 0, G + FLOOR + (GLAZE0 - FLOOR - 0.14) / 2)) @ Matrix.Rotation(a, 4, "Z") @
              Matrix.Translation((rb + 0.02, 0, 0)), zone=Z["iron"])
    # service door in the base wall facing the sea
    b.box((0.08, 0.62, 0.78), radial(55.0, rb + 0.02, FLOOR + 0.45), zone=Z["black"], bevel=0.01)
    # floor and lens pedestal
    b.cyl(rb - 0.02, rb - 0.02, 0.04, 48, Matrix.Translation((0, 0, G + FLOOR + 0.02)), zone=Z["floor"])
    ped = [(0.44, FLOOR + 0.02), (0.44, FLOOR + 0.12), (0.3, FLOOR + 0.18), (0.22, FLOOR + 0.3),
           (0.19, FOCUS - 1.25), (0.3, FOCUS - 1.15), (0.42, FOCUS - 1.02), (0.42, FOCUS - 0.97)]
    b.lathe(ped, 32, Matrix.Translation((0, 0, G)), zone=Z["brass"], cap_top=True)
    # astragals: two sets of helical bars make diamond panes, plus sill and head rings
    rg = 1.885
    nb = 12
    turn = 2 * math.pi / nb * 2.0
    for i in range(nb):
        a0 = 2 * math.pi * i / nb
        for s in (1, -1):
            pts = _helix(rg, G + GLAZE0, G + GLAZE1, a0, s * turn, n=10)
            b.tube(pts, 0.028, 5, zone=Z["iron"], cap=False)
    for hh, rad in ((GLAZE0 + 0.02, 0.05), (GLAZE1 - 0.02, 0.06)):
        ring = [(rg * math.cos(2 * math.pi * k / 96), rg * math.sin(2 * math.pi * k / 96), G + hh) for k in range(97)]
        b.tube(ring, rad, 8, zone=Z["iron"], cap=False)
    # copper dome with ribs
    dome = [(rg - 0.02, GLAZE1), (2.16, GLAZE1 + 0.06), (2.19, GLAZE1 + 0.15), (2.04, GLAZE1 + 0.21),
            (1.7, GLAZE1 + 0.55), (1.25, GLAZE1 + 0.92), (0.78, GLAZE1 + 1.2), (0.4, GLAZE1 + 1.36),
            (0.24, GLAZE1 + 1.42), (0.22, GLAZE1 + 1.5)]
    b.lathe(dome, 64, Matrix.Translation((0, 0, G)), zone=Z["copper"], cap_bottom=True, cap_top=True)
    for i in range(16):
        a = 2 * math.pi * i / 16
        pts = []
        for (r, h) in dome[3:9]:
            pts.append(((r + 0.035) * math.cos(a), (r + 0.035) * math.sin(a), G + h + 0.02))
        b.tube(pts, 0.03, 6, zone=Z["copper"])
    # iron ladder up the dome for the keeper
    la = -math.radians(40.0)
    rails = {-1: [], 1: []}
    for (r, h) in dome[3:9]:
        for s in (-1, 1):
            a = la + s * 0.2 / max(r, 0.4)
            rails[s].append(((r + 0.09) * math.cos(a), (r + 0.09) * math.sin(a), G + h + 0.05))
    for s in (-1, 1):
        b.tube(rails[s], 0.014, 5, zone=Z["iron"])
    for k in range(len(rails[1]) - 1):
        for t in (0.25, 0.75):
            p0 = Vector(rails[-1][k]).lerp(Vector(rails[-1][k + 1]), t)
            p1 = Vector(rails[1][k]).lerp(Vector(rails[1][k + 1]), t)
            b.tube([p0, p1], 0.01, 4, zone=Z["iron"])
    # ventilator ball, finial and lightning rod
    top = GLAZE1 + 1.5
    b.cyl(0.11, 0.13, 0.18, 16, Matrix.Translation((0, 0, G + top + 0.09)), zone=Z["copper"])
    b.uvsphere(0.34, 20, 12, Matrix.Translation((0, 0, G + top + 0.48)), zone=Z["copper"])
    for i in range(8):
        a = 2 * math.pi * i / 8
        b.cyl(0.05, 0.05, 0.03, 8, Matrix.Translation((0.3 * math.cos(a), 0.3 * math.sin(a), G + top + 0.45)) @
              Matrix.Rotation(a, 4, "Z") @ Matrix.Rotation(math.pi / 2, 4, "Y"), zone=Z["black"])
    b.cyl(0.06, 0.04, 0.2, 10, Matrix.Translation((0, 0, G + top + 0.9)), zone=Z["copper"])
    b.cyl(0.02, 0.016, 1.5, 8, Matrix.Translation((0, 0, G + top + 1.75)), zone=Z["iron"])
    b.cyl(0.016, 0.0, 0.14, 8, Matrix.Translation((0, 0, G + top + 2.57)), zone=Z["iron"])
    return b.to_object("Lantern", smooth_angle=45)


def build_lantern_glass():
    b = Builder()
    b.lathe([(1.875, GLAZE0), (1.875, GLAZE1)], 64, Matrix.Translation((0, 0, G)), zone=0)
    return b.to_object("LanternGlass", smooth_angle=89)


def build_lens():
    """Lens: glass prism rings and two bullseye panels (beams along local engine +x and -x)."""
    b = Builder()
    GL, BR = 0, 1
    # catadioptric rings above and below the belt, following a dome
    for side in (1, -1):
        for i in range(8 if side > 0 else 6):
            h = 0.47 + i * 0.062
            r = 0.71 * math.sqrt(max(0.05, 1.0 - (h / 1.02) ** 2)) + 0.02
            prof = [(r - 0.05, 0.0), (r + 0.03, 0.012), (r - 0.01, 0.058), (r - 0.05, 0.0)]
            prof = [(p[0], side * (h + p[1])) for p in prof]
            if side < 0:
                prof = list(reversed(prof))
            b.lathe(prof, 36, Matrix(), zone=GL)
    # refracting belt on the two sides without panels
    for i in range(7):
        h = -0.4 + i * 0.12
        for a0 in (math.radians(48), math.radians(228)):
            prof = [(0.66, h), (0.71, h + 0.05), (0.66, h + 0.11), (0.66, h)]
            b.lathe(prof, 14, Matrix(), zone=GL, a0=a0, a1=a0 + math.radians(84))
    # bullseye panels
    for s in (1, -1):
        m = Matrix.Translation((s * 0.6, 0, 0)) @ Matrix.Rotation(s * math.pi / 2, 4, "Y")
        b.cyl(0.43, 0.43, 0.025, 30, m, zone=GL)
        b.lathe([(0.0, 0.11), (0.03, 0.105), (0.06, 0.08), (0.075, 0.012), (0.0, 0.012)], 24, m, zone=GL)
        for k in range(6):
            r0 = 0.085 + k * 0.058
            b.lathe([(r0, 0.012), (r0 + 0.052, 0.012), (r0 + 0.004, 0.07 - 0.008 * k), (r0, 0.012)], 30, m,
                    zone=GL)
        # square brass frame round the panel
        c = Vector((s * 0.6, 0, 0))
        for (p0, p1) in (((0, -0.45, -0.44), (0, 0.45, -0.44)), ((0, -0.45, 0.44), (0, 0.45, 0.44)),
                         ((0, -0.45, -0.44), (0, -0.45, 0.44)), ((0, 0.45, -0.44), (0, 0.45, 0.44))):
            b.tube([c + Vector(p0), c + Vector(p1)], 0.018, 6, zone=BR)
    # brass rings, bars and crown
    for h, r, rad in ((0.44, 0.72, 0.022), (-0.44, 0.72, 0.022), (0.95, 0.2, 0.025), (-0.88, 0.36, 0.03)):
        ring = [(r * math.cos(2 * math.pi * k / 64), r * math.sin(2 * math.pi * k / 64), h) for k in range(65)]
        b.tube(ring, rad, 6, zone=BR, cap=False)
    for a in (45, 135, 225, 315):
        ar = math.radians(a)
        pts = []
        for h in [-0.88 + 1.83 * t / 10 for t in range(11)]:
            r = 0.72 if abs(h) < 0.45 else 0.73 * math.sqrt(max(0.05, 1.0 - (abs(h) / 1.02) ** 2)) + 0.03
            pts.append((r * math.cos(ar), r * math.sin(ar), h))
        b.tube(pts, 0.016, 6, zone=BR)
    b.cyl(0.36, 0.42, 0.06, 32, Matrix.Translation((0, 0, -0.92)), zone=BR)
    ob = b.to_object("Lens", smooth_angle=30)
    _keep_zone_as_material(ob)
    ob.location = (0, 0, G + FOCUS)
    return ob


def _keep_zone_as_material(ob):
    import numpy as np
    me = ob.data
    z = np.empty(len(me.polygons), np.float32)
    me.attributes["zone"].data.foreach_get("value", z)
    me.polygons.foreach_set("material_index", z.astype(np.int32))
    me.attributes.remove(me.attributes["zone"])


def build_lamp_core():
    b = Builder()
    # incandescent mantle: a glowing bulb about 0.35 m across on a short burner stem
    prof = [(0.0, -0.2), (0.05, -0.2), (0.06, -0.15), (0.12, -0.12), (0.165, -0.05), (0.175, 0.03),
            (0.16, 0.1), (0.12, 0.15), (0.06, 0.175), (0.0, 0.18)]
    b.lathe(prof, 24, Matrix(), zone=0, cap_bottom=True)
    ob = b.to_object("LampCore", smooth_angle=89)
    ob.location = (0, 0, G + FOCUS)
    return ob


def build_all():
    objs = dict(
        Lighthouse=build_tower(),
        Gallery=build_gallery(),
        Lantern=build_lantern(),
        LanternGlass=build_lantern_glass(),
        Lens=build_lens(),
        LampCore=build_lamp_core(),
    )
    for k, o in objs.items():
        log(k, "tris", sum(len(p.vertices) - 2 for p in o.data.polygons))
    return objs


def lamp_position():
    return [LIGHTHOUSE[0], round(G + FOCUS, 3), LIGHTHOUSE[2]]


def door_position():
    a = math.radians(DOOR_AZ)
    return [round(3.6 * math.cos(a), 3), G + 0.3, round(3.6 * math.sin(a), 3)]
