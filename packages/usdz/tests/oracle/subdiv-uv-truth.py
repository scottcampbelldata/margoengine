# Refined corner UVs by Blender's modifier: blender --python subuv.py -- out.json levels file... (first mesh with faceVarying st).
import sys, json
import bpy
from pxr import Usd, UsdGeom
argv = sys.argv[sys.argv.index('--') + 1:]
out = {}
levels = int(argv[1])
MODES = {'none': 'SMOOTH_ALL', 'cornersOnly': 'PRESERVE_CORNERS', 'cornersPlus1': 'PRESERVE_CORNERS_AND_JUNCTIONS', 'cornersPlus2': 'PRESERVE_CORNERS_JUNCTIONS_AND_CONCAVE', 'boundaries': 'PRESERVE_BOUNDARIES', 'all': 'NONE'}
files = [l.strip() for l in open(argv[2][1:], encoding='utf8') if l.strip()] if argv[2].startswith('@') else argv[2:]
for f in files:
    rec = {}
    s = Usd.Stage.Open(f, Usd.Stage.LoadAll)
    for p in Usd.PrimRange.Stage(s, Usd.TraverseInstanceProxies()):
        if not p.IsA(UsdGeom.Mesh) or len(rec) >= 6: continue
        m = UsdGeom.Mesh(p)
        pv = None
        for q in UsdGeom.PrimvarsAPI(p).GetPrimvars():
            if q.GetInterpolation() == 'faceVarying' and q.GetTypeName().type.typeName == 'VtArray<GfVec2f>': pv = q; break
        if not pv or m.GetSubdivisionSchemeAttr().Get() != 'catmullClark': continue
        t = Usd.TimeCode.EarliestTime()
        pts = m.GetPointsAttr().Get(t); counts = m.GetFaceVertexCountsAttr().Get(t); idx = m.GetFaceVertexIndicesAttr().Get(t)
        if len(pts) > 3000: continue
        st = pv.ComputeFlattened(t)
        if not st or not pts or len(st) != len(idx): continue
        name = pv.GetPrimvarName()
        b = m.GetInterpolateBoundaryAttr().Get(t) or 'edgeAndCorner'
        mode = m.GetFaceVaryingLinearInterpolationAttr().Get(t) or 'cornersPlus1'
        ci = m.GetCreaseIndicesAttr().Get(t); cl = m.GetCreaseLengthsAttr().Get(t); cs = m.GetCreaseSharpnessesAttr().Get(t)
        co = m.GetCornerIndicesAttr().Get(t); cv = m.GetCornerSharpnessesAttr().Get(t)
        faces = []; at = 0
        for c in counts:
            faces.append(list(idx[at:at + c])); at += c
        me = bpy.data.meshes.new('m'); me.from_pydata([tuple(q) for q in pts], [], faces); me.update(calc_edges=True)
        uv = me.uv_layers.new(name='st')
        for i, l in enumerate(uv.data): l.uv = tuple(st[i])
        if ci and cl:
            attr = me.attributes.new('crease_edge', 'FLOAT', 'EDGE')
            lookup = {tuple(sorted(e.vertices)): e.index for e in me.edges}
            perEdge = len(cs) != len(cl); at = 0; edge = 0
            for k, n in enumerate(cl):
                for i in range(n - 1):
                    e = lookup.get(tuple(sorted((ci[at + i], ci[at + i + 1]))))
                    if e is not None: attr.data[e].value = min(1.0, cs[edge if perEdge else k] / 10.0) ** 0.5
                    edge += 1
                at += n
        if co:
            attr = me.attributes.new('crease_vert', 'FLOAT', 'POINT')
            for i, v in enumerate(co): attr.data[v].value = min(1.0, cv[i] / 10.0) ** 0.5
        ob = bpy.data.objects.new('o', me); bpy.context.collection.objects.link(ob)
        mod = ob.modifiers.new('s', 'SUBSURF'); mod.levels = levels; mod.use_limit_surface = False
        mod.use_creases = True
        mod.boundary_smooth = 'PRESERVE_CORNERS' if b == 'edgeAndCorner' else 'ALL'
        mod.uv_smooth = MODES[mode]
        ev = ob.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh()
        lay = ev.uv_layers[0].data
        rec[str(p.GetPath()) + '|' + name] = [[round(c, 5) for c in ev.vertices[l.vertex_index].co] + [round(lay[i].uv[0], 6), round(lay[i].uv[1], 6)] for i, l in enumerate(ev.loops)]
        bpy.data.objects.remove(ob); bpy.data.meshes.remove(me)
    if rec:
        with open(argv[0], 'a') as o: o.write(json.dumps({f: rec}) + '\n')
print('SUBUV done')
