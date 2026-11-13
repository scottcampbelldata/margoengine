# A small wooden fishing boat, about 7 m, built around the waterline.
# Boat local space: origin at the waterline centre, bow toward engine +z.

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

from sl_common import Builder, E, log, set_point_attr, smooth_by_angle
from sl_materials import BT_ZONES as Z

LENGTH = 7.0
BEAM = 2.5
STATIONS = 44
GIRTH = 18


def _shape(s):
    """Half breadth at the sheer, sheer height and keel height for station s (0 stern .. 1 bow)."""
    k = 0.58 if s > 0.42 else 0.62
    f = max(0.0, 1.0 - abs((s - 0.42) / k) ** 2.2)
    B = (BEAM / 2) * f ** 0.62
    Hs = 0.86 + 0.44 * (s - 0.45) ** 2 / 0.3
    K = -0.74 + 0.5 * max(0.0, min(1.0, (s - 0.78) / 0.22)) ** 1.6 + 0.12 * max(0.0, 0.12 - s) / 0.12
    return B, Hs, K


def _section(s, t):
    B, Hs, K = _shape(s)
    phi = t * math.pi / 2
    x = B * math.sin(phi) ** 0.55
    z = K + (Hs - K) * (1 - math.cos(phi)) ** 0.85
    # slight flare in the topsides
    x *= 1.0 + 0.04 * t
    return x, z


def _hull(b):
    """Planked shell; returns per-vertex girth values for plank seams."""
    bm = b.bm
    girth = {}
    rows = []
    for i in range(STATIONS + 1):
        s = i / STATIONS
        y = -LENGTH / 2 + LENGTH * s  # engine z
        ring = []
        for j in range(-GIRTH, GIRTH + 1):
            t = abs(j) / GIRTH
            x, z = _section(min(s, 0.995), t)
            v = bm.verts.new(E(math.copysign(x, j) if j else 0.0, z, y))
            girth[v] = t
            ring.append(v)
        rows.append(ring)
    t_sheer = 0.84
    for i in range(STATIONS):
        for j in range(2 * GIRTH):
            q = (rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j])
            f = bm.faces.new(q)
            tm = 0.5 * (girth[q[0]] + girth[q[1]])
            f.material_index = Z["hull"]
    # transom
    f = bm.faces.new(list(reversed(rows[0])))
    f.material_index = Z["hull"]
    # stem: close the bow ring onto a centre line
    return rows, girth


def build_boat():
    b = Builder()
    rows, girth = _hull(b)
    deck_off = 0.36
    # deck and inner bulwarks
    inner = []
    for i in range(1, STATIONS):
        s = i / STATIONS
        B, Hs, K = _shape(s)
        x, _ = _section(s, 1.0)
        inner.append((max(0.05, x - 0.07), Hs - deck_off, Hs - 0.02, -LENGTH / 2 + LENGTH * s))
    for k in range(len(inner) - 1):
        x0, d0, t0, y0 = inner[k]
        x1, d1, t1, y1 = inner[k + 1]
        b.poly([E(-x0, d0, y0), E(x0, d0, y0), E(x1, d1, y1), E(-x1, d1, y1)], zone=Z["deck"])
        for s in (-1, 1):
            b.poly([E(s * x0, d0, y0), E(s * x1, d1, y1), E(s * x1, t1, y1), E(s * x0, t0, y0)], zone=Z["sheer"])
    # gunwale cap and rubbing strake
    for s in (-1, 1):
        cap = []
        rub = []
        for i in range(1, STATIONS + 1):
            st = min(i / STATIONS, 0.995)
            x, z = _section(st, 1.0)
            y = -LENGTH / 2 + LENGTH * st
            cap.append(E(s * (x - 0.03), z + 0.02, y))
            x2, z2 = _section(st, 0.9)
            rub.append(E(s * (x2 + 0.035), z2, y))
        b.tube(cap, 0.045, 6, zone=Z["rub"])
        b.tube(rub, 0.04, 6, zone=Z["rub"])
    # stem post, keel and rudder
    stem = []
    for k in range(9):
        t = k / 8
        x, z = _section(0.995, t)
        stem.append(E(0, z, LENGTH / 2 - 0.01 + 0.04 * math.sin(t * 2)))
    b.tube(stem, 0.06, 6, zone=Z["rub"])
    ebox = _ebox(b)
    keel = []
    for k in range(13):
        st = 0.02 + 0.8 * k / 12
        keel.append(E(0, _shape(st)[2] - 0.06, -LENGTH / 2 + LENGTH * st))
    b.tube(keel, 0.075, 6, zone=Z["hull"])
    ebox((0, -0.35, -LENGTH / 2 - 0.12), (0.06, 0.95, 0.55), Z["hull"])
    # wheelhouse
    deck_at = lambda s: _shape(s)[1] - deck_off
    wy = -0.55
    dk = deck_at(0.42)
    ebox((0, dk + 0.85, wy), (1.45, 1.7, 1.55), Z["house"], bevel=0.04)
    ebox((0, dk + 1.75, wy - 0.05), (1.65, 0.1, 1.85), Z["roof"], bevel=0.03)
    ebox((0.73, dk + 0.7, wy - 0.35), (0.03, 1.2, 0.55), Z["roof"])
    win = Builder()
    for k in (-1, 0, 1):
        _box(win, (k * 0.44, dk + 1.25, wy + 0.78), (0.36, 0.42, 0.03), 0)
        _box(b, (k * 0.44, dk + 1.25, wy + 0.785), (0.42, 0.48, 0.02), Z["roof"])
    for s in (-1, 1):
        _box(win, (s * 0.735, dk + 1.25, wy + 0.25), (0.03, 0.4, 0.55), 0)
        _box(b, (s * 0.732, dk + 1.25, wy + 0.25), (0.02, 0.46, 0.61), Z["roof"])
    _box(win, (0, dk + 1.2, wy - 0.78), (0.6, 0.36, 0.03), 0)
    # roof gear: radar dome, aerial, liferaft canister, handrail, exhaust stack
    rt = dk + 1.8
    b.lathe([(0.24, 0.0), (0.24, 0.06), (0.21, 0.13), (0.12, 0.2), (0.0, 0.22)], 20,
            Matrix.Translation(E(0.25, rt, wy + 0.25)), zone=Z["house"], cap_bottom=True)
    b.cyl(0.05, 0.05, 0.1, 10, Matrix.Translation(E(0.25, rt - 0.03, wy + 0.25)), zone=Z["steel"])
    b.tube([E(-0.62, rt, wy - 0.7), E(-0.62, rt + 1.7, wy - 0.7)], 0.012, 5, zone=Z["steel"])
    m = Matrix.Translation(E(-0.25, rt + 0.2, wy - 0.45)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
    b.cyl(0.2, 0.2, 0.62, 16, m, zone=Z["house"])
    for dx in (-0.12, 0.12):
        ring = [E(-0.25 + dx, rt + 0.2 + 0.215 * math.cos(t / 16 * 2 * math.pi), wy - 0.45 +
                  0.215 * math.sin(t / 16 * 2 * math.pi)) for t in range(17)]
        b.tube(ring, 0.01, 4, zone=Z["steel"], cap=False)
    for s in (-1, 1):
        b.tube([E(s * 0.72, rt + 0.05, wy - 0.85), E(s * 0.72, rt + 0.25, wy - 0.85), E(s * 0.72, rt + 0.25, wy + 0.7),
                E(s * 0.72, rt + 0.05, wy + 0.7)], 0.015, 5, zone=Z["steel"])
    b.tube([E(0.55, dk + 0.2, wy - 0.82), E(0.55, rt + 0.55, wy - 0.82)], 0.06, 10, zone=Z["rubber"])
    b.cyl(0.075, 0.075, 0.05, 10, Matrix.Translation(E(0.55, rt + 0.57, wy - 0.82)), zone=Z["rubber"])
    # lifering on the wheelhouse back
    b.lathe([(0.2 + 0.05 * math.cos(a), 0.05 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 9)], 20,
            Matrix.Translation(E(0.35, dk + 0.95, wy - 0.8)) @ Matrix.Rotation(math.pi / 2, 4, "X"), zone=Z["box"])
    # mast with crosstree and masthead light
    my = 0.95
    md = deck_at(0.62)
    mtop = md + 4.1
    b.cyl(0.075, 0.05, mtop - md, 12, Matrix.Translation(E(0, (md + mtop) / 2, my)), zone=Z["mast"])
    ebox((0, mtop - 0.7, my), (1.0, 0.06, 0.08), Z["mast"])
    b.tube([E(0, mtop - 0.2, my), E(0, md + 0.6, my - 2.2)], 0.035, 6, zone=Z["steel"])
    b.tube([E(0, mtop - 0.1, my), E(0.95, md + 0.05, my + 0.6)], 0.008, 4, zone=Z["steel"])
    b.tube([E(0, mtop - 0.1, my), E(-0.95, md + 0.05, my + 0.6)], 0.008, 4, zone=Z["steel"])
    b.tube([E(0, mtop - 0.1, my), E(0, _shape(0.99)[1], LENGTH / 2 - 0.05)], 0.008, 4, zone=Z["steel"])
    light = Builder()
    light.cyl(0.06, 0.06, 0.12, 12, Matrix.Translation(E(0, mtop + 0.08, my)), zone=0)
    b.cyl(0.075, 0.075, 0.02, 12, Matrix.Translation(E(0, mtop + 0.15, my)), zone=Z["steel"])
    b.cyl(0.07, 0.07, 0.02, 12, Matrix.Translation(E(0, mtop + 0.01, my)), zone=Z["steel"])
    # net drum on an A frame at the stern
    ds = deck_at(0.12)
    m = Matrix.Translation(E(0, ds + 0.62, -2.55)) @ Matrix.Rotation(math.pi / 2, 4, "Y")
    b.cyl(0.38, 0.38, 1.0, 20, m, zone=Z["net"])
    for s in (-1, 1):
        b.cyl(0.52, 0.52, 0.04, 20, Matrix.Translation(E(s * 0.52, ds + 0.62, -2.55)) @ Matrix.Rotation(math.pi / 2, 4, "Y"),
              zone=Z["steel"])
        b.tube([E(s * 0.6, ds, -2.95), E(s * 0.6, ds + 0.65, -2.55), E(s * 0.6, ds, -2.15)], 0.04, 6, zone=Z["steel"])
    # fish boxes
    for k, (x, y, z, yaw) in enumerate(((0.45, 0.0, 1.85, 5), (0.43, 0.27, 1.86, -4), (-0.4, 0.0, 1.9, 12))):
        d = deck_at(0.75)
        m0 = Matrix.Translation(E(x, d + y, z)) @ Matrix.Rotation(math.radians(yaw), 4, "Z")
        b.box((0.55, 0.38, 0.03), m0 @ Matrix.Translation((0, 0, 0.015)), zone=Z["box"])
        for s in (-1, 1):
            b.box((0.55, 0.02, 0.26), m0 @ Matrix.Translation((0, s * 0.18, 0.13)), zone=Z["box"], bevel=0.004)
            b.box((0.02, 0.38, 0.26), m0 @ Matrix.Translation((s * 0.27, 0, 0.13)), zone=Z["box"], bevel=0.004)
    # tyre fenders hanging on the sides
    for s in (-1, 1):
        for st in (0.3, 0.55):
            x, z = _section(st, 0.8)
            y = -LENGTH / 2 + LENGTH * st
            m = Matrix.Translation(E(s * (x + 0.12), z - 0.05, y)) @ Matrix.Rotation(math.pi / 2, 4, "Y") @ \
                Matrix.Rotation(s * 0.25, 4, "X")
            prof = [(0.22 + 0.08 * math.cos(a), 0.07 * math.sin(a)) for a in np.linspace(0, 2 * math.pi, 9)]
            b.lathe(prof, 16, m, zone=Z["rubber"])
            xs, zs = _section(st, 1.0)
            b.tube([E(s * (xs - 0.02), zs + 0.05, y), E(s * (x + 0.12), z + 0.25, y)], 0.012, 4, zone=Z["net"])
    ob = b.to_object("Boat", smooth_angle=38)
    # girth attribute for plank seams: recompute from geometry (fraction of height from keel to sheer)
    V = np.array([v.co[:] for v in ob.data.vertices])
    eng_z = -V[:, 1]
    s = np.clip((eng_z + LENGTH / 2) / LENGTH, 0, 0.995)
    Hs = 0.86 + 0.44 * (s - 0.45) ** 2 / 0.3
    K = -0.74 + 0.5 * np.clip((s - 0.78) / 0.22, 0, 1) ** 1.6
    g = np.clip((V[:, 2] - K) / (Hs - K), 0, 1)
    set_point_attr(ob.data, "girth", g)
    w = win.to_object("BoatWindows", smooth_angle=10)
    l = light.to_object("MastLight", smooth_angle=89)
    meta = dict(length=LENGTH, beam=BEAM, mastLight=[0.0, round(mtop + 0.08, 3), my])
    log("boat tris", sum(len(p.vertices) - 2 for p in ob.data.polygons))
    return ob, w, l, meta


def _box(b, c, size, zone, bevel=0.0):
    return b.box((size[0], size[2], size[1]), Matrix.Translation(E(*c)), zone=zone, bevel=bevel)


def _ebox(b):
    def f(c, size, zone, bevel=0.0):
        return _box(b, c, size, zone, bevel)
    return f
