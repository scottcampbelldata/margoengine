# Writes tests/fixtures/arcs/*: a layer with every composition arc and value kind the full reader takes, written by
# OpenUSD itself, as binary and as text, so the two readers are checked against a writer that is not ours.
# Run with OpenUSD's Python, for example inside Blender: blender --background --factory-startup --python generate-arcs.py
import os
from pxr import Gf, Sdf, Usd

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'arcs')
os.makedirs(here, exist_ok=True)
path = os.path.join(here, 'arcs.usdc')
if os.path.exists(path):
    os.remove(path)
layer = Sdf.Layer.CreateNew(path)
stage = Usd.Stage.Open(layer)
layer.subLayerPaths.append('sub.usda')
layer.subLayerOffsets[0] = Sdf.LayerOffset(5, 2)
root = stage.DefinePrim('/X', 'Xform')
root.GetReferences().AddReference('foo.usda', '/P', Sdf.LayerOffset(2, 3))
root.GetPayloads().AddPayload('bar.usda')
root.GetInherits().AddInherit('/Class')
sets = root.GetVariantSets().AddVariantSet('vs')
sets.AddVariant('a')
sets.SetVariantSelection('a')
with sets.GetVariantEditContext():
    stage.DefinePrim('/X/inner', 'Scope')
quat = root.CreateAttribute('tq', Sdf.ValueTypeNames.Quatf)
quat.Set(Gf.Quatf(0.5, 1, 2, 3), 1.0)
quat.Set(Gf.Quatf(1, 0, 0, 0), 2.5)
root.CreateAttribute('rot', Sdf.ValueTypeNames.QuatfArray).Set([Gf.Quatf(0.5, 1, 2, 3)])
vector = root.CreateAttribute('d3', Sdf.ValueTypeNames.Double3)
vector.Set(Gf.Vec3d(1.5, 2.5, 3.5), 3)
vector.Set(Gf.Vec3d(1, 2, 3), 4)
floats = root.CreateAttribute('arr', Sdf.ValueTypeNames.FloatArray)
floats.Set([1.5, 2.5], 1)
floats.Set([3.5], 2)
root.CreateAttribute('blocked', Sdf.ValueTypeNames.Float).Block()
root.CreateAttribute('empty', Sdf.ValueTypeNames.StringArray).Set([])
root.SetCustomData({'a': 1, 'b': {'c': 'd'}})
stage.Save()
with open(os.path.join(here, 'arcs.usda'), 'w', encoding='utf8', newline='\n') as out:
    out.write(Sdf.Layer.FindOrOpen(path).ExportToString().replace('#sdf 1.4.32', '#usda 1.0'))
