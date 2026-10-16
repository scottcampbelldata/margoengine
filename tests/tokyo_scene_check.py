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
max_cat_height = 0.0
for frame in range(1, 290, 6):
    scene.frame_set(frame)
    max_cat_height = max(max_cat_height, max((ob.matrix_world @ vertex.co).z for ob in cat_parts for vertex in ob.data.vertices)
                         - scene.objects['Cat_1'].matrix_world.translation.z)
    cat_trees = [world_tree(o) for o in cat_parts]
    for other in others:
        tree = world_tree(other)
        if any(t.overlap(tree) for t in cat_trees):
            hits.add(other.name)
if hits:
    failures.append('cat intersects: %s' % ', '.join(sorted(hits)))
scene.frame_set(1)
bike_top = max((ob.matrix_world @ vertex.co).z for ob in descendants(scene.objects['Bicycle_1']) for vertex in ob.data.vertices)
bike_height = bike_top - scene.objects['Bicycle_1'].matrix_world.translation.z
if max_cat_height >= bike_height * 0.5:
    failures.append('cat is too large beside the bicycle: cat height %.3f, bicycle height %.3f' % (max_cat_height, bike_height))

# Parked bicycles must clear the shop counters, stools and other street furniture. The cat loop above also checks
# the moving cat against them; pulling a bike straight out from the ramen counter would block that walking lane.
scene.frame_set(1)
for bike_name in ('Bicycle_1', 'Bicycle_2'):
    bike_parts = descendants(scene.objects[bike_name])
    obstacles = [o for o in scene.objects if o.type == 'MESH' and o not in bike_parts + cat_parts
                 and o.name not in ground and not o.name.startswith('Manhole')]
    bike_trees = [world_tree(ob) for ob in bike_parts]
    intersections = [ob.name for ob in obstacles if any(tree.overlap(world_tree(ob)) for tree in bike_trees)]
    if intersections:
        failures.append('%s intersects shop or street furniture: %s' % (bike_name, ', '.join(sorted(intersections))))

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

# Street plants must stand clear of the buildings (no trunks through AC units, no canopies through walls).
scene.frame_set(1)
plants = [o for o in scene.objects['Street_Tree'].children_recursive if o.type == 'MESH']
buildings = [o for o in scene.objects if o.type == 'MESH' and o.name.startswith('Building_')]
building_trees = [world_tree(o) for o in buildings]
for plant in plants:
    tree = world_tree(plant)
    hit = [b.name for b, t in zip(buildings, building_trees) if t.overlap(tree)]
    if hit:
        failures.append('%s intersects %s' % (plant.name, ', '.join(hit)))

# Ground contact: nothing floats above or sinks into the surface it stands on.
Vector = __import__('mathutils').Vector


def z_range(ob):
    zs = [(ob.matrix_world @ Vector(c)).z for c in ob.bound_box]
    return min(zs), max(zs)


road_top, side_top = z_range(scene.objects['Road'])[1], z_range(scene.objects['Sidewalk'])[1]
sleepers, rails = scene.objects['Track_Sleepers'], scene.objects['Track_Rails']
if abs(z_range(sleepers)[0] - road_top) > 0.004:
    failures.append('track sleepers float %.3f above the road' % (z_range(sleepers)[0] - road_top))
if abs(z_range(rails)[0] - z_range(sleepers)[1]) > 0.004:
    failures.append('rails sit %.3f off the sleepers' % (z_range(rails)[0] - z_range(sleepers)[1]))
for name in ('Crosswalk', 'Stop_Line', 'Road_Text', 'Lane_Dashes'):
    low = z_range(scene.objects[name])[0]
    if not road_top - 0.001 <= low <= road_top + 0.004:
        failures.append('%s floats %.3f above the road' % (name, low - road_top))
track_trees = [world_tree(sleepers), world_tree(rails)]
for ob in [o for o in scene.objects if o.name.startswith('Manhole_') and o.type == 'MESH' and '_Ribs' not in o.name]:
    if abs(z_range(ob)[0] - road_top) > 0.003:
        failures.append('%s floats %.3f above the road' % (ob.name, z_range(ob)[0] - road_top))
    if any(t.overlap(world_tree(ob)) for t in track_trees):
        failures.append('%s lies under the track' % ob.name)
x0, x1, y0, y1 = -3.3, 4.2, -2.2, 3.4
for ob in [o for o in scene.objects if o.name.startswith('Traffic_Cone_') and o.name.endswith('_Base')]:
    p = ob.matrix_world.translation
    ground = side_top if x0 <= p.x <= x1 and y0 <= p.y <= y1 else road_top
    if abs(z_range(ob)[0] - ground) > 0.004:
        failures.append('%s floats %.3f above the ground' % (ob.name.replace('_Base', ''), z_range(ob)[0] - ground))
# Tram wheels: treads on the rail tops (flanges drop just inside the rail head).
scene.frame_set(1)
rail_top = z_range(rails)[1]
tram_low = min(z_range(o)[0] for o in scene.objects['Tram'].children_recursive if o.type == 'MESH')
if not rail_top - 0.02 <= tram_low <= rail_top - 0.004:
    failures.append('tram wheels are %.3f off the rail tops (flange bottom %.3f, rail top %.3f)' % (tram_low - (rail_top - 0.012), tram_low, rail_top))

# Plants rest on what is under them: pots on the ground, hedge and bush cores on their planters, pots and slabs.
scene.frame_set(1)
supports = bmesh.new()
for ob in scene.objects:
    if ob.type == 'MESH' and not ob.name.endswith('_Leaves'):
        part = bmesh.new()
        part.from_mesh(ob.data)
        part.transform(ob.matrix_world)
        mesh_tmp = bpy.data.meshes.new('_support_tmp')
        part.to_mesh(mesh_tmp)
        part.free()
        supports.from_mesh(mesh_tmp)
        bpy.data.meshes.remove(mesh_tmp)
support_tree = BVHTree.FromBMesh(supports)
supports.free()
for ob in scene.objects:
    if ob.type != 'MESH' or not (ob.name.endswith('_Pot') or (ob.name.endswith('_Core') and ('Hedge' in ob.name or 'Bush' in ob.name))):
        continue
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    low = min(c.z for c in corners)
    centre = sum(corners, Vector()) / 8
    hit = support_tree.ray_cast(Vector((centre.x, centre.y, low - 0.001)), Vector((0, 0, -1)))
    gap = (low - hit[0].z) if hit[0] is not None else float('inf')
    if gap > 0.03:
        failures.append('%s floats %.3f above whatever is under it' % (ob.name, gap))

# AC units hang on wall brackets in open air: nothing (canopy, balcony, neighbouring roof) right under them, and no
# neighbouring building within half a metre in front of the wall they hang on.
building_meshes = [o for o in scene.objects if o.type == 'MESH' and o.name.startswith('Building_')]
statics = [(o, world_tree(o)) for o in building_meshes if o.name.endswith('_Static')]
for i, (a, ta) in enumerate(statics):
    for b, tb in statics[i + 1:]:
        if ta.overlap(tb):
            failures.append('%s and %s intersect (balcony, unit or roof poking into the neighbour)' % (a.name, b.name))
ac_scale = sys.modules['facade'].AC_SCALE
for holder in sorted((o for o in scene.objects if '_AC_Holder_' in o.name), key=lambda o: o.name):
    out = (holder.matrix_world.to_3x3() @ Vector((0, -1, 0))).normalized()
    p = holder.matrix_world.translation
    bracket_bottom = p.z - 0.195 * ac_scale
    hit = support_tree.ray_cast(p - out * (0.13 * ac_scale) - Vector((0, 0, 0.195 * ac_scale - 0.001)), Vector((0, 0, -1)), 0.5)
    if hit[0] is not None and bracket_bottom - hit[0].z > 0.03:  # standing on a balcony slab is fine, hovering is not
        failures.append('%s rests %.2f above something under it' % (holder.name, bracket_bottom - hit[0].z))
    own = holder.name.split('_AC_')[0]
    for other in (o for o in building_meshes if not o.name.startswith(own + '_')):
        if world_tree(other).ray_cast(p - out * (0.27 * ac_scale), out, 0.55)[0] is not None:
            failures.append('%s is buried in or pressed against %s' % (holder.name, other.name))

# Road paint must lie on the asphalt: off the sidewalk block and inside the road edge.
x0, x1, y0, y1 = -3.3, 4.2, -2.2, 3.4
for name in ('Road_Text', 'Crosswalk', 'Stop_Line', 'Lane_Dashes'):
    ob = scene.objects[name]
    corners = [ob.matrix_world @ __import__('mathutils').Vector(c) for c in ob.bound_box]
    lo = [min(c[i] for c in corners) for i in range(2)]
    hi = [max(c[i] for c in corners) for i in range(2)]
    on_block = lo[0] < x1 + 0.05 and hi[0] > x0 - 0.05 and lo[1] < y1 + 0.05 and hi[1] > y0 - 0.05
    off_road = lo[0] < -4.85 or hi[0] > 4.85 or lo[1] < -3.85 or hi[1] > 3.85
    if on_block or off_road:
        failures.append('%s runs off the road: x %.2f..%.2f, y %.2f..%.2f' % (name, lo[0], hi[0], lo[1], hi[1]))

# The stop sign must leave the side door's full approach clear. Inspect disconnected parts of the merged
# street mesh, since the mesh's combined bounding box would also include distant poles and plants.
def component_bounds(ob, relative_to=None):
    transform = ob.matrix_world
    if relative_to is not None:
        transform = relative_to.matrix_world.inverted() @ transform
    neighbours = [[] for _ in ob.data.vertices]
    for edge in ob.data.edges:
        a, b = edge.vertices
        neighbours[a].append(b)
        neighbours[b].append(a)
    remaining = set(range(len(neighbours)))
    bounds = []
    while remaining:
        stack = [remaining.pop()]
        part = []
        while stack:
            index = stack.pop()
            part.append(transform @ ob.data.vertices[index].co)
            for neighbour in neighbours[index]:
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    stack.append(neighbour)
        bounds.append(([min(p[axis] for p in part) for axis in range(3)],
                       [max(p[axis] for p in part) for axis in range(3)]))
    return bounds


street_parts = [bounds for ob in descendants(scene.objects['Street_Life'])
                for bounds in component_bounds(ob)]
# Building_3's right door is centred at local facade u=5% of its 2.2 m side wall; its frame is 0.58 m wide.
door_y = -1.6 + 2.2 / 2 + 2.2 * 0.05
approach_lo, approach_hi = (3.6, door_y - 0.3, side_top + 0.05), (4.2, door_y + 0.3, side_top + 0.9)
for low, high in street_parts:
    if all(low[axis] < approach_hi[axis] and high[axis] > approach_lo[axis] for axis in range(3)):
        failures.append('street furniture blocks Building_3 side doorway: %r..%r' % (low, high))

# The tram-stop seat must sit at doorway scale and have two supports reaching from the pavement to its underside.
stop = scene.objects['Tram_Stop']
bench_parts = [bounds for ob in descendants(stop) for bounds in component_bounds(ob, stop)]


def parts_of_size(size):
    return [(low, high) for low, high in bench_parts
            if all(abs((high[axis] - low[axis]) - size[axis]) < 0.001 for axis in range(3))]


seats = parts_of_size((0.22, 0.7, 0.04))
backs = parts_of_size((0.04, 0.7, 0.22))
legs = parts_of_size((0.035, 0.04, 0.18))
feet = parts_of_size((0.22, 0.07, 0.02))
if len(seats) != 1 or abs(seats[0][0][2] - 0.18) > 0.001 or abs(seats[0][1][2] - 0.22) > 0.001:
    failures.append('tram-stop seat must run from 0.18 to 0.22 m above pavement: %r' % (seats,))
if len(backs) != 1 or abs(backs[0][0][2] - 0.22) > 0.001 or abs(backs[0][1][2] - 0.44) > 0.001:
    failures.append('tram-stop back must rise from the seat to 0.44 m above pavement: %r' % (backs,))
if len(legs) != 2 or any(abs(low[2]) > 0.001 or abs(high[2] - 0.18) > 0.001 for low, high in legs):
    failures.append('tram-stop bench needs two legs from pavement to seat underside: %r' % (legs,))
if len(feet) != 2 or any(abs(low[2]) > 0.001 for low, _ in feet):
    failures.append('tram-stop bench needs two feet resting on pavement: %r' % (feet,))
for low, high in legs + feet:
    centre_y = (low[1] + high[1]) / 2
    if abs(abs(centre_y) - 0.26) > 0.001:
        failures.append('tram-stop bench supports must sit beneath the seat near both ends: %r..%r' % (low, high))

if failures:
    print('SCENE CHECK FAILED:\n  ' + '\n  '.join(failures))
    sys.exit(1)
print('SCENE CHECK PASSED')
