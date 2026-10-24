"""Independent package, topology and material checks using the official usd-core wheel."""
import sys
if len(sys.argv) > 2:
    sys.path.insert(0, sys.argv[2])
from pxr import Usd, UsdGeom, UsdShade, UsdValidation

path = sys.argv[1]
stage = Usd.Stage.Open(path)
assert stage and stage.GetDefaultPrim(), "USDZ must open with a default prim"
assert UsdGeom.GetStageUpAxis(stage) == "Y"
assert UsdGeom.GetStageMetersPerUnit(stage) == 1
meshes = [UsdGeom.Mesh(prim) for prim in stage.Traverse() if prim.IsA(UsdGeom.Mesh)]
assert meshes, "USDZ must contain mesh geometry"
for mesh in meshes:
    assert UsdGeom.Mesh.ValidateTopology(mesh.GetFaceVertexIndicesAttr().Get(), mesh.GetFaceVertexCountsAttr().Get(), len(mesh.GetPointsAttr().Get()))[0]
    color = UsdGeom.PrimvarsAPI(mesh).GetPrimvar("displayColor")
    if color.GetInterpolation() == "vertex":
        assert len(color.ComputeFlattened()) == len(mesh.GetPointsAttr().Get())
        material, _ = UsdShade.MaterialBindingAPI(mesh).ComputeBoundMaterial()
        surface = material.ComputeSurfaceSource()[0]
        reader, output, _ = surface.GetInput("diffuseColor").GetConnectedSource()
        assert output == "result"
        shader = UsdShade.Shader(reader.GetPrim())
        assert shader.GetIdAttr().Get() == "UsdPrimvarReader_float3"
        assert shader.GetInput("varname").Get() == "displayColor"
        opacity = UsdGeom.PrimvarsAPI(mesh).GetPrimvar("displayOpacity")
        if opacity.GetAttr().HasAuthoredValueOpinion():
            assert opacity.GetInterpolation() == "vertex"
            assert len(opacity.ComputeFlattened()) == len(color.ComputeFlattened())
            reader, output, _ = surface.GetInput("opacity").GetConnectedSource()
            assert output == "result"
            shader = UsdShade.Shader(reader.GetPrim())
            assert shader.GetIdAttr().Get() == "UsdPrimvarReader_float"
            assert shader.GetInput("varname").Get() == "displayOpacity"
registry = UsdValidation.ValidationRegistry()
validators = registry.GetOrLoadAllValidators()
context = UsdValidation.ValidationContext(validators)
issues = context.Validate(stage)
assert not issues, [issue.GetMessage() for issue in issues]
print(f"OpenUSD {'.'.join(map(str, Usd.GetVersion()))} validation passed: {len(meshes)} mesh(es), {len(validators)} validators")
