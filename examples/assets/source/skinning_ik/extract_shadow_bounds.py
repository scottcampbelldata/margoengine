"""Export the original workshop's compact shadow support volume via Blender MCP.

The current saved Light Keeper scene supplies evaluated world geometry; a sampled
sphere includes the interactive arm and held orb's reachable swept volume.
Only temporary in-memory bmesh data and the generated TypeScript file change.
Copyright (c) 2026 Scott Campbell. MIT license.
"""
from pathlib import Path
import bpy
import bmesh
import json
import math
import numpy as np

ROOT = Path(globals().get("PROJECT_ROOT", Path(__file__).resolve().parents[4]))
OUTPUT = ROOT / "examples/skinning-ik/shadow-bounds.ts"


def extract():
    if Path(bpy.data.filepath).stem != "skinning-ik" or bpy.context.scene.frame_current != 1:
        raise ValueError("Open the saved Light Keeper scene at bind frame 1 before extracting shadow bounds")
    depsgraph = bpy.context.evaluated_depsgraph_get()
    unique = {}
    objects = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or obj.name == "Mirror interaction orb":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            coordinates = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
            mesh.vertices.foreach_get("co", coordinates)
            coordinates = coordinates.reshape((-1, 3))
            matrix = np.asarray(evaluated.matrix_world, dtype=np.float64)
            coordinates = coordinates @ matrix[:3, :3].T + matrix[:3, 3]
            coordinates = coordinates[:, [0, 2, 1]] * np.array([1, 1, -1])
            for point in coordinates:
                key = tuple(round(float(value), 6) for value in point)
                unique[key] = [round(float(value), 7) for value in point]
            objects += 1
        finally:
            evaluated.to_mesh_clear()
    center, radius, samples = (-.24, 1.03, 0), .78, 512
    directions = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
    for index in range(samples):
        y = 1 - 2 * (index + .5) / samples
        angle = index * math.pi * (3 - math.sqrt(5))
        ring = math.sqrt(1 - y * y)
        directions.append((math.cos(angle) * ring, y, math.sin(angle) * ring))
    for direction in directions:
        point = [round(center[k] + radius * direction[k], 7) for k in range(3)]
        unique[tuple(point)] = point
    full = list(unique.values())
    mesh = bmesh.new()
    vertices = [mesh.verts.new(point) for point in full]
    mesh.verts.ensure_lookup_table()
    hull = bmesh.ops.convex_hull(mesh, input=vertices, use_existing_faces=False)
    faces = [face for face in hull["geom"] if isinstance(face, bmesh.types.BMFace)]
    hull_vertices = {vertex for face in faces for vertex in face.verts}
    reduced = [full[index] for index in sorted(vertex.index for vertex in hull_vertices)]
    all_points, hull_points = np.array(full), np.array(reduced)
    origin = (all_points.min(axis=0) + all_points.max(axis=0)) * .5
    mesh.normal_update()
    # A sampled sphere is inscribed. Expand the combined hull until each facet
    # contains the analytic sphere, also correcting bmesh's small coplanar tolerance.
    planes = []
    scale = 1.0
    for face in faces:
        normal = np.array(face.normal, dtype=np.float64)
        normal /= np.linalg.norm(normal)
        if np.dot(normal, np.array(face.verts[0].co) - origin) < 0:
            normal *= -1
        distance = float(np.max((hull_points - origin) @ normal))
        required = max(float(np.max((all_points - origin) @ normal)),
                       float(np.dot(np.array(center) - origin, normal)) + radius)
        scale = max(scale, required / distance)
        planes.append((normal, distance))
    scale += .00001  # Less than 20 micrometres of additional numerical guard.
    reduced = np.round(origin + (hull_points - origin) * scale, 7)
    max_scene_outside = max(float(np.max((all_points-origin)@n)) - d*scale for n,d in planes)
    max_sphere_outside = max(float(np.dot(np.array(center)-origin,n)) + radius - d*scale for n,d in planes)
    mesh.free()
    fixed_min, fixed_max = np.array([-1.5, -.27, -1.48]), np.array([1.5, 1.82, 1.53])
    if np.any(reduced.min(axis=0) < fixed_min) or np.any(reduced.max(axis=0) > fixed_max):
        raise ValueError("Conservative shadow hull exceeds the demo's fixed bounds")
    header = ("// Original Light Keeper geometry, evaluated at bind frame 1 in glTF Y-up metres.\n"
              "// Regenerate through Blender MCP with source/skinning_ik/extract_shadow_bounds.py.\n"
              "// Scene convex hull plus a radius .78 arm/orb envelope at [-.24, 1.03, 0].\n"
              "// Facet-tested expansion contains the full analytic sphere, not an inscribed sample.\n"
              "// Separate runtime orb is excluded from scene input; no asset geometry is changed.\n")
    source = header + "export const workshopShadowPoints: readonly (readonly [number, number, number])[] = [\n"
    source += "\n".join("  [" + ", ".join(str(value) for value in point) + "]," for point in reduced.tolist()) + "\n];\n"
    OUTPUT.write_text(source)
    report = {"objects": objects, "inputPoints": len(full), "hullPoints": len(reduced), "conservativeScale": scale,
              "maxSceneOutsideDistance": max_scene_outside, "maxSphereOutsideDistance": max_sphere_outside,
              "min": reduced.min(axis=0).tolist(), "max": reduced.max(axis=0).tolist(),
              "armEnvelopeCenter": center, "armEnvelopeRadius": radius, "sphereDirections": len(directions),
              "blenderFile": bpy.data.filepath, "sceneDirty": bpy.data.is_dirty}
    evidence = ROOT / "test-results/ik/shadow-hull-extraction.json"
    evidence.parent.mkdir(parents=True, exist_ok=True)
    evidence.write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    print(json.dumps(extract(), indent=2))
