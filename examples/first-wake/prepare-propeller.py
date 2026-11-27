
"""Rebuild the survey ship's fused screw as a separately riggable Blender propeller."""
import bmesh
import bpy
import math
import sys
from pathlib import Path

source, destination = [Path(arg).resolve() for arg in sys.argv[sys.argv.index('--') + 1:]]
destination.mkdir(parents=True, exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.gltf(filepath=str(source))
hull = next(obj for obj in bpy.context.scene.objects if obj.type == 'MESH')
hull.name = 'Survey ship'
sx, sy, sz = 15.5 / 0.314849853515625, 25.9 / 0.478118896484375, 71.9 / 0.983734130859375

def in_fused_screw(face):
    px, py, pz = face.calc_center_median()
    x, y, z = px * sx, pz * sy - 7.16, -py * sz
    return -29.48 < z < -27.88 and y < -2.8 and math.hypot(x + 0.02, y + 4.63) < 1.86

def cut_fused_screw():
    mesh = bmesh.new()
    mesh.from_mesh(hull.data)
    faces = [face for face in mesh.faces if in_fused_screw(face)]
    if not 300 < len(faces) < 6000:
        raise ValueError('The source does not match the survey ship screw geometry.')
    bmesh.ops.delete(mesh, geom=faces, context='FACES')
    mesh.normal_update()
    mesh.to_mesh(hull.data)
    mesh.free()
    hull.data.update()

def bronze():
    material = bpy.data.materials.new('Cast nickel aluminum bronze')
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (0.36, 0.24, 0.085, 1)
    bsdf.inputs['Metallic'].default_value = 0.76
    bsdf.inputs['Roughness'].default_value = 0.34
    material.diffuse_color = (0.36, 0.24, 0.085, 1)
    return material

def make_screw():
    # Radius, chord, sweep and pitch set the planform. Section dimensions are in metres.
    stations = [
        (0.26, .48, -.14, 52), (.41,.62,-.12,45), (.62,.82,-.062,36),
        (.87,.93,.01,30), (1.10,.90,.11,26), (1.34,.75,.22,22),
        (1.52,.49,.33,18), (1.63,.24,.39,16), (1.68,.052,.425,15),
    ]
    vertices, faces = [], []
    n = 20
    section = [
        ((1 - math.cos(math.pi * j / n)) / 2, side)
        for side, js in ((1, range(n + 1)), (-1, range(n - 1, 0, -1)))
        for j in js
    ]
    width = len(section)

    # Add each twisted blade as a closed surface. The inner station seats inside the boss.
    for blade in range(4):
        angle = blade * math.tau / 4
        ca, sa = math.cos(angle), math.sin(angle)
        base = len(vertices)
        for radius, chord, sweep, pitch in stations:
            beta = math.radians(pitch)
            for u, side in section:
                thick = .62 * (.2969 * math.sqrt(u) - .126 * u - .3516 * u**2 + .2843 * u**3 - .1036 * u**4)
                camber = .03 * 4 * u * (1 - u)
                q = chord * (u - .45)
                nrm = chord * (camber + side * thick)
                tangential = sweep + q * math.cos(beta) - nrm * math.sin(beta)
                axial = q * math.sin(beta) + nrm * math.cos(beta) + .11 * (radius / stations[-1][0])**2
                vertices.append((tangential * ca + radius * sa, -axial, radius * ca - tangential * sa))
        for station in range(len(stations) - 1):
            k = base + station * width
            for j in range(width):
                jn = (j + 1) % width
                faces.append((k+j, k+jn, k+width+jn, k+width+j))
        faces.append(tuple(base + j for j in reversed(range(width))))
        faces.append(tuple(base + (len(stations)-1)*width + j for j in range(width)))

    # The original shaft joins the larger forward rim. The aft end tapers into its retaining cone.
    hub = [(-.62,.135),(-.55,.24),(-.36,.39),(-.20,.48),(.26,.48),(.46,.456),(.64,.422),(.77,.42)]
    n = 64
    base = len(vertices)
    for z, radius in hub:
        for i in range(n):
            a = i * math.tau / n
            vertices.append((radius * math.cos(a), -z, radius * math.sin(a)))
    for ring in range(len(hub) - 1):
        k = base + ring*n
        for i in range(n):
            j = (i + 1) % n
            faces.append((k+i, k+j, k+n+j, k+n+i))
    faces.append(tuple(base+i for i in reversed(range(n))))
    faces.append(tuple(base+(len(hub)-1)*n+i for i in range(n)))

    geom = bpy.data.meshes.new('Swept section and shaft geometry')
    geom.from_pydata(vertices, [], faces)
    geom.update()
    mesh = bmesh.new()
    mesh.from_mesh(geom)
    bmesh.ops.recalc_face_normals(mesh, faces=list(mesh.faces))
    mesh.to_mesh(geom)
    mesh.free()
    for face in geom.polygons:
        face.use_smooth = len(face.vertices) == 4
    screw = bpy.data.objects.new('Four-blade bronze propeller', geom)
    bpy.context.collection.objects.link(screw)
    screw.data.materials.append(bronze())
    return screw

def export(obj, filename):
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(filepath=str(destination / filename), export_format='GLB', use_selection=True)

cut_fused_screw()
export(hull, 'survey-hull.glb')
export(make_screw(), 'survey-screw.glb')

