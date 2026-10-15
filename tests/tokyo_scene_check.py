"""Headless scene checks for the Tokyo diorama build (no bake, no export).

Run: blender --background --factory-startup --python-exit-code 1 --python tests/tokyo_scene_check.py
"""
import math
import os
import runpy
import sys

import bmesh
import bpy
from mathutils.bvhtree import BVHTree

os.environ['TD_FAST'] = '1'
HERE = os.path.dirname(os.path.abspath(__file__))
prefs = bpy.context.preferences
before = (prefs.edit.keyframe_new_interpolation_type, prefs.filepaths.save_version)
runpy.run_path(os.path.join(HERE, '..', 'examples', 'assets', 'source', 'tokyo_diorama', 'build.py'), run_name='tokyo_check')['main']()
scene = bpy.data.scenes['Diorama']
failures = []

# User preferences must survive a build (a live MCP build would otherwise change them for every project).
after = (prefs.edit.keyframe_new_interpolation_type, prefs.filepaths.save_version)
if after != before:
    failures.append('preferences changed by the build: %r -> %r' % (before, after))

# Tram heading keys must be continuous: a jump across the +/-pi branch cut spins the tram a full turn.
tram = scene.objects['Tram']
curve = next(c for c in tram.animation_data.action.layers[0].strips[0].channelbags[0].fcurves if c.data_path == 'rotation_euler' and c.array_index == 2) \
    if hasattr(tram.animation_data.action, 'layers') else next(c for c in tram.animation_data.action.fcurves if c.data_path == 'rotation_euler' and c.array_index == 2)
values = [k.co[1] for k in curve.keyframe_points]
jumps = [abs(b - a) for a, b in zip(values, values[1:])]
if max(jumps) > math.pi / 2:
    failures.append('tram heading jumps %.2f rad between keys' % max(jumps))


def world_tree(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bm.transform(ob.matrix_world)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    return tree


def descendants(root):
    return [o for o in root.children_recursive if o.type == 'MESH']


# The cat must not walk through anything: sample the clip, intersect its meshes with every other mesh nearby.
cat_parts = descendants(scene.objects['Cat_1'])
ground = {'Slab', 'Slab_Base', 'Road', 'Sidewalk', 'Curbs', 'Crosswalk', 'Stop_Line', 'Road_Text', 'Lane_Dashes'}
others = [o for o in scene.objects if o.type == 'MESH' and o not in cat_parts and o.name not in ground and not o.name.startswith('Manhole')]
hits = set()
for frame in range(1, 290, 6):
    scene.frame_set(frame)
    cat_trees = [world_tree(o) for o in cat_parts]
    for other in others:
        tree = world_tree(other)
        if any(t.overlap(tree) for t in cat_trees):
            hits.add(other.name)
if hits:
    failures.append('cat intersects: %s' % ', '.join(sorted(hits)))

# The tram's outermost wheels must stay over the rails at both ends of its run.
rails = scene.objects['Track_Rails']
rail_points = [rails.matrix_world @ v.co for v in rails.data.vertices]
for frame in (1, 145):
    scene.frame_set(frame)
    for wheel_x in (0.79, -0.79):
        p = tram.matrix_world @ __import__('mathutils').Vector((wheel_x, 0.29, 0.085))
        nearest = min((p.xy - q.xy).length for q in rail_points)
        if nearest > 0.12:
            failures.append('tram wheel off the rails at frame %d (%.2f m from the nearest rail)' % (frame, nearest))

if failures:
    print('SCENE CHECK FAILED:\n  ' + '\n  '.join(failures))
    sys.exit(1)
print('SCENE CHECK PASSED')
