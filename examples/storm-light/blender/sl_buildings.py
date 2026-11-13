# Keeper's cottage, compound wall, jetty and small props.
# Placement uses engine coordinates; ground heights come from raycasts.

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from sl_common import (Builder, E, apply_modifiers, fbm3, hash1, log, mesh_verts, select_only, set_mesh_verts,
                       smooth_by_angle, voronoi3)
from sl_lighthouse import DOOR_AZ
from sl_materials import CT_ZONES as CZ
from sl_materials import JT_ZONES as JZ
from sl_terrain import COTTAGE, COTTAGE_HALF, DECK_Y, JETTY_X, JETTY_Z0, JETTY_Z1, LIGHTHOUSE, cliff_edge_z


def em(x, y, z, yaw=0.0, sx=1.0, sy=1.0, sz=1.0):
    """Matrix placing a unit box: engine centre, yaw about engine Y (degrees), engine sizes."""
    return (Matrix.Translation(E(x, y, z)) @ Matrix.Rotation(math.radians(yaw), 4, "Z") @
            Matrix.Diagonal((sx, sz, sy, 1.0)))


def ebox(b, c, size, zone, yaw=0.0, bevel=0.0, seg=1, rot=None):
    m = Matrix.Translation(E(*c)) @ Matrix.Rotation(math.radians(yaw), 4, "Z")
    if rot is not None:
        m = m @ rot
    return b.box((size[0], size[2], size[1]), m, zone=zone, bevel=bevel, seg=seg)


def prism_x(b, x0, x1, pts_zy, zone):
    """Prism along engine x from an outline in the engine (z, y) plane."""
    a = [b.bm.verts.new(E(x0, y, z)) for (z, y) in pts_zy]
    c = [b.bm.verts.new(E(x1, y, z)) for (z, y) in pts_zy]
    n = len(pts_zy)
    for i in range(n):
        j = (i + 1) % n
        f = b.bm.faces.new((a[i], a[j], c[j], c[i]))
        f.material_index = zone
    f = b.bm.faces.new(a)
    f.material_index = zone
    f = b.bm.faces.new(list(reversed(c)))
    f.material_index = zone


# ---------------------------------------------------------------- cottage

CX, CY, CZc = COTTAGE
HX, HZ = COTTAGE_HALF
WALL_T = 0.6
EAVE = CY + 2.9
RIDGE = EAVE + 2.65
SOUTH_FACE = CZc + HZ
NORTH_FACE = CZc - HZ
EAST_FACE = CX + HX
WEST_FACE = CX - HX

# windows: (kind, centre along wall, sill height above floor, width, height)
COT_WINDOWS = [
    ("S", CX - 2.7, 0.85, 0.82, 1.05),
    ("S", CX + 2.7, 0.85, 0.82, 1.05),
    ("N", CX - 2.0, 0.95, 0.76, 0.95),
    ("N", CX + 2.2, 0.95, 0.76, 0.95),
    ("E", CZc, 1.0, 0.7, 0.9),
]
COT_DOOR = (CX, 1.0, 2.05)  # along x, width, height


def _opening_frame(kind, u, sill, w, h):
    """Engine centre on the outer face and outward normal for a wall opening."""
    yc = CY + sill + h / 2
    if kind == "S":
        return (u, yc, SOUTH_FACE), (0.0, 0.0, 1.0), 0.0
    if kind == "N":
        return (u, yc, NORTH_FACE), (0.0, 0.0, -1.0), 180.0
    return (EAST_FACE, yc, u), (1.0, 0.0, 0.0), 90.0


def build_cottage():
    b = Builder()
    y0 = CY - 0.35
    hgt = EAVE - y0
    ebox(b, (CX, y0 + hgt / 2, SOUTH_FACE - WALL_T / 2), (2 * HX, hgt, WALL_T), CZ["wall"])
    ebox(b, (CX, y0 + hgt / 2, NORTH_FACE + WALL_T / 2), (2 * HX, hgt, WALL_T), CZ["wall"])
    gable = [(NORTH_FACE + 0.01, y0), (SOUTH_FACE - 0.01, y0), (SOUTH_FACE - 0.01, EAVE), (CZc, RIDGE + 0.05),
             (NORTH_FACE + 0.01, EAVE)]
    prism_x(b, EAST_FACE - WALL_T, EAST_FACE, gable, CZ["wall"])
    prism_x(b, WEST_FACE, WEST_FACE + WALL_T, gable, CZ["wall"])
    walls = b.to_object("Cottage", smooth_angle=30)
    # cut the openings
    c = Builder()
    for (kind, u, sill, w, h) in COT_WINDOWS:
        ctr, nrm, yaw = _opening_frame(kind, u, sill, w, h)
        ebox(c, ctr, (w, h, 2.0), CZ["wall"], yaw=yaw)
    ebox(c, (COT_DOOR[0], CY + COT_DOOR[2] / 2 - 0.02, SOUTH_FACE), (COT_DOOR[1], COT_DOOR[2] + 0.04, 2.0), CZ["wall"])
    cutter = c.to_object("cutter")
    mod = walls.modifiers.new("cut", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.solver = "EXACT"
    mod.object = cutter
    apply_modifiers(walls)
    bpy.data.objects.remove(cutter)

    d = Builder()
    glass = Builder()
    windows_out = []
    for (kind, u, sill, w, h) in COT_WINDOWS:
        ctr, nrm, yaw = _opening_frame(kind, u, sill, w, h)
        _cottage_window(d, glass, ctr, nrm, yaw, w, h)
        windows_out.append(dict(position=[round(v, 3) for v in ctr], normal=list(nrm), size=[w, h]))
    _cottage_door(d)
    _roof(d)
    _chimneys(d)
    # tarred base course
    for (c0, size) in (((CX, CY - 0.1, SOUTH_FACE + 0.015), (2 * HX + 0.04, 0.5, 0.04)),
                       ((CX, CY - 0.1, NORTH_FACE - 0.015), (2 * HX + 0.04, 0.5, 0.04)),
                       ((EAST_FACE + 0.015, CY - 0.1, CZc), (0.04, 0.5, 2 * HZ + 0.04)),
                       ((WEST_FACE - 0.015, CY - 0.1, CZc), (0.04, 0.5, 2 * HZ + 0.04))):
        ebox(d, c0, size, CZ["iron"])
    det = d.to_object("cottage_detail", smooth_angle=35)
    select_only([walls, det])
    bpy.context.view_layer.objects.active = walls
    bpy.ops.object.join()
    smooth_by_angle(walls.data, 35)
    win = glass.to_object("CottageWindows", smooth_angle=10)
    return walls, win, windows_out


def _cottage_window(d, glass, ctr, nrm, yaw, w, h):
    n = Vector((nrm[0], nrm[1], nrm[2]))
    c = Vector(ctr)

    tan = Vector((n.z, 0.0, -n.x))

    def at(depth, du=0.0, dv=0.0):
        # point on the opening: depth inward from the outer face, du along the wall, dv up
        p = c - n * depth + tan * du + Vector((0, dv, 0))
        return (p.x, p.y, p.z)

    depth = 0.3
    ft = 0.07
    # frame
    ebox(d, at(depth, -w / 2 + ft / 2, 0), (ft, h, 0.1), CZ["frame"], yaw=yaw)
    ebox(d, at(depth, w / 2 - ft / 2, 0), (ft, h, 0.1), CZ["frame"], yaw=yaw)
    ebox(d, at(depth, 0, h / 2 - ft / 2), (w, ft, 0.1), CZ["frame"], yaw=yaw)
    ebox(d, at(depth, 0, -h / 2 + ft / 2), (w, ft, 0.1), CZ["frame"], yaw=yaw)
    # glazing bars: three rows of two panes
    ebox(d, at(depth - 0.01, 0, 0), (0.035, h - 0.1, 0.05), CZ["frame"], yaw=yaw)
    for k in (-1, 1):
        ebox(d, at(depth - 0.01, 0, k * (h - 0.1) / 6), (w - 0.1, 0.03, 0.05), CZ["frame"], yaw=yaw)
    # stone sill and lintel
    ebox(d, at(-0.04, 0, -h / 2 - 0.05), (w + 0.2, 0.1, 0.36), CZ["sill"], yaw=yaw, bevel=0.012)
    ebox(d, at(0.12, 0, h / 2 + 0.11), (w + 0.36, 0.22, 0.3), CZ["sill"], yaw=yaw, bevel=0.012)
    # inner reveal back wall darkness is the room: the glass faces the outside
    ebox(glass, at(depth + 0.02, 0, 0), (w - 0.04, h - 0.04, 0.01), 0, yaw=yaw)


def _cottage_door(d):
    x, w, h = COT_DOOR
    z = SOUTH_FACE - 0.22
    for i in range(5):
        xx = x - w / 2 + w * (i + 0.5) / 5
        ebox(d, (xx, CY + h / 2, z), (w / 5 - 0.01, h - 0.02, 0.05), CZ["door"], bevel=0.006)
    for yy in (0.4, 1.0, 1.6):
        ebox(d, (x, CY + yy, z - 0.04), (w - 0.1, 0.12, 0.04), CZ["door"], bevel=0.008)
    ebox(d, (x - w / 2 + 0.03, CY + h / 2, z + 0.03), (0.07, h, 0.12), CZ["frame"])
    ebox(d, (x + w / 2 - 0.03, CY + h / 2, z + 0.03), (0.07, h, 0.12), CZ["frame"])
    ebox(d, (x, CY + h - 0.03, z + 0.03), (w, 0.07, 0.12), CZ["frame"])
    ebox(d, (x + w * 0.32, CY + 1.0, z + 0.04), (0.04, 0.16, 0.05), CZ["iron"], bevel=0.008)
    ebox(d, (x, CY + h + 0.12, SOUTH_FACE - 0.12), (w + 0.4, 0.24, 0.3), CZ["sill"], bevel=0.012)
    ebox(d, (x, CY - 0.1, SOUTH_FACE + 0.25), (w + 0.5, 0.2, 0.55), CZ["sill"], bevel=0.02)


def _roof(d):
    over_e = 0.32  # eave overhang
    over_g = 0.22  # verge overhang
    run = HZ + over_e
    rise = RIDGE - EAVE
    slope_len = math.hypot(HZ, rise) + over_e * math.hypot(HZ, rise) / HZ
    ang = math.atan2(rise, HZ)
    courses = 17
    expo = slope_len / courses
    x0, x1 = WEST_FACE - over_g, EAST_FACE + over_g
    rng = np.random.RandomState(3)
    for side in (1, -1):  # 1 = south slope
        for k in range(courses):
            s0 = k * expo  # distance up the slope from the eave edge
            lo = Vector((0, EAVE - over_e * math.tan(ang) + math.sin(ang) * s0,
                         CZc + side * (HZ + over_e - math.cos(ang) * s0)))
            L = expo * 1.9 if k < courses - 1 else expo * 1.2
            mid = lo + Vector((0, math.sin(ang), -side * math.cos(ang))) * (L / 2)
            # lift each course so it rests on the one below
            lift = Vector((0, math.cos(ang), side * math.sin(ang))) * 0.022
            rot = Matrix.Rotation(-side * ang, 4, "X")
            ebox(d, (CX + rng.uniform(-0.01, 0.01), mid.y + lift.y + 0.01, mid.z + lift.z), (x1 - x0, 0.022, L),
                 CZ["slate"], rot=Matrix.Rotation(side * ang, 4, "X"))
        # sarking board under the slates so the gable edge reads thick
        lo = Vector((0, EAVE - over_e * math.tan(ang), CZc + side * (HZ + over_e)))
        mid = lo + Vector((0, math.sin(ang), -side * math.cos(ang))) * (slope_len / 2)
        nrm = Vector((0, math.cos(ang), side * math.sin(ang)))
        c = mid - nrm * 0.07
        ebox(d, (CX, c.y, c.z), (x1 - x0 - 0.02, 0.12, slope_len), CZ["slate"], rot=Matrix.Rotation(side * ang, 4, "X"))
        # gutter
        gz = CZc + side * (HZ + over_e + 0.05)
        gy = EAVE - over_e * math.tan(ang) - 0.06
        d.tube([E(x0 + 0.05, gy, gz), E(x1 - 0.05, gy, gz)], 0.065, 8, zone=CZ["iron"])
    # ridge tiles
    n = 22
    for i in range(n):
        x = x0 + (x1 - x0) * (i + 0.5) / n
        m = Matrix.Translation(E(x, RIDGE + 0.05, CZc)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
        d.cyl(0.14, 0.135, (x1 - x0) / n - 0.015, 10, m, zone=CZ["ridge"])
    # downpipe at the south-east corner
    d.tube([E(EAST_FACE - 0.15, EAVE - 0.4, SOUTH_FACE + 0.12), E(EAST_FACE - 0.15, CY + 0.1, SOUTH_FACE + 0.12)],
           0.045, 8, zone=CZ["iron"])


def _chimneys(d):
    for x in (EAST_FACE - 0.4, WEST_FACE + 0.4):
        top = RIDGE + 1.1
        ebox(d, (x, (RIDGE - 1.0 + top) / 2, CZc), (0.75, top - RIDGE + 1.0, 1.05), CZ["wall"], bevel=0.02)
        ebox(d, (x, top + 0.06, CZc), (0.9, 0.12, 1.2), CZ["cement"], bevel=0.03)
        ebox(d, (x, top - 0.25, CZc), (0.82, 0.08, 1.12), CZ["wall"], bevel=0.01)
        for k in (-1, 1):
            m = Matrix.Translation(E(x, top + 0.34, CZc + k * 0.26))
            d.cyl(0.13, 0.105, 0.46, 12, m, zone=CZ["pot"])
            d.cyl(0.125, 0.125, 0.05, 12, Matrix.Translation(E(x, top + 0.55, CZc + k * 0.26)), zone=CZ["pot"])


# ---------------------------------------------------------------- compound wall

WALL_R = 8.0
GATE_HALF = 0.85


def build_compound_wall(ground):
    b = Builder()
    rng = np.random.RandomState(11)
    gate_da = math.degrees(GATE_HALF / WALL_R) + 3.5
    a0 = DOOR_AZ + gate_da
    a1 = DOOR_AZ + 360.0 - gate_da
    n = int((a1 - a0) / 360.0 * 2 * math.pi * WALL_R / 0.14)
    prof = [(-0.36, -0.35), (-0.36, 0.0), (-0.3, 0.55), (-0.24, 0.95), (0.24, 0.95), (0.3, 0.55), (0.36, 0.0),
            (0.36, -0.35)]
    rows = []
    tops = []
    for i in range(n + 1):
        a = math.radians(a0 + (a1 - a0) * i / n)
        cx, cz = LIGHTHOUSE[0] + WALL_R * math.cos(a), LIGHTHOUSE[2] + WALL_R * math.sin(a)
        gy = ground.y(cx, cz) or LIGHTHOUSE[1]
        ring = []
        for (u, v) in prof:
            ring.append(b.bm.verts.new(E(cx + u * math.cos(a), gy + v, cz + u * math.sin(a))))
        rows.append(ring)
        tops.append((cx, gy + 0.95, cz, a))
    for j in range(len(rows) - 1):
        for k in range(len(prof) - 1):
            f = b.bm.faces.new((rows[j][k], rows[j][k + 1], rows[j + 1][k + 1], rows[j + 1][k]))
    for ring in (rows[0], rows[-1]):
        b.bm.faces.new(ring)
    # cope stones standing on edge
    for i, (cx, ty, cz, a) in enumerate(tops[::1]):
        if i % 2:
            continue
        t = 0.17 + 0.07 * hash1(i)
        hgt = 0.26 + 0.12 * hash1(i * 3 + 1)
        tilt = (hash1(i * 7 + 2) - 0.5) * 0.3
        yaw = -math.degrees(a) + 90.0
        m = Matrix.Rotation(tilt, 4, "Y")
        ebox(b, (cx, ty + hgt / 2 - 0.03, cz), (0.5 + 0.08 * hash1(i * 5), hgt, t), 0, yaw=-math.degrees(a),
             rot=Matrix.Rotation(tilt, 4, "X"))
    # gate pillars
    for s in (-1, 1):
        a = math.radians(DOOR_AZ + s * (math.degrees(GATE_HALF / WALL_R) + 2.2))
        cx, cz = LIGHTHOUSE[0] + WALL_R * math.cos(a), LIGHTHOUSE[2] + WALL_R * math.sin(a)
        gy = ground.y(cx, cz) or LIGHTHOUSE[1]
        ebox(b, (cx, gy + 0.55, cz), (0.6, 1.6, 0.6), 0, yaw=-math.degrees(a), bevel=0.03)
        ebox(b, (cx, gy + 1.4, cz), (0.72, 0.12, 0.72), 0, yaw=-math.degrees(a), bevel=0.03)
        b.uvsphere(0.17, 12, 8, Matrix.Translation(E(cx, gy + 1.62, cz)), zone=0)
    ob = b.to_object("CompoundWall", smooth_angle=40)
    # bulge the stones of the wall body
    V = mesh_verts(ob.data)
    f1, f2, cid = voronoi3(V[:, 0] * 3.2, V[:, 1] * 3.2, V[:, 2] * 6.0)
    edge = np.clip((f2 - f1) / 0.35, 0, 1)
    nrm = np.zeros_like(V)
    nrm[:, 0] = V[:, 0] - LIGHTHOUSE[0]
    nrm[:, 1] = V[:, 1] + LIGHTHOUSE[2]
    ln = np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    r = ln[:, 0]
    sgn = np.sign(r - WALL_R)
    body = (np.abs(r - WALL_R) > 0.18) & (V[:, 2] < ground_level_max(V) - 0.0)
    disp = (0.05 * edge + 0.03 * (cid - 0.5)) * sgn * body
    V[:, :2] += nrm[:, :2] / ln * disp[:, None]
    set_mesh_verts(ob.data, V)
    return ob


def ground_level_max(V):
    return np.full(len(V), LIGHTHOUSE[1] + 0.9)


# ---------------------------------------------------------------- jetty

def build_jetty(ground):
    b = Builder()
    rng = np.random.RandomState(5)
    x = JETTY_X
    half = 1.2
    top = DECK_Y
    # deck planks across the jetty
    z = JETTY_Z0
    while z < JETTY_Z1 - 0.1:
        w = 0.2 + rng.uniform(-0.015, 0.02)
        ebox(b, (x + rng.uniform(-0.04, 0.04), top - 0.03 + rng.uniform(-0.006, 0.006), z + w / 2),
             (2 * half + rng.uniform(-0.05, 0.08), 0.06, w - 0.014), JZ["deck"], yaw=rng.uniform(-0.6, 0.6),
             bevel=0.008)
        z += w
    # stringers
    for dx in (-0.95, 0.0, 0.95):
        ebox(b, (x + dx, top - 0.06 - 0.11, 0.5 * (JETTY_Z0 + JETTY_Z1)), (0.14, 0.22, JETTY_Z1 - JETTY_Z0),
             JZ["beam"], bevel=0.01)
    # kerb timbers along both edges
    for s in (-1, 1):
        ebox(b, (x + s * (half - 0.08), top + 0.07, 0.5 * (JETTY_Z0 + JETTY_Z1) + 0.6),
             (0.16, 0.14, JETTY_Z1 - JETTY_Z0 - 1.2), JZ["beam"], bevel=0.015)
    # pile bents
    zs = np.arange(JETTY_Z0 + 1.0, JETTY_Z1, 3.0)
    for i, zb in enumerate(zs):
        last = i == len(zs) - 1
        for s in (-1, 1):
            px = x + s * (half + 0.12)
            sb = ground.y(px, zb)
            sb = (sb if sb is not None else -6.0) - 0.6
            ptop = top + (0.75 if last else 0.15)
            lean = rng.uniform(-0.02, 0.02)
            pts = [E(px, sb, zb), E(px + lean, ptop, zb + rng.uniform(-0.02, 0.02))]
            b.tube(pts, 0.16 + rng.uniform(-0.01, 0.015), 12, zone=JZ["pile"])
            if last:
                b.cyl(0.17, 0.14, 0.05, 12, Matrix.Translation(E(px + lean, ptop + 0.02, zb)), zone=JZ["iron"])
        ebox(b, (x, top - 0.06 - 0.22 - 0.12, zb), (2 * half + 0.6, 0.24, 0.2), JZ["beam"], bevel=0.015)
        sb = min(ground.y(x - half, zb) or -6, ground.y(x + half, zb) or -6)
        lo = max(sb + 0.3, -2.4)
        hi = 1.05
        if hi - lo > 0.8:
            for s in (-1, 1):
                p0 = E(x - s * (half + 0.12), hi, zb + 0.2)
                p1 = E(x + s * (half + 0.12), lo, zb + 0.2)
                mid = (p0 + p1) / 2
                dirv = (p1 - p0)
                L = dirv.length
                ang = math.atan2(dirv.z, dirv.x)
                m = Matrix.Translation(mid) @ Matrix.Rotation(-ang, 4, "Y") @ Matrix.Diagonal((L + 0.2, 0.06, 0.18, 1))
                b.box((1, 1, 1), m @ Matrix.Translation((0, (s * 0.04) / 0.06, 0)), zone=JZ["beam"])
    # bollards at the head
    for s, zz in ((-1, JETTY_Z1 - 1.2), (1, JETTY_Z1 - 1.2), (1, JETTY_Z0 + 9.0)):
        prof = [(0.17, 0.0), (0.15, 0.05), (0.12, 0.12), (0.11, 0.34), (0.17, 0.42), (0.17, 0.48), (0.1, 0.52),
                (0.0, 0.53)]
        m = Matrix.Translation(E(x + s * (half - 0.32), top, zz))
        b.lathe(prof, 16, m, zone=JZ["iron"], cap_bottom=True)
    # ladder on the east side at the head
    lx = x + half + 0.3
    lz0 = JETTY_Z1 - 3.0
    for dz in (-0.22, 0.22):
        pts = [E(lx, -2.2, lz0 + dz), E(lx, top + 0.1, lz0 + dz), E(lx - 0.1, top + 0.75, lz0 + dz),
               E(lx - 0.45, top + 0.8, lz0 + dz), E(lx - 0.5, top + 0.05, lz0 + dz)]
        b.tube(pts, 0.025, 8, zone=JZ["iron"])
    for k in range(13):
        yy = -2.0 + k * 0.3
        b.tube([E(lx, yy, lz0 - 0.22), E(lx, yy, lz0 + 0.22)], 0.016, 6, zone=JZ["iron"])
    return b.to_object("Jetty", smooth_angle=40)


# ---------------------------------------------------------------- props

def build_props(ground, ramp_pts):
    b = Builder()
    glow = Builder()
    meta = {}
    rng = np.random.RandomState(9)
    x = JETTY_X
    top = DECK_Y
    # rope coil on the jetty head
    cx, cz = x - 0.55, JETTY_Z1 - 2.2
    pts = []
    for t in range(0, 130):
        a = t * 0.42
        r = 0.12 + 0.2 * t / 130
        pts.append(E(cx + r * math.cos(a), top + 0.025 + 0.012 * (t % 25 == 0), cz + r * math.sin(a)))
    b.tube(pts, 0.022, 6, zone=JZ["rope"])
    # lobster pots
    for (px, pz, yaw) in ((x + 0.45, JETTY_Z1 - 4.6, 10.0), (x + 0.5, JETTY_Z1 - 5.5, -6.0), (x - 0.6, 30.2, 80.0)):
        _lobster_pot(b, px, top, pz, yaw)
    # fish boxes
    for k, (px, pz, yy, yaw) in enumerate(((x - 0.62, 27.4, 0, 4), (x - 0.6, 27.42, 0.3, -3), (x - 0.62, 28.1, 0, 12))):
        _fish_box(b, px, top + yy, pz, yaw)
    # stone steps and an iron handrail on the ramp
    for i in range(len(ramp_pts) - 1):
        p0, p1 = ramp_pts[i], ramp_pts[i + 1]
        dx, dz = p1[0] - p0[0], p1[2] - p0[2]
        yaw = -math.degrees(math.atan2(dz, dx))
        ebox(b, (p0[0], p0[1] - 0.08, p0[2]), (0.5, 0.22, 1.25), JZ["stone"], yaw=yaw, bevel=0.03)
    for i in range(0, len(ramp_pts), 2):
        px, py, pz = ramp_pts[i]
        # seaward side is +z for the south cliff
        b.cyl(0.03, 0.03, 1.0, 8, Matrix.Translation(E(px, py + 0.45, pz + 0.65)), zone=JZ["paint"])
    rail = [E(p[0], p[1] + 0.95, p[2] + 0.65) for p in ramp_pts[::2]]
    b.tube(rail, 0.025, 8, zone=JZ["paint"])
    # fence along the cliff path between the cottage and the ramp
    posts = []
    for fx in np.arange(-25.0, -47.0, -3.4):
        fz = cliff_edge_z(fx) - 1.1
        gy = ground.y(fx, fz)
        if gy is None:
            continue
        lean = rng.uniform(-4, 4)
        ebox(b, (fx, gy + 0.5, fz), (0.11, 1.15, 0.11), JZ["beam"], yaw=rng.uniform(0, 90), bevel=0.012,
             rot=Matrix.Rotation(math.radians(lean), 4, "X"))
        posts.append((float(fx), gy, float(fz)))
    for i in range(len(posts) - 1):
        for hh in (0.45, 0.88):
            p0 = E(posts[i][0], posts[i][1] + hh, posts[i][2])
            p1 = E(posts[i + 1][0], posts[i + 1][1] + hh, posts[i + 1][2])
            if i == 2 and hh > 0.5:
                # one broken rail hanging down
                p1 = p0 + (p1 - p0) * 0.55 + Vector((0, 0, -0.35))
            b.tube([p0, p1], 0.035, 6, zone=JZ["beam"])
    # bench against the cottage south wall
    bx, bz = COTTAGE[0] + 1.3, COTTAGE[2] + COTTAGE_HALF[1] + 0.42
    gy = COTTAGE[1]
    for k in range(3):
        ebox(b, (bx, gy + 0.45, bz - 0.12 + k * 0.13), (1.6, 0.04, 0.11), JZ["deck"], bevel=0.008)
    for k in range(2):
        ebox(b, (bx, gy + 0.62 + k * 0.14, bz - 0.25), (1.6, 0.1, 0.035), JZ["deck"], bevel=0.008,
             rot=Matrix.Rotation(math.radians(-12), 4, "X"))
    for s in (-1, 1):
        ebox(b, (bx + s * 0.7, gy + 0.22, bz), (0.05, 0.44, 0.42), JZ["paint"], bevel=0.01)
        ebox(b, (bx + s * 0.7, gy + 0.62, bz - 0.24), (0.05, 0.42, 0.05), JZ["paint"], bevel=0.01)
    # lamp post by the compound gate
    lx, lz = -9.2, 5.6
    ly = ground.y(lx, lz) or 15.8
    prof = [(0.16, 0.0), (0.14, 0.12), (0.09, 0.2), (0.065, 0.5), (0.05, 2.6), (0.07, 2.66), (0.07, 2.7)]
    b.lathe(prof, 12, Matrix.Translation(E(lx, ly - 0.1, lz)), zone=JZ["paint"], cap_top=True)
    hy = ly + 2.6
    ebox(b, (lx, hy + 0.06, lz), (0.26, 0.04, 0.26), JZ["paint"])
    for (ux, uz) in ((-1, -1), (-1, 1), (1, -1), (1, 1)):
        ebox(b, (lx + ux * 0.13, hy + 0.3, lz + uz * 0.13), (0.025, 0.48, 0.025), JZ["paint"])
    b.cyl(0.26, 0.05, 0.2, 4, Matrix.Translation(E(lx, hy + 0.64, lz)) @ Matrix.Rotation(math.pi / 4, 4, "Z"),
          zone=JZ["paint"])
    b.uvsphere(0.04, 8, 6, Matrix.Translation(E(lx, hy + 0.77, lz)), zone=JZ["paint"])
    ebox(glow, (lx, hy + 0.3, lz), (0.23, 0.44, 0.23), 0)
    meta["lampPost"] = [lx, round(hy + 0.3, 3), lz]
    # old anchor resting by the path
    _anchor(b, -21.0, ground, 11.6)
    # water butt by the cottage north-east corner
    wx, wz = COTTAGE[0] + COTTAGE_HALF[0] - 0.5, COTTAGE[2] - COTTAGE_HALF[1] - 0.5
    b.lathe([(0.0, 0.0), (0.33, 0.0), (0.37, 0.4), (0.33, 0.85), (0.3, 0.86), (0.0, 0.8)], 16,
            Matrix.Translation(E(wx, COTTAGE[1] - 0.02, wz)), zone=JZ["crate"])
    for hh in (0.15, 0.7):
        ring = [E(wx + 0.36 * math.cos(t / 24 * 2 * math.pi), COTTAGE[1] + hh, wz + 0.36 * math.sin(t / 24 * 2 * math.pi))
                for t in range(25)]
        b.tube(ring, 0.015, 5, zone=JZ["iron"], cap=False)
    props = b.to_object("PropsMesh", smooth_angle=40)
    glow_ob = glow.to_object("LampGlass", smooth_angle=10)
    return props, glow_ob, meta


def _lobster_pot(b, x, y, z, yaw):
    m0 = Matrix.Translation(E(x, y, z)) @ Matrix.Rotation(math.radians(yaw), 4, "Z")
    b.box((0.62, 0.46, 0.04), m0 @ Matrix.Translation((0, 0, 0.02)), zone=JZ["crate"], bevel=0.005)
    for k in range(3):
        xx = -0.28 + 0.28 * k
        pts = [m0 @ Vector((xx, 0.23 * math.cos(a), 0.04 + 0.32 * math.sin(a)))
               for a in [math.pi * t / 10 for t in range(11)]]
        b.tube(pts, 0.012, 5, zone=JZ["net"])
    for j in range(7):
        a = math.pi * (j + 0.5) / 7
        b.tube([m0 @ Vector((-0.3, 0.23 * math.cos(a), 0.04 + 0.32 * math.sin(a))),
                m0 @ Vector((0.3, 0.23 * math.cos(a), 0.04 + 0.32 * math.sin(a)))], 0.006, 4, zone=JZ["net"])
    b.tube([m0 @ Vector((-0.3, -0.23, 0.05)), m0 @ Vector((0.3, -0.23, 0.05))], 0.01, 4, zone=JZ["net"])


def _fish_box(b, x, y, z, yaw):
    m0 = Matrix.Translation(E(x, y, z)) @ Matrix.Rotation(math.radians(yaw), 4, "Z")
    b.box((0.75, 0.48, 0.03), m0 @ Matrix.Translation((0, 0, 0.015)), zone=JZ["crate"])
    for s in (-1, 1):
        b.box((0.75, 0.025, 0.26), m0 @ Matrix.Translation((0, s * 0.23, 0.13)), zone=JZ["crate"], bevel=0.004)
        b.box((0.025, 0.48, 0.26), m0 @ Matrix.Translation((s * 0.36, 0, 0.13)), zone=JZ["crate"], bevel=0.004)


def _anchor(b, x, ground, z):
    gy = ground.y(x, z) or 15.5
    m0 = (Matrix.Translation(E(x, gy - 0.25, z)) @ Matrix.Rotation(math.radians(35), 4, "Z") @
          Matrix.Rotation(math.radians(62), 4, "X"))
    # shank, crown arms, flukes, stock, ring
    b.tube([m0 @ Vector((0, 0, 0)), m0 @ Vector((0, 0, 1.9))], 0.07, 10, zone=JZ["iron"])
    arm = []
    for t in range(13):
        a = math.radians(-70 + 140 * t / 12)
        arm.append(m0 @ Vector((0.75 * math.sin(a), 0, 0.75 - 0.75 * math.cos(a) + 0.02)))
    b.tube(arm, 0.06, 10, zone=JZ["iron"])
    for s in (-1, 1):
        a = math.radians(70 * s)
        p = m0 @ Vector((0.75 * math.sin(a), 0, 0.75 - 0.75 * math.cos(a) + 0.02))
        b.box((0.36, 0.05, 0.28), Matrix.Translation(p) @ (m0.to_3x3().to_4x4()) @ Matrix.Rotation(s * 0.9, 4, "Y"),
              zone=JZ["iron"], bevel=0.02)
    b.tube([m0 @ Vector((0, -0.9, 1.75)), m0 @ Vector((0, 0.9, 1.75))], 0.05, 8, zone=JZ["iron"])
    for e in (-0.92, 0.92):
        b.uvsphere(0.07, 8, 6, Matrix.Translation(m0 @ Vector((0, e, 1.75))), zone=JZ["iron"])
    ring = [m0 @ Vector((0.0, 0.18 * math.sin(t / 16 * 2 * math.pi), 2.1 + 0.18 * math.cos(t / 16 * 2 * math.pi)))
            for t in range(17)]
    b.tube(ring, 0.03, 6, zone=JZ["iron"], cap=False)
