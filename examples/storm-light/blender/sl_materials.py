# Procedural materials (shader nodes), Cycles baking to images, and the
# plain Principled materials that are exported to glTF.
#
# Each baked material is a recipe returning colour, roughness, metallic and
# a height (metres) socket. Objects that share a recipe share one texture set
# (their UVs are packed together). Faces pick sub-materials through a face
# attribute named "zone".

import math
import os

import bpy

from sl_common import SCRATCH, log, select_only, smart_uv
from sl_nodes import NB

RECIPES = {}

# Linear colours tuned for a dark storm night: whitewash high, wet rock low.
WASH = (0.70, 0.70, 0.66)


def _finish(nb, d):
    """Hook a preview Principled BSDF to the recipe outputs."""
    out = nb.n("ShaderNodeOutputMaterial")
    out.is_active_output = True
    bsdf = nb.n("ShaderNodeBsdfPrincipled")
    nb.set(bsdf.inputs["Base Color"], d["color"])
    nb.set(bsdf.inputs["Roughness"], d["rough"])
    nb.set(bsdf.inputs["Metallic"], d.get("metal", 0.0))
    if d.get("height") is not None:
        d["normal"] = nb.bump(d["height"], 1.0, 1.0)
        nb.set(bsdf.inputs["Normal"], d["normal"])
    nb.links.new(bsdf.outputs[0], out.inputs["Surface"])
    d["out"] = out
    d["bsdf"] = bsdf
    RECIPES[nb.mat.name] = (nb, d)
    return nb.mat


def _cyl(nb, ground):
    """Cylindrical coordinates around the lighthouse axis: (u metres round, h metres up)."""
    px, py, pz = nb.sep(nb.pos())
    ang = nb.m("ARCTAN2", py, px)
    u = nb.mul(ang, 3.0)
    h = nb.sub(pz, ground)
    return u, h


# ---------------------------------------------------------------- rock and land

def rock_recipe(name, detail=1.0):
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    P = nb.pos()
    px, py, pz = nb.sep(P)
    nx, ny, nz = nb.sep(nb.normal())
    warp = nb.noise(P, 0.07, 2.0, 0.5, col=True)
    Pw = nb.vadd(P, nb.vscale(warp, 5.0))

    # strata: gently tilted bands
    tilt = nb.add(pz, nb.add(nb.mul(px, 0.05), nb.mul(py, -0.03)))
    svec = nb.comb(px, py, tilt)
    strata = nb.wave(svec, 0.33, dist=9.0, detail=4.0, direction="Z", dscale=0.25)
    strata2 = nb.wave(svec, 1.3, dist=3.0, detail=2.0, direction="Z", dscale=0.8, profile="SAW")

    # joints and blocks
    Pj = nb.mapping(Pw, scale=(1.0, 1.0, 0.35))
    edge = nb.voronoi(Pj, 0.4, feature="DISTANCE_TO_EDGE")
    cellc = nb.voronoi(Pj, 0.4, feature="F1", out="Color")
    cellr, _, _ = nb.sep(cellc)
    cfade = nb.mr(nb.noise(P, 0.18, 2.0), 0.42, 0.58)
    crack = nb.mul(nb.mr(edge, 0.05, 0.0), cfade)
    edge2 = nb.voronoi(nb.mapping(Pw, scale=(1.0, 1.0, 1.8)), 2.2, feature="DISTANCE_TO_EDGE")
    crack2 = nb.mul(nb.mr(edge2, 0.025, 0.0), nb.mr(nb.noise(P, 0.3, 2.0), 0.5, 0.62))
    block = nb.mr(edge, 0.0, 0.3)
    fine = nb.noise(P, 7.0 * detail, 6.0, 0.6)
    med = nb.noise(Pw, 1.1, 5.0, 0.55)

    base = nb.ramp(nb.noise(Pw, 0.35, 4.0, 0.6), [
        (0.30, (0.030, 0.030, 0.029)), (0.55, (0.055, 0.051, 0.046)), (0.75, (0.085, 0.077, 0.064))])
    banded = nb.ramp(strata, [(0.0, (0.85, 0.83, 0.8)), (0.5, (1.0, 1.0, 1.0)), (1.0, (1.15, 1.03, 0.9))])
    col = nb.cmul(base, banded)
    col = nb.cmul(col, nb.mr(cellr, 0.0, 1.0, 0.72, 1.25, smooth=False))
    col = nb.cmul(col, nb.mr(med, 0.3, 0.7, 0.75, 1.2))
    # iron staining in some strata
    stain = nb.mul(nb.mr(nb.noise(svec, 0.5, 3.0), 0.55, 0.7), nb.mr(strata2, 0.6, 0.95))
    col = nb.mixc(nb.mul(stain, 0.5), col, (0.085, 0.045, 0.022))
    # cavities
    cav = nb.mr(nb.pointiness(), 0.42, 0.56, 0.5, 1.12)
    col = nb.cmul(col, cav)
    col = nb.mixc(nb.add(nb.mul(crack, 0.85), nb.mul(crack2, 0.5)), col, (0.010, 0.010, 0.010))

    # lichen above the splash zone on upward or outward faces
    lich_noise = nb.noise(P, 1.6, 4.0, 0.6)
    lich_spots = nb.voronoi(P, 6.0, feature="F1", out="Distance")
    lich = nb.mul(nb.mr(lich_noise, 0.56, 0.64), nb.mr(pz, 4.0, 6.5))
    lich = nb.mul(lich, nb.mr(nz, -0.3, 0.3))
    lich = nb.mul(lich, nb.mr(lich_spots, 0.55, 0.25))
    lich_col = nb.ramp(nb.noise(P, 0.6, 2.0), [(0.3, (0.20, 0.11, 0.03)), (0.5, (0.17, 0.165, 0.11)),
                                               (0.7, (0.24, 0.24, 0.22))])
    col = nb.mixc(nb.mul(lich, 0.75), col, lich_col)
    # guano and salt streaks under ledges near the tip
    streak = nb.noise(nb.mapping(P, scale=(3.0, 3.0, 0.15)), 1.0, 3.0, 0.5)
    guano = nb.mul(nb.mr(streak, 0.66, 0.74), nb.mul(nb.mr(pz, 3.0, 6.0), nb.mr(nz, 0.2, -0.3)))
    col = nb.mixc(nb.mul(guano, 0.6), col, (0.30, 0.30, 0.27))

    # wet zone, weed band and barnacles near the sea
    wet = nb.mr(pz, 4.5, 1.2)
    col = nb.cmul(col, nb.lerp(wet, 1.0, 0.5))
    barn = nb.mul(nb.mr(nb.voronoi(P, 18.0, out="Distance"), 0.3, 0.12), nb.mul(nb.mr(pz, 0.4, 0.9),
                                                                               nb.mr(pz, 2.6, 1.8)))
    col = nb.mixc(nb.mul(barn, 0.7), col, (0.11, 0.105, 0.095))
    weed = nb.mul(nb.mr(pz, 1.0, 0.25), nb.mr(pz, -2.0, -0.8))
    weed_col = nb.ramp(nb.noise(P, 2.0, 3.0), [(0.4, (0.012, 0.016, 0.008)), (0.6, (0.035, 0.03, 0.01))])
    col = nb.mixc(weed, col, weed_col)
    sea = nb.mr(pz, -0.8, -2.5)
    sand = nb.mul(sea, nb.mr(nz, 0.5, 0.85))
    col = nb.mixc(sea, col, (0.04, 0.045, 0.035))
    col = nb.mixc(sand, col, (0.09, 0.085, 0.06))

    rough = nb.lerp(wet, 0.45, 0.25)
    rough = nb.lerp(weed, rough, 0.3)
    rough = nb.lerp(crack, rough, 0.5)
    rough = nb.lerp(nb.mul(lich, 0.9), rough, 0.62)
    rough = nb.add(rough, nb.mul(nb.sub(med, 0.5), 0.12))
    # under water the rock is matte: a wet film's sheen needs air above it, and seen through the sea its in-air
    # highlights would read as bright blue speckles
    rough = nb.lerp(sea, rough, 0.92)

    height = nb.mul(block, 0.035)
    height = nb.add(height, nb.mul(med, 0.05))
    height = nb.add(height, nb.mul(fine, 0.008))
    height = nb.sub(height, nb.mul(crack, 0.03))
    height = nb.sub(height, nb.mul(crack2, 0.012))
    height = nb.add(height, nb.mul(strata2, 0.012))
    height = nb.add(height, nb.mul(barn, 0.006))

    # grass, heather and the gravel path on gentle ground
    rockattr = nb.attr("rock")
    gbreak = nb.mul(nb.sub(nb.noise(P, 0.9, 3.0, 0.6), 0.5), 0.45)
    grass = nb.mr(nb.add(nb.sub(1.0, rockattr), gbreak), 0.42, 0.62)
    grass = nb.mul(grass, nb.mul(nb.mr(nz, 0.25, 0.5), nb.mr(pz, 2.4, 3.4)))
    gvar = nb.noise(Pw, 0.06, 3.0, 0.5)
    gcol = nb.ramp(gvar, [(0.35, (0.024, 0.036, 0.012)), (0.55, (0.045, 0.052, 0.018)),
                          (0.72, (0.085, 0.072, 0.034))])
    heather = nb.mr(nb.noise(P, 0.12, 4.0, 0.6), 0.55, 0.61)
    gcol = nb.mixc(heather, gcol, (0.038, 0.022, 0.024))
    Pwind = nb.mapping(P, rot=(0.0, 0.0, 0.65), scale=(0.25, 4.0, 1.0))
    wstreak = nb.noise(Pwind, 1.4, 4.0, 0.6)
    gcol = nb.cmul(gcol, nb.mr(wstreak, 0.3, 0.7, 0.65, 1.3))
    gcol = nb.cmul(gcol, nb.mr(fine, 0.3, 0.7, 0.8, 1.15))
    col = nb.mixc(grass, col, gcol)
    rough = nb.lerp(grass, rough, 0.7)
    gheight = nb.add(nb.mul(wstreak, 0.012), nb.mul(fine, 0.006))
    height = nb.lerp(grass, height, gheight)

    path = nb.attr("path")
    pedge = nb.mul(nb.mr(path, 0.05, 0.4), nb.mr(path, 0.75, 0.5))
    peb = nb.voronoi(P, 22.0, out="Color")
    pebr, _, _ = nb.sep(peb)
    pebd = nb.voronoi(P, 22.0, feature="DISTANCE_TO_EDGE")
    gravel = nb.cmul((0.11, 0.10, 0.085), nb.mr(pebr, 0.0, 1.0, 0.6, 1.4, smooth=False))
    gravel = nb.mixc(nb.mr(pebd, 0.04, 0.0), gravel, (0.03, 0.028, 0.025))
    puddle = nb.mr(nb.noise(P, 0.35, 2.0), 0.64, 0.67)
    pm = nb.mr(path, 0.45, 0.8)
    col = nb.mixc(nb.mul(pedge, 0.8), col, (0.045, 0.036, 0.026))
    col = nb.mixc(pm, col, gravel)
    col = nb.mixc(nb.mul(pm, puddle), col, (0.02, 0.019, 0.017))
    rough = nb.lerp(pm, rough, 0.45)
    rough = nb.lerp(nb.mul(pm, puddle), rough, 0.06)
    height = nb.lerp(pm, height, nb.mul(nb.mr(pebd, 0.0, 0.08), nb.lerp(puddle, 0.006, 0.0)))

    return _finish(nb, dict(color=col, rough=rough, metal=0.0, height=height))


# ---------------------------------------------------------------- lighthouse

LH_ZONES = dict(wash=0, red=1, granite=2, door=3, glass=4, black=5, iron=6, copper=7, brass=8, floor=9)


def lighthouse_recipe(name, ground):
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    P = nb.pos()
    px, py, pz = nb.sep(P)
    u, h = _cyl(nb, ground)
    masks = nb.zone_masks(10)
    fine = nb.noise(P, 9.0, 5.0, 0.6)
    big = nb.noise(P, 0.25, 3.0, 0.5)

    # whitewash over ashlar
    cvec = nb.comb(u, h, 0.0)
    mortar, _ = nb.brick(cvec, 1.0, width=0.9, height=0.42, mortar=0.014, smooth=0.3)
    svec = nb.comb(nb.mul(u, 2.5), nb.mul(h, 0.09), 0.0)
    streak = nb.noise(svec, 1.0, 4.0, 0.55)
    top = nb.mr(h, 6.0, 17.5)
    grime = nb.mul(nb.mr(streak, 0.45, 0.72), nb.add(0.2, nb.mul(top, 0.8)))
    rain = nb.mul(nb.mr(nb.noise(nb.comb(nb.mul(u, 7.0), nb.mul(h, 0.05), 0.0), 1.0, 5.0, 0.6), 0.52, 0.7),
                  nb.mr(h, 4.0, 16.5))
    wash = nb.cmul(WASH, nb.mr(big, 0.3, 0.7, 0.88, 1.05))
    wash = nb.cmul(wash, nb.mr(fine, 0.3, 0.7, 0.93, 1.03))
    wash = nb.mixc(nb.mul(grime, 0.75), wash, (0.25, 0.26, 0.23))
    wash = nb.mixc(nb.mul(rain, 0.55), wash, (0.2, 0.205, 0.19))
    rust_run = nb.mul(nb.mr(nb.noise(nb.comb(nb.mul(u, 6.0), nb.mul(h, 0.2), 0.0), 1.0, 3.0), 0.62, 0.75),
                      nb.mr(h, 13.0, 17.4))
    wash = nb.mixc(nb.mul(rust_run, 0.6), wash, (0.25, 0.12, 0.05))
    base_alg = nb.mul(nb.mr(h, 1.8, 0.2), nb.mr(nb.noise(P, 1.5, 3.0), 0.3, 0.6))
    wash = nb.mixc(base_alg, wash, (0.10, 0.12, 0.07))
    wash = nb.mixc(nb.mul(mortar, 0.25), wash, (0.42, 0.42, 0.40))
    flake = nb.mul(nb.mr(nb.noise(P, 2.5, 5.0, 0.65), 0.68, 0.71), 1.0)
    wash = nb.mixc(flake, wash, (0.16, 0.15, 0.14))
    h_wash = nb.sub(nb.mul(fine, 0.0015), nb.add(nb.mul(mortar, 0.004), nb.mul(flake, 0.0015)))

    red = nb.cmul((0.17, 0.022, 0.018), nb.mr(big, 0.3, 0.7, 0.8, 1.15))
    red = nb.mixc(nb.mul(nb.mr(streak, 0.55, 0.8), 0.5), red, (0.09, 0.03, 0.03))
    red = nb.mixc(nb.mul(mortar, 0.3), red, (0.08, 0.015, 0.012))

    gr_spk = nb.voronoi(P, 60.0, out="Color")
    grr, _, _ = nb.sep(gr_spk)
    granite = nb.cmul((0.16, 0.155, 0.145), nb.mr(grr, 0.0, 1.0, 0.55, 1.35, smooth=False))
    granite = nb.cmul(granite, nb.mr(big, 0.3, 0.7, 0.75, 1.15))
    granite = nb.mixc(base_alg, granite, (0.06, 0.08, 0.045))
    gmortar, _ = nb.brick(cvec, 1.0, width=1.1, height=0.4, mortar=0.02, smooth=0.2)
    granite = nb.mixc(nb.mul(gmortar, 0.6), granite, (0.05, 0.05, 0.05))
    h_gran = nb.sub(nb.mul(nb.noise(P, 4.0, 5.0), 0.006), nb.mul(gmortar, 0.008))

    wood_g = nb.noise(nb.mapping(P, scale=(8.0, 8.0, 0.4)), 3.0, 6.0, 0.6)
    door = nb.cmul((0.012, 0.05, 0.035), nb.mr(wood_g, 0.3, 0.7, 0.75, 1.2))
    wear = nb.mr(nb.noise(P, 3.0, 5.0), 0.62, 0.68)
    door = nb.mixc(wear, door, (0.09, 0.07, 0.05))
    h_door = nb.mul(wood_g, 0.002)

    glass = (0.006, 0.008, 0.01)
    black = nb.cmul((0.018, 0.018, 0.019), nb.mr(fine, 0.3, 0.7, 0.8, 1.2))

    rustn = nb.noise(P, 2.2, 6.0, 0.62)
    rust = nb.mr(rustn, 0.56, 0.66)
    iron = nb.mixc(rust, (0.022, 0.022, 0.024), nb.ramp(fine, [(0.3, (0.10, 0.04, 0.015)), (0.7, (0.2, 0.08, 0.03))]))
    h_iron = nb.mul(nb.mul(rust, rustn), 0.002)

    vstreak = nb.noise(nb.comb(nb.mul(u, 5.0), nb.mul(h, 0.4), 0.0), 1.0, 4.0, 0.6)
    copper = nb.ramp(vstreak, [(0.25, (0.08, 0.14, 0.115)), (0.5, (0.13, 0.21, 0.18)),
                               (0.7, (0.1, 0.16, 0.14))])
    copper = nb.mixc(nb.mr(nb.noise(P, 3.0, 4.0), 0.64, 0.72), copper, (0.16, 0.07, 0.035))
    copper = nb.mixc(nb.mul(nb.mr(vstreak, 0.72, 0.8), 0.7), copper, (0.03, 0.035, 0.03))

    brass = nb.cmul((0.55, 0.37, 0.12), nb.mr(fine, 0.3, 0.7, 0.75, 1.1))
    floor = nb.cmul((0.05, 0.05, 0.05), nb.mr(fine, 0.3, 0.7, 0.7, 1.2))

    col = nb.by_zone(masks, [wash, red, granite, door, glass, black, iron, copper, brass, floor], "color")
    rough = nb.by_zone(masks, [
        nb.lerp(nb.m("MAXIMUM", grime, rain), 0.4, 0.3), 0.35, 0.4, 0.4, 0.05, 0.35, nb.lerp(rust, 0.38, 0.7),
        0.4, 0.3, 0.5])
    metal = nb.by_zone(masks, [0.0, 0.0, 0.0, 0.0, 0.0, 0.2, nb.lerp(rust, 0.65, 0.0), 0.15, 1.0, 0.3])
    height = nb.by_zone(masks, [h_wash, h_wash, h_gran, h_door, 0.0, 0.0, h_iron, nb.mul(vstreak, 0.002),
                                0.0, 0.0])
    return _finish(nb, dict(color=col, rough=rough, metal=metal, height=height))


# ---------------------------------------------------------------- cottage

CT_ZONES = dict(wall=0, slate=1, ridge=2, pot=3, frame=4, door=5, sill=6, iron=7, cement=8)


def cottage_recipe(name):
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    P = nb.pos()
    px, py, pz = nb.sep(P)
    masks = nb.zone_masks(9)
    fine = nb.noise(P, 9.0, 5.0, 0.6)
    big = nb.noise(P, 0.4, 3.0, 0.5)
    ground = 15.5

    # whitewashed rubble stone
    sp = nb.mapping(P, scale=(1.0, 1.0, 1.7))
    sedge = nb.voronoi(sp, 3.2, feature="DISTANCE_TO_EDGE")
    scell = nb.mr(sedge, 0.0, 0.12)
    joint = nb.mr(sedge, 0.035, 0.0)
    flake = nb.mr(nb.noise(P, 2.6, 5.0, 0.65), 0.70, 0.73)
    low = nb.mr(pz, ground + 0.7, ground + 0.05)
    flake = nb.m("MAXIMUM", flake, nb.mul(low, nb.mr(nb.noise(P, 4.0, 4.0), 0.5, 0.58)))
    stone = nb.cmul((0.11, 0.10, 0.09), nb.mr(nb.voronoi(sp, 3.2, out="Color"), 0.0, 1.0, 0.7, 1.3))
    wall = nb.cmul(WASH, nb.mr(big, 0.3, 0.7, 0.86, 1.04))
    wall = nb.mixc(nb.mul(joint, 0.45), wall, (0.33, 0.33, 0.31))
    streak = nb.noise(nb.mapping(P, scale=(3.0, 3.0, 0.12)), 1.0, 4.0)
    wall = nb.mixc(nb.mul(nb.mr(streak, 0.55, 0.78), 0.5), wall, (0.30, 0.30, 0.26))
    wall = nb.mixc(flake, wall, stone)
    alg = nb.mul(nb.mr(pz, ground + 0.6, ground), nb.mr(nb.noise(P, 1.2, 3.0), 0.35, 0.6))
    wall = nb.mixc(alg, wall, (0.07, 0.09, 0.05))
    h_wall = nb.add(nb.mul(scell, 0.025), nb.mul(fine, 0.002))

    # slate courses
    srow = nb.comb(px, nb.mul(pz, 1.4), 0.0)
    smort, scol = nb.brick(srow, 1.0, width=0.32, height=0.2, mortar=0.006, smooth=0.0, bias=0.0,
                           c1=(0.05, 0.055, 0.065), c2=(0.035, 0.038, 0.045))
    sc_r, _, _ = nb.sep(nb.voronoi(nb.comb(nb.mul(px, 3.0), nb.mul(pz, 5.0), 0.0), 1.0, out="Color"))
    slate = nb.cmul(scol, nb.mr(sc_r, 0.0, 1.0, 0.75, 1.25, smooth=False))
    moss = nb.mul(nb.mr(nb.noise(P, 2.2, 4.0), 0.62, 0.7), nb.mr(fine, 0.45, 0.6))
    slate = nb.mixc(nb.mul(moss, 0.7), slate, (0.07, 0.075, 0.04))
    slate = nb.mixc(nb.mul(smort, 0.8), slate, (0.01, 0.01, 0.012))
    course = nb.m("FRACT", nb.mul(pz, 1.4 / 0.2))
    h_slate = nb.sub(nb.mul(course, 0.01), nb.mul(smort, 0.004))

    ridge = nb.cmul((0.07, 0.065, 0.06), nb.mr(big, 0.3, 0.7, 0.8, 1.2))
    pot = nb.cmul((0.22, 0.075, 0.035), nb.mr(big, 0.3, 0.7, 0.7, 1.1))
    pot = nb.mixc(nb.mr(pz, ground + 7.4, ground + 7.8), pot, (0.02, 0.018, 0.016))
    frame = nb.cmul((0.62, 0.62, 0.58), nb.mr(fine, 0.3, 0.7, 0.85, 1.05))
    frame = nb.mixc(nb.mr(nb.noise(P, 4.0, 5.0), 0.66, 0.7), frame, (0.1, 0.08, 0.06))
    wood_g = nb.noise(nb.mapping(P, scale=(10.0, 10.0, 0.5)), 3.0, 6.0, 0.6)
    door = nb.cmul((0.012, 0.03, 0.075), nb.mr(wood_g, 0.3, 0.7, 0.7, 1.2))
    door = nb.mixc(nb.mr(nb.noise(P, 3.0, 5.0), 0.63, 0.68), door, (0.09, 0.075, 0.055))
    sill = nb.cmul((0.14, 0.135, 0.125), nb.mr(nb.noise(P, 30.0, 2.0), 0.3, 0.7, 0.7, 1.2))
    iron = nb.mixc(nb.mr(nb.noise(P, 3.0, 5.0), 0.68, 0.76), (0.02, 0.02, 0.022), (0.08, 0.04, 0.02))
    cement = nb.cmul((0.17, 0.17, 0.16), nb.mr(big, 0.3, 0.7, 0.6, 1.1))

    col = nb.by_zone(masks, [wall, slate, ridge, pot, frame, door, sill, iron, cement], "color")
    rough = nb.by_zone(masks, [nb.lerp(flake, 0.4, 0.45), nb.lerp(moss, 0.3, 0.6), 0.35, 0.45, 0.35, 0.35,
                               0.7, 0.5, 0.8])
    metal = nb.by_zone(masks, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.4, 0.0])
    height = nb.by_zone(masks, [h_wall, h_slate, nb.mul(fine, 0.003), nb.mul(fine, 0.002),
                                nb.mul(fine, 0.0008), nb.mul(wood_g, 0.0015), nb.mul(fine, 0.004),
                                0.0, nb.mul(fine, 0.004)])
    return _finish(nb, dict(color=col, rough=rough, metal=metal, height=height))


# ---------------------------------------------------------------- timber, iron and stone props

JT_ZONES = dict(deck=0, pile=1, iron=2, rope=3, crate=4, net=5, beam=6, stone=7, paint=8)


def timber_recipe(name):
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    P = nb.pos()
    px, py, pz = nb.sep(P)
    masks = nb.zone_masks(9)
    fine = nb.noise(P, 9.0, 5.0, 0.6)
    big = nb.noise(P, 0.5, 3.0, 0.5)
    rnd = nb.geo().outputs["Random Per Island"]

    # grain follows the long axis of each part: deck planks run along x,
    # beams along y (Blender), piles along z.
    def grain(scale_vec):
        g = nb.noise(nb.mapping(P, scale=scale_vec), 2.5, 8.0, 0.65, dist=0.3)
        return g

    g_deck = grain((0.35, 9.0, 9.0))
    g_pile = grain((9.0, 9.0, 0.35))
    g_beam = grain((9.0, 0.35, 9.0))

    def timber(g, base, light):
        c = nb.ramp(g, [(0.3, base), (0.7, light)])
        c = nb.cmul(c, nb.mr(rnd, 0.0, 1.0, 0.7, 1.25, smooth=False))
        c = nb.cmul(c, nb.mr(big, 0.3, 0.7, 0.8, 1.15))
        return c

    deck = timber(g_deck, (0.055, 0.047, 0.038), (0.13, 0.115, 0.095))
    deck = nb.mixc(nb.mr(nb.noise(P, 1.5, 3.0), 0.55, 0.7), deck, (0.035, 0.04, 0.025))
    beam = timber(g_beam, (0.04, 0.033, 0.026), (0.09, 0.075, 0.06))
    pile = timber(g_pile, (0.035, 0.03, 0.024), (0.08, 0.068, 0.055))
    algae = nb.mr(pz, 1.3, 0.6)
    pile = nb.mixc(algae, pile, nb.ramp(fine, [(0.4, (0.012, 0.022, 0.01)), (0.6, (0.035, 0.05, 0.02))]))
    barn = nb.mul(nb.mr(nb.voronoi(P, 25.0), 0.3, 0.1), nb.mul(nb.mr(pz, -0.2, 0.2), nb.mr(pz, 0.9, 0.5)))
    pile = nb.mixc(barn, pile, (0.15, 0.145, 0.13))
    beam = nb.mixc(algae, beam, (0.02, 0.03, 0.015))

    rustn = nb.noise(P, 3.0, 6.0, 0.62)
    iron = nb.mixc(nb.mr(rustn, 0.48, 0.6), (0.02, 0.02, 0.022),
                   nb.ramp(fine, [(0.3, (0.09, 0.035, 0.012)), (0.7, (0.2, 0.085, 0.03))]))
    rope_tw = nb.wave(nb.mapping(P, scale=(1, 1, 1)), 2.5, dist=1.0, direction="DIAGONAL", profile="SIN")
    rope = nb.cmul((0.2, 0.16, 0.09), nb.mr(rope_tw, 0.0, 1.0, 0.6, 1.2))
    crate_paint = nb.ramp(rnd, [(0.0, (0.03, 0.08, 0.15)), (0.5, (0.18, 0.05, 0.02)), (1.0, (0.12, 0.1, 0.03))],
                          interp="CONSTANT")
    crate = nb.mixc(nb.mr(nb.noise(P, 4.0, 5.0), 0.5, 0.62), crate_paint, timber(g_deck, (0.06, 0.05, 0.04),
                                                                                     (0.12, 0.1, 0.08)))
    net = nb.cmul((0.015, 0.04, 0.04), nb.mr(fine, 0.3, 0.7, 0.7, 1.3))
    stone = nb.cmul((0.13, 0.125, 0.115), nb.mr(nb.voronoi(P, 40.0, out="Distance"), 0.0, 1.0, 0.7, 1.2))
    stone = nb.cmul(stone, nb.mr(big, 0.3, 0.7, 0.7, 1.15))
    paint = nb.mixc(nb.mr(rustn, 0.6, 0.68), (0.02, 0.021, 0.022), (0.12, 0.05, 0.02))

    col = nb.by_zone(masks, [deck, pile, iron, rope, crate, net, beam, stone, paint], "color")
    rough = nb.by_zone(masks, [nb.lerp(g_deck, 0.42, 0.7), nb.lerp(algae, 0.6, 0.3), 0.7, 0.85, 0.55, 0.6,
                               0.6, 0.75, 0.5])
    metal = nb.by_zone(masks, [0.0, 0.0, nb.lerp(nb.mr(rustn, 0.48, 0.6), 0.6, 0.0), 0.0, 0.0, 0.0, 0.0, 0.0,
                               0.3])
    height = nb.by_zone(masks, [nb.mul(g_deck, 0.004), nb.add(nb.mul(g_pile, 0.004), nb.mul(barn, 0.004)),
                                nb.mul(rustn, 0.0015), nb.mul(rope_tw, 0.006), nb.mul(g_deck, 0.002),
                                nb.mul(fine, 0.002), nb.mul(g_beam, 0.004), nb.mul(fine, 0.006),
                                nb.mul(rustn, 0.001)])
    return _finish(nb, dict(color=col, rough=rough, metal=metal, height=height))


def drystone_recipe(name):
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    P = nb.pos()
    px, py, pz = nb.sep(P)
    nx, ny, nz = nb.sep(nb.normal())
    sp = nb.mapping(P, scale=(1.0, 1.0, 2.0))
    edge = nb.voronoi(sp, 3.0, feature="DISTANCE_TO_EDGE")
    cell = nb.voronoi(sp, 3.0, out="Color")
    cr, cg, cb = nb.sep(cell)
    fine = nb.noise(P, 10.0, 5.0, 0.6)
    gap = nb.mr(edge, 0.05, 0.0)
    stone = nb.ramp(cr, [(0.0, (0.06, 0.058, 0.054)), (0.5, (0.11, 0.105, 0.095)), (1.0, (0.16, 0.15, 0.13))])
    stone = nb.cmul(stone, nb.mr(fine, 0.3, 0.7, 0.8, 1.15))
    lich = nb.mul(nb.mr(nb.noise(P, 2.5, 4.0), 0.58, 0.64), nb.mr(nb.voronoi(P, 9.0), 0.5, 0.2))
    stone = nb.mixc(lich, stone, nb.ramp(cg, [(0.4, (0.3, 0.29, 0.25)), (0.6, (0.32, 0.15, 0.03))]))
    moss = nb.mul(nb.m("MAXIMUM", gap, nb.mr(nz, 0.6, 0.9)), nb.mr(nb.noise(P, 1.2, 3.0), 0.45, 0.6))
    col = nb.mixc(moss, stone, (0.03, 0.045, 0.015))
    col = nb.mixc(nb.mul(gap, 0.85), col, (0.008, 0.008, 0.008))
    rough = nb.lerp(moss, 0.4, 0.7)
    height = nb.add(nb.mul(nb.mr(edge, 0.0, 0.2), 0.03), nb.mul(fine, 0.004))
    return _finish(nb, dict(color=col, rough=rough, metal=0.0, height=height))


# ---------------------------------------------------------------- boat

BT_ZONES = dict(hull=0, sheer=1, rub=2, deck=3, house=4, roof=5, rubber=6, steel=7, net=8, box=9, mast=10)


def boat_recipe(name):
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    P = nb.pos()
    px, py, pz = nb.sep(P)
    masks = nb.zone_masks(11)
    fine = nb.noise(P, 9.0, 5.0, 0.6)
    big = nb.noise(P, 0.8, 3.0, 0.5)
    girth = nb.attr("girth")
    seam = nb.mr(nb.m("PINGPONG", nb.mul(girth, 9.0), 0.5), 0.03, 0.0)
    wear = nb.mr(nb.noise(P, 3.0, 6.0, 0.65), 0.6, 0.66)
    scuff = nb.mul(nb.mr(nb.noise(nb.mapping(P, scale=(1.0, 6.0, 1.0)), 2.0, 4.0), 0.6, 0.7), 1.0)

    hull = nb.cmul((0.008, 0.02, 0.06), nb.mr(big, 0.3, 0.7, 0.8, 1.2))
    anti = nb.mr(pz, 0.08, 0.0)
    hull = nb.mixc(anti, hull, (0.1, 0.025, 0.015))
    boot = nb.mul(nb.mr(pz, 0.075, 0.09), nb.mr(pz, 0.17, 0.155))
    hull = nb.mixc(boot, hull, (0.45, 0.44, 0.41))
    hull = nb.mixc(nb.mul(wear, 0.8), hull, (0.06, 0.055, 0.05))
    hull = nb.mixc(nb.mul(scuff, 0.6), hull, (0.03, 0.035, 0.04))
    hull = nb.mixc(nb.mul(seam, 0.7), hull, (0.004, 0.006, 0.01))
    weed = nb.mul(nb.mr(pz, 0.05, -0.15), nb.mr(nb.noise(P, 2.0, 3.0), 0.4, 0.6))
    hull = nb.mixc(weed, hull, (0.03, 0.05, 0.02))
    rust_tear = nb.mul(nb.mr(nb.noise(nb.mapping(P, scale=(6.0, 6.0, 0.3)), 1.0, 3.0), 0.66, 0.74), 0.8)
    sheer = nb.cmul((0.55, 0.55, 0.52), nb.mr(big, 0.3, 0.7, 0.85, 1.05))
    sheer = nb.mixc(rust_tear, sheer, (0.2, 0.09, 0.04))
    sheer = nb.mixc(nb.mul(wear, 0.7), sheer, (0.08, 0.07, 0.06))
    hull = nb.mixc(nb.mr(girth, 0.828, 0.842, smooth=False), hull, sheer)
    g = nb.noise(nb.mapping(P, scale=(9.0, 0.35, 9.0)), 2.5, 8.0, 0.65)
    rub = nb.ramp(g, [(0.3, (0.05, 0.025, 0.01)), (0.7, (0.12, 0.06, 0.025))])
    deck = nb.cmul((0.06, 0.075, 0.06), nb.mr(big, 0.3, 0.7, 0.7, 1.2))
    deck = nb.mixc(wear, deck, (0.07, 0.055, 0.04))
    house = nb.cmul((0.6, 0.6, 0.57), nb.mr(big, 0.3, 0.7, 0.85, 1.05))
    house = nb.mixc(nb.mul(rust_tear, 0.8), house, (0.22, 0.1, 0.04))
    roof = nb.cmul((0.1, 0.1, 0.1), nb.mr(fine, 0.3, 0.7, 0.8, 1.2))
    rubber = nb.cmul((0.012, 0.012, 0.012), nb.mr(fine, 0.3, 0.7, 0.8, 1.3))
    steel = nb.mixc(nb.mr(fine, 0.5, 0.7), (0.15, 0.15, 0.15), (0.15, 0.06, 0.02))
    net = nb.cmul((0.02, 0.07, 0.04), nb.mr(nb.noise(P, 30.0, 2.0), 0.3, 0.7, 0.6, 1.3))
    box = nb.cmul((0.35, 0.09, 0.015), nb.mr(big, 0.3, 0.7, 0.8, 1.1))
    mast = nb.cmul((0.5, 0.48, 0.44), nb.mr(fine, 0.3, 0.7, 0.85, 1.05))

    col = nb.by_zone(masks, [hull, sheer, rub, deck, house, roof, rubber, steel, net, box, mast], "color")
    rough = nb.by_zone(masks, [nb.lerp(wear, 0.4, 0.75), 0.4, 0.45, 0.7, 0.45, 0.6, 0.8, 0.5, 0.7, 0.5, 0.5])
    metal = nb.by_zone(masks, [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.7, 0.0, 0.0, 0.0])
    height = nb.by_zone(masks, [nb.add(nb.mul(seam, -0.004), nb.mul(fine, 0.0008)), nb.mul(fine, 0.0008),
                                nb.mul(g, 0.002), nb.mul(fine, 0.002), nb.mul(fine, 0.0006), nb.mul(fine, 0.002),
                                nb.mul(fine, 0.002), 0.0, nb.mul(fine, 0.003), nb.mul(fine, 0.001), 0.0])
    return _finish(nb, dict(color=col, rough=rough, metal=metal, height=height))


# ---------------------------------------------------------------- constant materials

def const_material(name, color=(0.5, 0.5, 0.5), rough=0.5, metal=0.0, emission=None, strength=1.0,
                   transmission=0.0, ior=1.5, alpha=1.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    nb = NB(mat)
    out = nb.n("ShaderNodeOutputMaterial")
    bsdf = nb.n("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    bsdf.inputs["IOR"].default_value = ior
    bsdf.inputs["Transmission Weight"].default_value = transmission
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    nb.links.new(bsdf.outputs[0], out.inputs["Surface"])
    if transmission > 0:
        try:
            mat.surface_render_method = "BLENDED"
        except Exception:
            pass
    return mat


# ---------------------------------------------------------------- baking

def _img(name, size, noncolor):
    img = bpy.data.images.get(name)
    if img:
        bpy.data.images.remove(img)
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color" if noncolor else "sRGB"
    return img


def _save(img, tag):
    d = os.path.join(SCRATCH, "tex")
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, tag + ".png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return path


def bake_group(objs, recipe_mat, export_name, size_col, size_orm, size_nrm, samples=4, uv=True,
               nrm_strength=1.0):
    """Bake one procedural material shared by objs into images and swap in a plain export material."""
    return bake_parts(objs, [(recipe_mat, export_name, size_col, size_orm, size_nrm)], samples, uv, nrm_strength)[0]


def uv_per_material(ob):
    """Unwrap each material slot of one object into its own 0..1 UV space."""
    select_only(ob)
    if not ob.data.uv_layers:
        ob.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    for i in range(len(ob.data.materials)):
        bpy.ops.mesh.select_all(action="DESELECT")
        ob.active_material_index = i
        bpy.ops.object.material_slot_select()
        bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.003, area_weight=0.0,
                                 correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_parts(objs, parts, samples=4, uv=True, nrm_strength=1.0):
    """Bake several procedural materials at once. parts: (recipe material, export name, colour size,
    orm size, normal size). With one part, all objs share one UV space; with several parts the objects
    hold one slot per part and each slot gets its own UV space and images."""
    import time
    t0 = time.time()
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = False
    sc.render.bake.margin = 8
    sc.render.bake.use_clear = True
    sc.render.bake.target = "IMAGE_TEXTURES"
    if uv:
        if len(parts) == 1:
            smart_uv(objs)
        else:
            for o in objs:
                uv_per_material(o)
    state = []
    for (rmat, name, s_col, s_orm, s_nrm) in parts:
        nb, d = RECIPES[rmat.name]
        emis = nb.n("ShaderNodeEmission")
        tex = nb.n("ShaderNodeTexImage")
        nb.nodes.active = tex
        state.append(dict(nb=nb, d=d, emis=emis, tex=tex, name=name, sizes=(s_col, s_orm, s_nrm), imgs={}))
    select_only(objs)

    def run(kind, idx, noncolor, bake_type):
        any_part = False
        for st in state:
            size = st["sizes"][idx]
            nb, d = st["nb"], st["d"]
            if not size or (kind == "nrm" and d.get("normal") is None):
                st["tex"].image = _img(st["name"] + "_dummy", 8, True)
                continue
            img = _img(st["name"] + "_" + kind, size, noncolor)
            st["tex"].image = img
            st["imgs"][kind] = img
            any_part = True
            if kind == "col":
                nb.set(st["emis"].inputs["Color"], d["color"])
                nb.links.new(st["emis"].outputs[0], d["out"].inputs["Surface"])
            elif kind == "orm":
                cc = nb.n("ShaderNodeCombineColor")
                cc.inputs["Red"].default_value = 1.0
                nb.set(cc.inputs["Green"], d["rough"])
                nb.set(cc.inputs["Blue"], d.get("metal", 0.0))
                nb.links.new(cc.outputs[0], st["emis"].inputs["Color"])
                nb.links.new(st["emis"].outputs[0], d["out"].inputs["Surface"])
            else:
                nb.links.new(d["bsdf"].outputs[0], d["out"].inputs["Surface"])
        if not any_part:
            return
        if bake_type == "NORMAL":
            bpy.ops.object.bake(type="NORMAL", normal_space="TANGENT")
        else:
            bpy.ops.object.bake(type="EMIT")
        for st in state:
            if kind in st["imgs"]:
                _save(st["imgs"][kind], st["name"] + "_" + kind)

    run("col", 0, False, "EMIT")
    run("orm", 1, True, "EMIT")
    run("nrm", 2, True, "NORMAL")
    mats = []
    for (rmat, *_), st in zip(parts, state):
        mat = export_material(st["name"], st["imgs"]["col"], st["imgs"].get("orm"), st["imgs"].get("nrm"),
                              nrm_strength)
        mats.append(mat)
        for o in objs:
            for i, slot in enumerate(o.data.materials):
                if slot == rmat:
                    o.data.materials[i] = mat
    log("baked", ", ".join(st["name"] for st in state), "in %.0f s" % (time.time() - t0))
    return mats


def export_material(name, img_col, img_orm, img_nrm, nrm_strength=1.0, rough=0.6, metal=0.0):
    old = bpy.data.materials.get(name)
    if old:
        old.name = name + "_old"
    mat = bpy.data.materials.new(name)
    nb = NB(mat)
    out = nb.n("ShaderNodeOutputMaterial")
    bsdf = nb.n("ShaderNodeBsdfPrincipled")
    nb.links.new(bsdf.outputs[0], out.inputs["Surface"])
    tc = nb.n("ShaderNodeTexImage", image=img_col)
    nb.links.new(tc.outputs["Color"], bsdf.inputs["Base Color"])
    if img_orm:
        to = nb.n("ShaderNodeTexImage", image=img_orm)
        sep = nb.n("ShaderNodeSeparateColor")
        nb.links.new(to.outputs["Color"], sep.inputs[0])
        nb.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nb.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
    if img_nrm:
        tn = nb.n("ShaderNodeTexImage", image=img_nrm)
        nm = nb.n("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = nrm_strength
        nb.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nb.links.new(nm.outputs[0], bsdf.inputs["Normal"])
    return mat


def assign_slots(ob, mats):
    """Append materials as slots without touching face material indices."""
    for m in mats:
        ob.data.materials.append(m)


def assign(objs, mat):
    if not isinstance(objs, (list, tuple)):
        objs = [objs]
    for o in objs:
        o.data.materials.clear()
        o.data.materials.append(mat)
