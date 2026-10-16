"""Check the window grid and real AC casing bounds before the scene merges its static meshes.

Run: blender --background --factory-startup --python-exit-code 1 --python tests/tokyo_window_check.py
"""
import os
import runpy
from collections import defaultdict
from pathlib import Path

import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

os.environ['TD_FAST'] = '1'
root = Path(__file__).resolve().parents[1]
builder = runpy.run_path(str(root / 'examples/assets/source/tokyo_diorama/build.py'), run_name='tokyo_window_check')
facade = builder['facade']
windows = defaultdict(list)
units = []
hosts = []
component_failures = []
original_window, original_ac = facade.window, facade.ac_unit


def record_window(b, m, face, u, v, w, h, style, ac_mount=False):
    if v >= facade.FLOOR0:
        floor = round((v - 0.22 - facade.FLOOR0) / facade.FLOOR) + 1
        windows[b.spec['name'], face, floor].append((u, v, w, h))
        if ac_mount:
            hosts.append((b, face, floor, u, v, w, h))
    return original_window(b, m, face, u, v, w, h, style, ac_mount=ac_mount)


def record_ac(b, face, u, v, floor, scale=facade.AC_SCALE):
    before = {o.name for o in b.parent.children}
    bracket_start = len(b.batches['metal_dark'])
    original_ac(b, face, u, v, floor, scale=scale)
    casing, = [o for o in b.parent.children if o.type == 'MESH' and o.name not in before]
    bpy.context.view_layer.update()
    transform = b.parent.matrix_world.inverted() @ casing.matrix_world
    points = [transform @ Vector(c) for c in casing.bound_box]
    # Project the actual generated mesh back into the face's outside-view coordinates.
    us = [p.x if face == 'front' else -p.x if face == 'back' else b.d / 2 - p.y if face == 'left' else p.y - b.d / 2 for p in points]
    ns = [-p.y if face == 'front' else p.y - b.d if face == 'back' else -p.x - b.w / 2 if face == 'left' else p.x - b.w / 2 for p in points]
    brackets = b.batches['metal_dark'][bracket_start:bracket_start + 2]
    bracket_bottom = min(loc[2] - size[2] / 2 for size, loc in brackets)
    if any(max(size) > 0.18 or min(size) > 0.02 for size, _ in brackets):
        component_failures.append(casing.name + ' retains oversized mounting brackets')
    if any(max(size) > 0.12 for size, _ in b.batches['metal_dark'][bracket_start + 2:]):
        component_failures.append(casing.name + ' retains oversized side vents')
    cap_size = b.batches['paint:#d9d5c9'][-1][0]
    if max(cap_size) > 0.04:
        component_failures.append(casing.name + ' retains an oversized refrigerant cap')
    holder, = [o for o in b.parent.children if o.name not in before and o.type == 'EMPTY']
    if any(max(o.dimensions) > 0.14 for o in holder.children_recursive if o.type == 'MESH'):
        component_failures.append(casing.name + ' retains an oversized fan or grille')
    bounds = (min(us), max(us), min(p.z for p in points), max(p.z for p in points), min(ns), max(ns), bracket_bottom)
    standing = face == b.spec.get('balcony_face', 'front') and floor in b.spec['balcony']
    units.append((casing.name, b.spec['name'], face, floor, standing, bounds))


facade.window, facade.ac_unit = record_window, record_ac
try:
    builder['main']()
finally:
    facade.window, facade.ac_unit = original_window, original_ac

failures = component_failures
for spec in facade.BUILDINGS:
    for face in spec['faces']:
        if facade.clearance(spec, face) < 0.3:
            continue
        reference = None
        for floor in range(1, spec['floors']):
            row = sorted(windows[spec['name'], face, floor])
            label = '%s %s floor %d' % (spec['name'], face, floor)
            if not row:
                failures.append(label + ' has no windows')
                continue
            grid = [(round(u, 6), round(w, 6), round(h, 6)) for u, _, w, h in row]
            if reference is None:
                reference = grid
            elif grid != reference:
                failures.append(label + ' changes its window grid around an AC')
            if any(abs(a[0] + b[0]) > 1e-6 for a, b in zip(row, reversed(row))):
                failures.append(label + ' has an asymmetric window grid')

for name, building, face, floor, standing, (left, right, bottom, top, rear, front, bracket_bottom) in units:
    if any(abs(actual - expected) > 0.001 for actual, expected in zip((right - left, front - rear, top - bottom), (0.242, 0.143, 0.176))):
        failures.append(name + ' is not a compact 0.242 x 0.143 x 0.176 condenser')
    if abs(rear - 0.02) > 0.001:
        failures.append(name + ' has floated away from its wall mounting')
    if standing:
        slab_top = facade.FLOOR0 + facade.FLOOR * (floor - 1) + 0.03
        if abs(bracket_bottom - slab_top) > 0.001:
            failures.append(name + ' has unsupported brackets above its balcony slab')
        continue
    matches = [(u, v, w, h) for u, v, w, h in windows[building, face, floor]
               if left >= u - w / 2 - 0.001 and right <= u + w / 2 + 0.001
               and bottom >= v - 0.001 and top <= v + h + 0.001]
    if len(matches) != 1:
        failures.append(name + ' does not sit inside one complete window')
    else:
        u, v, w, h = matches[0]
        if w - (right - left) < w * 0.5 or v + h - top < h * 0.5:
            failures.append(name + ' hides the visible glazing above or to its right')
        if abs(left - (u - w / 2) - 0.01) > 0.001 or abs(bottom - v - 0.01) > 0.001:
            failures.append(name + ' has moved away from the lower-left window inset')


def material_tree(ob, material_names):
    vertices = [ob.matrix_world @ point.co for point in ob.data.vertices]
    polygons = [tuple(p.vertices) for p in ob.data.polygons if ob.data.materials[p.material_index].name in material_names]
    return BVHTree.FromPolygons(vertices, polygons) if polygons else None


for b, face, floor, u, v, w, h in hosts:
    label = '%s %s floor %d' % (b.spec['name'], face, floor)
    static = bpy.data.scenes['Diorama'].objects[b.spec['name'] + '_Static']
    glass = material_tree(static, {'TD_glass_dark', 'TD_glass_lit', 'TD_shoji_lit'})
    panel = material_tree(static, {'TD_preview_wood_dark'})
    trim_name = 'TD_preview_' + b.spec['trim'].replace(':', '_').replace('#', '')
    frame = material_tree(static, {trim_name})
    concrete = material_tree(static, {'TD_preview_concrete'})
    out = b.parent.matrix_world.to_3x3() @ (Vector(b.pt(face, 0, 1, 0)) - Vector(b.pt(face, 0, 0, 0)))
    out.normalize()
    inverse = b.parent.matrix_world.inverted()
    left, panel_w, panel_h = u - w / 2, 0.282, 0.216

    def ray(tree, uu, vv):
        start = b.parent.matrix_world @ Vector(b.pt(face, uu, 0.4, vv))
        return tree.ray_cast(start, -out, 0.45)[0] if tree is not None else None

    # Inspect the final merged glass geometry, including the full panel area behind the condenser.
    for du in (0.02, panel_w / 2, panel_w - 0.02):
        for dv in (0.02, panel_h / 2, panel_h - 0.02):
            if ray(glass, left + du, v + dv) is not None:
                failures.append(label + ' has glass behind its solid AC mount')
    if ray(glass, u, v + (panel_h + h) / 2) is None or ray(glass, left + (panel_w + w) / 2, v + panel_h / 2) is None:
        failures.append(label + ' has lost its glass above or beside the mount')
    hit = ray(panel, left + panel_w / 2, v + panel_h / 2)
    if hit is None:
        failures.append(label + ' has no solid mounting insert')
    else:
        p = inverse @ hit
        n = -p.y if face == 'front' else p.y - b.d if face == 'back' else -p.x - b.w / 2 if face == 'left' else p.x - b.w / 2
        if abs(n - 0.02) > 0.001:
            failures.append(label + ' mounting insert does not contact the casing rear')
    if ray(frame, left + panel_w, v + panel_h / 2) is None or ray(frame, left + panel_w / 2, v + panel_h) is None:
        failures.append(label + ' has no connected mounting post and rail')
    if ray(frame, left + panel_w / 2, v + panel_h / 2) is not None:
        failures.append(label + ' runs a glazing divider through its solid mounting panel')
    unit = next(item for item in units if item[1:4] == (b.spec['name'], face, floor))
    case_left, case_right, _, _, _, _, bracket_bottom = unit[5]
    start = b.parent.matrix_world @ Vector(b.pt(face, (case_left + case_right) / 2, 0.06, bracket_bottom + 0.1))
    down = (b.parent.matrix_world.to_3x3() @ Vector((0, 0, -1))).normalized()
    hit = concrete.ray_cast(start, down, 0.2)[0] if concrete is not None else None
    if hit is None or abs((inverse @ hit).z - bracket_bottom) > 0.001:
        failures.append(label + ' has no sill support beneath its AC brackets')

if len(hosts) != sum(not unit[4] for unit in units):
    failures.append('not every hanging AC has a divided window and solid mount')

fans = [o for o in bpy.data.scenes['Diorama'].objects if o.name.startswith('AC_Fan_') and o.type == 'EMPTY']
if len(fans) < 8:
    failures.append('only %d animated AC fans remain' % len(fans))
if not any(not unit[4] for unit in units):
    failures.append('no hanging AC units were checked')
if failures:
    raise AssertionError('WINDOW CHECK FAILED:\n  ' + '\n  '.join(failures))
print('WINDOW CHECK PASSED: %d upper windows, %d hanging units, %d balcony units, %d fans' % (
    sum(map(len, windows.values())), sum(not u[4] for u in units), sum(u[4] for u in units), len(fans)))
