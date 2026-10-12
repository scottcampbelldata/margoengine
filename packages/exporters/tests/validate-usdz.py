"""Independent package, topology and material checks using the official usd-core wheel."""
import sys
if len(sys.argv) > 2:
    sys.path.insert(0, sys.argv[2])
from pxr import Usd, UsdGeom, UsdValidation

path = sys.argv[1]
stage = Usd.Stage.Open(path)
assert stage and stage.GetDefaultPrim(), "USDZ must open with a default prim"
assert UsdGeom.GetStageUpAxis(stage) == "Y"
assert UsdGeom.GetStageMetersPerUnit(stage) == 1
meshes = [UsdGeom.Mesh(prim) for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)]
assert meshes, "USDZ must contain mesh geometry"
for mesh in meshes:
    assert UsdGeom.Mesh.ValidateTopology(mesh.GetFaceVertexIndicesAttr().Get(), mesh.GetFaceVertexCountsAttr().Get(), len(mesh.GetPointsAttr().Get()))[0]
registry = UsdValidation.ValidationRegistry()
context = UsdValidation.ValidationContext(registry.GetOrLoadAllValidators())
issues = context.Validate(stage)
assert not issues, [issue.GetMessage() for issue in issues]
print(f"OpenUSD validation passed: {len(meshes)} mesh(es)")
