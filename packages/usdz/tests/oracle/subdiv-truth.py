# Refined points by Blender's Subdivision Surface modifier, an outside tool, for USD meshes read through the public pxr API:
# blender --python subtruth.py -- out.json levels file...   One record per mesh: world-free local points of the refined cage.
import sys, json
import bpy
from pxr import Usd, UsdGeom
argv = sys.argv[sys.argv.index('--') + 1:]
out = {}
levels = int(argv[1])
print('INF', UsdGeom.Mesh.SHARPNESS_INFINITE if hasattr(UsdGeom.Mesh, 'SHARPNESS_INFINITE') else None)
import os
files = [l.strip() for l in open(argv[2][1:], encoding='utf8') if l.strip()] if argv[2].startswith('@') else argv[2:]
for f in files:
    rec = {}
    s = Usd.Stage.Open(f, Usd.Stage.LoadAll)
    for p in Usd.PrimRange.Stage(s, Usd.TraverseInstanceProxies()):
        if not p.IsA(UsdGeom.Mesh): continue
        m = UsdGeom.Mesh(p)
        t = Usd.TimeCode.EarliestTime()
        scheme = m.GetSubdivisionSchemeAttr().Get()
        if scheme != 'catmullClark': continue
        pts = m.GetPointsAttr().Get(t); counts = m.GetFaceVertexCountsAttr().Get(t); idx = m.GetFaceVertexIndicesAttr().Get(t)
        if not pts or len(pts) > 3000 or len(rec) >= 12: continue
        faces = []; at = 0
        for c in counts:
            faces.append(list(idx[at:at + c])); at += c
        me = bpy.data.meshes.new('m')
        me.from_pydata([tuple(q) for q in pts], [], faces)
        me.update(calc_edges=True)
        ci = m.GetCreaseIndicesAttr().Get(t); cl = m.GetCreaseLengthsAttr().Get(t); cs = m.GetCreaseSharpnessesAttr().Get(t)
        if ci and cl:
            attr = me.attributes.new('crease_edge', 'FLOAT', 'EDGE')
            lookup = {tuple(sorted(e.vertices)): e.index for e in me.edges}
            perEdge = len(cs) != len(cl)
            at = 0; edge = 0
            for k, n in enumerate(cl):
                for i in range(n - 1):
                    e = lookup.get(tuple(sorted((ci[at + i], ci[at + i + 1]))))
                    if e is not None:
                        attr.data[e].value = min(1.0, cs[edge if perEdge else k] / 10.0) ** 0.5
                    edge += 1
                at += n
        co = m.GetCornerIndicesAttr().Get(t); cv = m.GetCornerSharpnessesAttr().Get(t)
        if co:
            attr = me.attributes.new('crease_vert', 'FLOAT', 'POINT')
            for i, v in enumerate(co):
                attr.data[v].value = min(1.0, cv[i] / 10.0) ** 0.5
        ob = bpy.data.objects.new('o', me)
        bpy.context.collection.objects.link(ob)
        mod = ob.modifiers.new('s', 'SUBSURF')
        mod.levels = levels; mod.render_levels = levels
        mod.use_limit_surface = False
        mod.use_creases = True
        b = m.GetInterpolateBoundaryAttr().Get(t) or 'edgeAndCorner'
        mod.boundary_smooth = 'PRESERVE_CORNERS' if b == 'edgeAndCorner' else 'ALL'
        dg = bpy.context.evaluated_depsgraph_get()
        ev = ob.evaluated_get(dg).to_mesh()
        rec[str(p.GetPath())] = {'count': len(ev.vertices), 'points': [round(c, 6) for v in ev.vertices for c in v.co], 'boundary': b}
        ob.to_mesh_clear() if hasattr(ob, 'to_mesh_clear') else None
        bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    out[f] = rec
json.dump(out, open(argv[0], 'w'))
print('SUBTRUTH', {k[-40:]: len(v) for k, v in out.items()})
