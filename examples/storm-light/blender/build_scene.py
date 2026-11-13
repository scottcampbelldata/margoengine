# Storm Light: builds the headland, lighthouse, cottage, jetty, props and the
# boat, bakes procedural materials to images and exports glTF for the engine.
#
# Run headless:
#   blender -b --factory-startup -t 4 --python build_scene.py -- [options]
# Options:
#   --quick      smaller textures and coarser meshes (fast check)
#   --no-bake    skip baking (exports flat materials, for layout checks)
#   --preview    render EEVEE preview stills into the scratch folder
#   --no-boat    skip the boat
#   --boat-only  only build and export the boat
#
# Coordinates: the engine is Y up, metres, sea level y = 0. Blender is Z up.
# The glTF exporter (export_yup=True) maps Blender (bx, by, bz) to engine
# (bx, bz, -by), so engine (x, y, z) = Blender (x, -z, y). All layout
# constants in these scripts are written in engine coordinates and passed
# through sl_common.E() when geometry is created. scene.json reports engine
# coordinates.
#
# Outputs (next to this folder, in ../assets):
#   storm-light.glb, boat.glb, headland-height.bin, scene.json
# Scratch files (textures, .blend, previews, logs) go to <repo>/.lane/blender.

import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import bpy  # noqa: E402

import sl_common as C  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
QUICK = "--quick" in ARGS
BAKE = "--no-bake" not in ARGS
PREVIEW = "--preview" in ARGS
BOAT = "--no-boat" not in ARGS
BOAT_ONLY = "--boat-only" in ARGS

JPEG_Q = 75
HERO = dict(position=[55.0, 6.0, 75.0], target=[-4.0, 20.0, 0.0], fov=50.0)


def sz(n):
    return max(256, n // 4) if QUICK else n


def export_glb(path, objs):
    C.select_only(objs)
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=True, export_yup=True, export_apply=True,
        export_materials="EXPORT", export_image_format="JPEG", export_jpeg_quality=JPEG_Q, export_image_quality=JPEG_Q,
        export_cameras=False, export_lights=False, export_texcoords=True, export_normals=True,
        export_tangents=False, export_attributes=False, export_vertex_color="NONE", export_extras=False)
    C.log("exported", path, "%.2f MB" % (os.path.getsize(path) / 1e6))


def parent(child, par):
    child.parent = par
    child.matrix_parent_inverse = par.matrix_world.inverted()


def build_world():
    import sl_buildings as Bd
    import sl_lighthouse as L
    import sl_materials as M
    import sl_terrain as T

    t0 = time.time()
    near, poly = T.build_headland(QUICK)
    far = T.build_far_land(poly, QUICK)
    stacks = T.build_stacks(QUICK)
    ground = T.Ground([near, far, stacks])
    lh = L.build_all()
    cottage, cot_win, windows = Bd.build_cottage()
    wall = Bd.build_compound_wall(ground)
    jetty = Bd.build_jetty(ground)
    ramp = T.ramp_line(poly)
    props, lamp_glass, props_meta = Bd.build_props(ground, ramp)
    C.log("geometry done %.0f s" % (time.time() - t0))

    # materials
    rock = M.rock_recipe("Rock_proc")
    rock_w = M.rock_recipe("RockWest_proc", detail=0.5)
    seabed = M.rock_recipe("Seabed_proc", detail=0.5)
    land = M.rock_recipe("Land_proc", detail=0.5)
    stack_m = M.rock_recipe("Stack_proc")
    lhm = M.lighthouse_recipe("Lighthouse_proc", L.G)
    cot = M.cottage_recipe("Cottage_proc")
    wallm = M.drystone_recipe("Wall_proc")
    jet = M.timber_recipe("Jetty_proc")
    prm = M.timber_recipe("Props_proc")
    M.assign_slots(near, [rock, rock_w, seabed])
    M.assign(far, land)
    M.assign(stacks, stack_m)
    M.assign([lh["Lighthouse"], lh["Gallery"], lh["Lantern"]], lhm)
    M.assign(cottage, cot)
    M.assign(wall, wallm)
    M.assign(jetty, jet)
    M.assign(props, prm)
    glow = M.const_material("WindowGlow", color=(0.9, 0.62, 0.32), rough=0.15, emission=(1.0, 0.62, 0.3),
                            strength=4.0)
    M.assign([cot_win, lamp_glass], glow)
    M.assign(lh["LanternGlass"], M.const_material("LanternGlass", color=(1.0, 1.0, 1.0), rough=0.03,
                                                  transmission=1.0, ior=1.5))
    lens = lh["Lens"]
    lens.data.materials.append(M.const_material("LensGlass", color=(0.98, 0.98, 0.97), rough=0.03, transmission=1.0,
                                                ior=1.52))
    lens.data.materials.append(M.const_material("Brass", color=(0.62, 0.43, 0.16), rough=0.32, metal=1.0))
    M.assign(lh["LampCore"], M.const_material("LampCore", color=(1.0, 0.82, 0.5), rough=0.5,
                                              emission=(1.0, 0.82, 0.5), strength=400.0))

    if BAKE:
        M.bake_parts([near], [(rock, "Rock", sz(3072), sz(1024), sz(2048)),
                              (rock_w, "RockWest", sz(1024), sz(512), sz(512)),
                              (seabed, "Seabed", sz(1024), sz(256), sz(512))], samples=2)
        M.bake_group([far], land, "LandFar", sz(1024), sz(512), sz(512), samples=2)
        M.bake_group([stacks], stack_m, "SeaStacks", sz(1024), sz(512), sz(1024), samples=2)
        M.bake_group([lh["Lighthouse"], lh["Gallery"], lh["Lantern"]], lhm, "Lighthouse", sz(2048), sz(512),
                     sz(2048), samples=4)
        M.bake_group([cottage], cot, "Cottage", sz(1536), sz(512), sz(1024), samples=4)
        M.bake_group([wall], wallm, "Wall", sz(1024), sz(256), sz(512), samples=4)
        M.bake_group([jetty], jet, "Jetty", sz(1024), sz(512), sz(1024), samples=4)
        M.bake_group([props], prm, "Props", sz(1024), sz(256), sz(512), samples=4)
        C.log("bakes done %.0f s" % (time.time() - t0))

    # hierarchy and names the engine looks up
    head = C.empty("Headland")
    parent(near, head)
    parent(far, head)
    parent(cot_win, cottage)
    pr = C.empty("Props")
    for o in (props, wall, lamp_glass):
        parent(o, pr)
    export_objs = [head, near, far, stacks, cottage, cot_win, jetty, pr, props, wall, lamp_glass] + list(lh.values())

    # heightmap
    os.makedirs(C.ASSETS, exist_ok=True)
    T.write_heightmap(os.path.join(C.ASSETS, "headland-height.bin"), ground, poly)

    tris = {o.name: C.tri_count(o) for o in export_objs if o.type == "MESH"}
    meta = dict(
        lamp=L.lamp_position(),
        lighthouseDoor=L.door_position(),
        windows=windows,
        props=props_meta,
        ramp=[[round(p[0], 2), round(p[1], 2), round(p[2], 2)] for p in ramp],
        tris=tris,
        gallery_y=round(L.G + L.FLOOR, 3),
    )
    return export_objs, meta


def build_boat():
    import sl_boat as BT
    import sl_materials as M
    hull, win, light, meta = BT.build_boat()
    bm = M.boat_recipe("Boat_proc")
    M.assign(hull, bm)
    M.assign(win, M.const_material("BoatWindow", color=(0.05, 0.05, 0.05), rough=0.1, emission=(1.0, 0.7, 0.4),
                                   strength=1.2))
    M.assign(light, M.const_material("MastLight", color=(1.0, 0.95, 0.85), rough=0.3, emission=(1.0, 0.95, 0.85),
                                     strength=40.0))
    if BAKE:
        M.bake_group([hull], bm, "Boat", sz(1024), sz(512), sz(1024), samples=4)
    parent(win, hull)
    parent(light, hull)
    meta["tris"] = C.tri_count(hull) + C.tri_count(win) + C.tri_count(light)
    return [hull, win, light], meta


def write_scene_json(meta, boat_meta):
    import sl_terrain as T
    path = os.path.join(C.ASSETS, "scene.json")
    old = {}
    if os.path.exists(path):
        with open(path) as f:
            old = json.load(f)
    data = old
    if meta is not None:
        lamp = meta["lamp"]
        data.update({
            "units": "metres, engine coordinates: Y up, sea level y = 0",
            "file": "storm-light.glb",
            "camera": HERO,
            "lamp": lamp,
            "lens": {"node": "Lens", "center": lamp, "rotationAxis": [0, 1, 0],
                     "beamAxesLocal": [[1, 0, 0], [-1, 0, 0]],
                     "note": "Lens node origin is on the rotation axis at the lamp focus; the two bullseye panels "
                             "face local +x and -x, so rotating the node about Y sweeps two opposite beams."},
            "lampCore": {"node": "LampCore", "center": lamp, "color": [1.0, 0.82, 0.5], "strength": 400,
                         "diameter": 0.35},
            "lighthouse": {"ground": list(T.LIGHTHOUSE), "door": meta["lighthouseDoor"],
                           "galleryFloorY": meta["gallery_y"]},
            "cottage": {"center": list(T.COTTAGE), "size": [2 * T.COTTAGE_HALF[0], 2 * T.COTTAGE_HALF[1]],
                        "door": [T.COTTAGE[0], T.COTTAGE[1] + 1.0, T.COTTAGE[2] + T.COTTAGE_HALF[1]]},
            "windows": meta["windows"],
            "lampPost": meta["props"].get("lampPost"),
            "jetty": {"start": [T.JETTY_X, T.DECK_Y, T.JETTY_Z0], "end": [T.JETTY_X, T.DECK_Y, T.JETTY_Z1],
                      "width": 2.4},
            "jettyEnd": [T.JETTY_X, T.DECK_Y, T.JETTY_Z1],
            "mooring": {"position": [T.JETTY_X + 2.95, 0.0, T.JETTY_Z1 - 7.5], "heading": [0, 0, 1],
                        "note": "boat centre at the waterline, bow toward +z, port side to the jetty"},
            "jettyRamp": meta["ramp"],
            "seaStacks": [{"position": [x, 0.0, z], "top": t, "radius": r} for (x, z, t, r) in T.STACKS],
            "heightmap": {"file": "headland-height.bin", "origin": [-160, -128], "size": [256, 256],
                          "cells": [256, 256],
                          "format": "float32 little-endian, row-major, row = z index, column = x index, "
                                    "cell centre x = -160 + i + 0.5, z = -128 + j + 0.5, value = ground y"},
            "triangles": meta["tris"],
        })
        data["trianglesTotal"] = sum(meta["tris"].values())
    if boat_meta is not None:
        data["boat"] = {"file": "boat.glb", "length": boat_meta["length"], "beam": boat_meta["beam"],
                        "origin": "waterline centre, bow toward +z", "mastLight": boat_meta["mastLight"],
                        "triangles": boat_meta["tris"]}
    with open(path, "w") as f:
        f.write(compact_json(data) + "\n")
    C.log("wrote", path)


def compact_json(data):
    """Indented JSON with short number lists kept on one line."""
    import re
    text = json.dumps(data, indent=2)
    return re.sub(r"\[\s+([-0-9.e,\s]+?)\s+\]", lambda m: "[" + " ".join(m.group(1).split()) + "]", text)


def previews(meta):
    import sl_preview as PV
    PV.setup_preview_world("night")
    PV.add_point("lamp", meta["lamp"], 25000, (1.0, 0.85, 0.6), 0.2)
    for i, w in enumerate(meta["windows"]):
        p = [w["position"][k] + 0.6 * w["normal"][k] for k in range(3)]
        PV.add_point("win%d" % i, p, 120, (1.0, 0.6, 0.3), 0.3)
    if meta["props"].get("lampPost"):
        PV.add_point("post", meta["props"]["lampPost"], 60, (1.0, 0.65, 0.35), 0.1)
    PV.render("hero", HERO["position"], HERO["target"], HERO["fov"])
    PV.render("close_lighthouse", [14, 22, 26], [0, 26, 0], 45)
    PV.render("close_cottage", [-8, 19, 22], [-17, 16.5, 6], 45)
    PV.render("close_jetty", [-6, 6, 44], [-22, 3, 26], 45)
    PV.render("orbit_north", [-30, 40, -110], [-10, 12, 0], 45)
    PV.setup_preview_world("day")
    PV.render("day_hero", HERO["position"], HERO["target"], HERO["fov"])
    PV.render("day_lighthouse", [14, 22, 26], [0, 26, 0], 45)
    PV.render("day_cottage", [-8, 19, 22], [-17, 16.5, 6], 45)
    PV.render("day_jetty", [-6, 6, 44], [-22, 3, 26], 45)
    PV.render("day_west", [60, 40, 10], [-30, 10, 0], 50)


def main():
    t0 = time.time()
    C.reset_scene()
    os.makedirs(C.SCRATCH, exist_ok=True)
    os.makedirs(C.ASSETS, exist_ok=True)
    meta = None
    if not BOAT_ONLY:
        objs, meta = build_world()
        export_glb(os.path.join(C.ASSETS, "storm-light.glb"), objs)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(C.SCRATCH, "storm-light.blend"))
        write_scene_json(meta, None)
        if PREVIEW:
            previews(meta)
    if BOAT or BOAT_ONLY:
        C.reset_scene()
        bobjs, bmeta = build_boat()
        export_glb(os.path.join(C.ASSETS, "boat.glb"), bobjs)
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(C.SCRATCH, "boat.blend"))
        write_scene_json(None, bmeta)
        if PREVIEW:
            import sl_preview as PV
            PV.setup_preview_world("day")
            PV.render("boat_day", [6, 3, 7], [0, 0.8, 0], 40)
            PV.setup_preview_world("night")
            PV.add_point("mast", bmeta["mastLight"], 30, (1, 0.9, 0.7), 0.05)
            PV.render("boat_night", [6, 3, 7], [0, 0.8, 0], 40)
    C.log("all done %.0f s" % (time.time() - t0))


main()
