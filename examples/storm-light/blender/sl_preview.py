# Preview renders (EEVEE) for checking the assets by eye. Not exported.

import math
import os

import bpy
from mathutils import Vector

from sl_common import E, SCRATCH, link, log


def setup_preview_world(mood="night"):
    sc = bpy.context.scene
    world = bpy.data.worlds.get("Preview") or bpy.data.worlds.new("Preview")
    sc.world = world
    nt = world.node_tree
    if nt is None:
        world.use_nodes = True
        nt = world.node_tree
    bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
    out = nt.nodes.get("World Output") or nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(bg.outputs[0], out.inputs[0])
    for o in [o for o in bpy.data.objects if o.name.startswith("PV_")]:
        bpy.data.objects.remove(o)
    if mood == "night":
        bg.inputs[0].default_value = (0.010, 0.014, 0.024, 1)
        bg.inputs[1].default_value = 1.0
        sun_strength, sun_col = 0.9, (0.62, 0.72, 1.0)
    else:
        bg.inputs[0].default_value = (0.35, 0.38, 0.42, 1)
        bg.inputs[1].default_value = 1.0
        sun_strength, sun_col = 2.5, (1.0, 0.97, 0.92)
    sun = bpy.data.lights.new("PV_moon", "SUN")
    sun.energy = sun_strength
    sun.color = sun_col
    sun.angle = math.radians(2.0)
    so = bpy.data.objects.new("PV_moon", sun)
    so.rotation_euler = (math.radians(52), 0, math.radians(-35))
    link(so)
    # sea plane
    if "PV_sea" not in bpy.data.objects:
        me = bpy.data.meshes.new("PV_sea")
        s = 900
        me.from_pydata([(-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0)], [], [(0, 1, 2, 3)])
        so2 = bpy.data.objects.new("PV_sea", me)
        link(so2)
        m = bpy.data.materials.new("PV_sea")
        m.node_tree.nodes.clear() if m.node_tree else None
        if m.node_tree is None:
            m.use_nodes = True
        nt2 = m.node_tree
        nt2.nodes.clear()
        b = nt2.nodes.new("ShaderNodeBsdfPrincipled")
        o = nt2.nodes.new("ShaderNodeOutputMaterial")
        b.inputs["Base Color"].default_value = (0.006, 0.012, 0.014, 1)
        b.inputs["Roughness"].default_value = 0.12
        b.inputs["Alpha"].default_value = 0.82
        nt2.links.new(b.outputs[0], o.inputs[0])
        m.surface_render_method = "BLENDED"
        me.materials.append(m)
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.exposure = 1.6 if mood == "night" else 0.0
    return sc


def add_point(name, pos_engine, energy, color=(1.0, 0.75, 0.45), radius=0.1):
    L = bpy.data.lights.new("PV_" + name, "POINT")
    L.energy = energy
    L.color = color
    L.shadow_soft_size = radius
    o = bpy.data.objects.new("PV_" + name, L)
    o.location = E(*pos_engine)
    link(o)
    return o


def camera(pos, target, fov=50.0):
    cam = bpy.data.objects.get("PV_cam")
    if cam is None:
        cd = bpy.data.cameras.new("PV_cam")
        cam = bpy.data.objects.new("PV_cam", cd)
        link(cam)
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle_y = math.radians(fov)
    cam.data.clip_start = 0.1
    cam.data.clip_end = 3000
    p = E(*pos)
    t = E(*target)
    cam.location = p
    cam.rotation_euler = (t - p).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def render(name, pos, target, fov=50.0, w=1280, h=720, samples=24):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    try:
        sc.eevee.taa_render_samples = samples
    except Exception:
        pass
    sc.render.resolution_x = w
    sc.render.resolution_y = h
    sc.render.resolution_percentage = 100
    camera(pos, target, fov)
    os.makedirs(SCRATCH, exist_ok=True)
    sc.render.filepath = os.path.join(SCRATCH, name + ".png")
    bpy.ops.render.render(write_still=True)
    log("preview", sc.render.filepath)
