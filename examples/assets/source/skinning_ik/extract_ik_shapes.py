"""Refresh exact rigid arm collision hulls from the exported original GLB.

Run through Blender MCP with runpy.run_path(path, run_name="__main__").
Uses temporary in-memory bmesh data; never changes the open Blender scene.
Copyright (c) 2026 Scott Campbell. MIT license.
"""
from pathlib import Path
import bmesh
import bpy
import json
import math
import struct

ROOT = Path(globals().get("PROJECT_ROOT", Path(__file__).resolve().parents[4]))
SOURCE = ROOT / "examples/assets/skinning-ik.glb"
OUTPUT = ROOT / "examples/skinning-ik/body-ik-shapes.ts"


def is_mounted_shoulder_point(point):
    """Only the authored cap, bearing, axle, washers and hubs overlap the torso.

    These reproduce build_robot.py's actual mount primitives in the glTF bind
    frame. A one-micrometre guard absorbs exporter float precision; it does not
    remove the visible upper-arm shaft near the mount.
    """
    shoulder = (-.24, 1.03, 0)
    upper = (-.2, -.19, -.08)
    pole = (.631587009346442, -.38037150225808186, -.6755852055031603)
    tolerance = .000001
    delta = tuple(point[k]-shoulder[k] for k in range(3))
    if math.hypot(*delta) <= .083+tolerance:
        return True
    cap = tuple(shoulder[k]+upper[k]*.12 for k in range(3))
    if sum(((point[k]-cap[k])/(radius+tolerance))**2
           for k,radius in enumerate((.09,.09,.0825))) <= 1:
        return True

    def cylinder(center, radius, half_height):
        offset = tuple(point[k]-center[k] for k in range(3))
        axial = sum(offset[k]*pole[k] for k in range(3))
        radial = math.hypot(*(offset[k]-axial*pole[k] for k in range(3)))
        return abs(axial) <= half_height+tolerance and radial <= radius+tolerance

    if cylinder(shoulder, .0416, .070):
        return True
    for side in (-1,1):
        if cylinder(tuple(shoulder[k]+side*.072*pole[k] for k in range(3)), .080, .007):
            return True
        if cylinder(tuple(shoulder[k]+side*.0835*pole[k] for k in range(3)), .0296, .0035):
            return True
    return False


def native_upper_pieces():
    """Preserve disconnected authored primitives instead of filling their gaps."""
    if Path(bpy.data.filepath).stem != "skinning-ik" or bpy.context.scene.frame_current != 1:
        raise ValueError("Open the matching Light Keeper source at bind frame 1 for loose-component hull extraction")
    pieces, report = [], []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or obj.vertex_groups.get("UpperArm") is None:
            continue
        group = obj.vertex_groups["UpperArm"].index
        parents = list(range(len(obj.data.vertices)))
        def find(index):
            while parents[index] != index:
                parents[index] = parents[parents[index]]
                index = parents[index]
            return index
        for edge in obj.data.edges:
            a, b = (find(index) for index in edge.vertices)
            parents[b] = a
        components = {}
        for vertex in obj.data.vertices:
            components.setdefault(find(vertex.index), []).append(vertex)
        for component, vertices in enumerate(components.values()):
            unique = {}
            for vertex in vertices:
                if not any(weight.group == group and weight.weight > .9999 for weight in vertex.groups):
                    continue
                world = obj.matrix_world @ vertex.co
                point = (world.x, world.z, -world.y)
                if is_mounted_shoulder_point(point):
                    continue
                unique[tuple(round(value, 6) for value in point)] = [round(value, 7) for value in point]
            full = list(unique.values())
            if not full:
                continue
            reduced = full
            if len(full) >= 4:
                mesh = bmesh.new()
                verts = [mesh.verts.new(point) for point in full]
                mesh.verts.ensure_lookup_table()
                hull = bmesh.ops.convex_hull(mesh, input=verts, use_existing_faces=False)
                hull_vertices = {vertex for face in hull["geom"] if isinstance(face,bmesh.types.BMFace) for vertex in face.verts}
                if hull_vertices:
                    reduced = [full[index] for index in sorted(vertex.index for vertex in hull_vertices)]
                mesh.free()
            error = 0
            for index in range(2048):
                y = 1-2*(index+.5)/2048
                angle = index*math.pi*(3-math.sqrt(5))
                ring = math.sqrt(1-y*y)
                direction = (math.cos(angle)*ring,y,math.sin(angle)*ring)
                def support(rows):
                    return max(sum(point[k]*direction[k] for k in range(3)) for point in rows)
                error = max(error,abs(support(full)-support(reduced)))
            if error > 1e-7:
                raise ValueError("Component hull support changed for "+obj.name)
            pieces.append(reduced)
            report.append({"assembly":obj.name,"component":component,"rigidPoints":len(full),"hullPoints":len(reduced),
                           "supportError":error,"min":[min(p[k] for p in full) for k in range(3)],
                           "max":[max(p[k] for p in full) for k in range(3)]})
    if not pieces:
        raise ValueError("No native upper-arm component geometry found")
    return pieces, report


def extract():
    data = SOURCE.read_bytes()
    json_end = 20 + struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:json_end])
    binary = data[json_end + 8:]
    widths = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    formats = {5121: ("B", 1, 255), 5123: ("H", 2, 65535), 5125: ("I", 4, 4294967295), 5126: ("f", 4, None)}

    def accessor(index):
        spec = doc["accessors"][index]
        view = doc["bufferViews"][spec["bufferView"]]
        fmt, size, maximum = formats[spec["componentType"]]
        width = widths[spec["type"]]
        offset = view.get("byteOffset", 0) + spec.get("byteOffset", 0)
        stride = view.get("byteStride", width * size)
        rows = [struct.unpack_from("<" + fmt * width, binary, offset + i * stride) for i in range(spec["count"])]
        if spec.get("normalized") and maximum:
            rows = [tuple(value / maximum for value in row) for row in rows]
        return rows

    joint_names = [doc["nodes"][index]["name"] for index in doc["skins"][0]["joints"]]
    points = {"UpperArm": {}, "Forearm": {}}
    all_upper = {}
    for node in doc["nodes"]:
        if "skin" not in node:
            continue
        if any(key in node for key in ("matrix", "translation", "rotation", "scale")):
            raise ValueError("Expected identity skinned mesh transform: " + node["name"])
        for primitive in doc["meshes"][node["mesh"]]["primitives"]:
            attrs = primitive["attributes"]
            for position, joints, weights in zip(accessor(attrs["POSITION"]), accessor(attrs["JOINTS_0"]), accessor(attrs["WEIGHTS_0"])):
                for joint, weight in zip(joints, weights):
                    name = joint_names[joint]
                    if name not in points or weight < .9999:
                        continue
                    key = tuple(round(value, 6) for value in position)
                    if name == "UpperArm":
                        all_upper[key] = position
                        if is_mounted_shoulder_point(position):
                            continue
                    points[name][key] = [round(value, 7) for value in position]

    report = {}
    blocks = []
    for bone, export_name in (("UpperArm", "upperArmBind"), ("Forearm", "forearmBind")):
        full = list(points[bone].values())
        mesh = bmesh.new()
        vertices = [mesh.verts.new(point) for point in full]
        mesh.verts.ensure_lookup_table()
        hull = bmesh.ops.convex_hull(mesh, input=vertices, use_existing_faces=False)
        hull_vertices = {vertex for face in hull["geom"] if isinstance(face, bmesh.types.BMFace) for vertex in face.verts}
        reduced = [full[index] for index in sorted(vertex.index for vertex in hull_vertices)]
        mesh.free()
        error = 0
        for index in range(2048):
            y = 1 - 2 * (index + .5) / 2048
            angle = index * math.pi * (3 - math.sqrt(5))
            radius = math.sqrt(1 - y * y)
            direction = (math.cos(angle) * radius, y, math.sin(angle) * radius)
            def support(rows):
                return max(sum(point[k] * direction[k] for k in range(3)) for point in rows)
            error = max(error, abs(support(full) - support(reduced)))
        if error > 1e-7:
            raise ValueError("Convex support changed for " + bone)
        blocks.append("export const " + export_name + ": readonly (readonly [number, number, number])[] = [\n" +
                      "\n".join("  [" + ", ".join(str(value) for value in point) + "]," for point in reduced) + "\n];\n")
        report[bone] = {"rigidPoints": len(full), "hullPoints": len(reduced), "supportError": error}
    header = ("// Original Light Keeper GLB rest geometry; regenerate with source/skinning_ik/extract_ik_shapes.py.\n"
              "// Coordinates are metres in the model's glTF Y-up bind frame.\n"
              "// UpperArm excludes the actual cap/bearing/washer/axle/hub union (1um float guard).\n"
              "// The visible proximal shaft is retained; no broad shoulder-radius exemption.\n"
              "// Exact convex-hull vertices from Blender bmesh; no collision-width approximation.\n")
    pieces, component_report = native_upper_pieces()
    piece_source = "// Separate authored convex pieces avoid filling the space between armor and pistons.\n"
    piece_source += "export const upperArmPieces: readonly (readonly (readonly [number, number, number])[])[] = [\n"
    for piece in pieces:
        piece_source += "  [\n" + "\n".join("    ["+", ".join(str(value) for value in point)+"]," for point in piece) + "\n  ],\n"
    piece_source += "];\n"
    OUTPUT.write_text(header + "".join(blocks) + piece_source)
    report["upperArmPieces"] = component_report
    legacy = sum(math.dist(point,(-.24,1.03,0))>.145 for point in all_upper.values())
    report["mountAudit"] = {"allRigidUpperPoints":len(all_upper), "outsideLegacySphere":legacy,
                            "outsideAuthoredMountUnion":len(points["UpperArm"]),
                            "restoredShaftPoints":len(points["UpperArm"])-legacy,
                            "mountToleranceMetres":.000001}
    return report


if __name__ == "__main__":
    print(json.dumps(extract(), indent=2))
