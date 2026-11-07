# A stand-in for the reset cases, written by OpenUSD's own API, and what OpenUSD computes for it. None of the 546 real files
# here resets a transform stack. Run: blender --python reset-truth.py -- folder
# Writes reset.usda, reset-part.usda and reset.json into folder: world matrices, visibility and skinned points per time.
import json, os, sys
from pxr import Gf, Sdf, Usd, UsdGeom, UsdLux, UsdSkel, Vt
folder = sys.argv[sys.argv.index('--') + 1]
RESET = '!resetXformStack!'
TRIANGLE = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]

def mesh(stage, path):
    m = UsdGeom.Mesh.Define(stage, path)
    m.CreatePointsAttr(TRIANGLE)
    m.CreateFaceVertexCountsAttr([3])
    m.CreateFaceVertexIndicesAttr([0, 1, 2])
    m.CreateSubdivisionSchemeAttr('none')
    return m

def translate(x, suffix, value):
    op = x.AddTranslateOp(UsdGeom.XformOp.PrecisionDouble, suffix)
    op.Set(Gf.Vec3d(*value))
    return op

def order(x, names):
    x.GetPrim().CreateAttribute('xformOpOrder', Sdf.ValueTypeNames.TokenArray, False, Sdf.VariabilityUniform).Set(names)

part = Usd.Stage.CreateNew(os.path.join(folder, 'reset-part.usda'))
part.SetDefaultPrim(UsdGeom.Xform.Define(part, '/Part').GetPrim())
inside = mesh(part, '/Part/Pinned')
translate(inside, 'at', (0, 5, 0))
inside.SetResetXformStack(True)
part.Save()

stage = Usd.Stage.CreateNew(os.path.join(folder, 'reset.usda'))
UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.z)
UsdGeom.SetStageMetersPerUnit(stage, 0.5)
stage.SetStartTimeCode(0)
stage.SetEndTimeCode(24)
stage.SetTimeCodesPerSecond(24)

# A parent that moves, turns and scales: a reset child must not follow any of it.
world = UsdGeom.Xform.Define(stage, '/World')
move = translate(world, 'at', (10, 0, 0))
move.GetAttr().Clear()
move.Set(Gf.Vec3d(10, 0, 0), 0)
move.Set(Gf.Vec3d(10, 8, 0), 24)
turn = world.AddRotateZOp()
turn.Set(0, 0)
turn.Set(90, 24)
world.AddScaleOp().Set(Gf.Vec3f(2, 2, 2))

translate(mesh(stage, '/World/Follows'), 'at', (1, 0, 0))

first = mesh(stage, '/World/First')
translate(first, 'at', (1, 2, 3))
first.SetResetXformStack(True)
translate(mesh(stage, '/World/First/Kid'), 'at', (0, 1, 0))

late = mesh(stage, '/World/Late')
translate(late, 'ignored', (100, 0, 0))
late.AddScaleOp().Set(Gf.Vec3f(3, 3, 3))
order(late, ['xformOp:translate:ignored', RESET, 'xformOp:scale'])

twice = mesh(stage, '/World/Twice')
translate(twice, 'a', (100, 0, 0))
translate(twice, 'b', (0, 7, 0))
order(twice, [RESET, 'xformOp:translate:a', RESET, 'xformOp:translate:b'])

alone = mesh(stage, '/World/Alone')
order(alone, [RESET])

moving = mesh(stage, '/World/Moving')
op = translate(moving, 'at', (0, 0, 0))
op.GetAttr().Clear()
op.Set(Gf.Vec3d(0, 0, 0), 0)
op.Set(Gf.Vec3d(0, 0, 12), 24)
moving.SetResetXformStack(True)

# An op that moves before the reset is ignored, so nothing here plays.
still = mesh(stage, '/World/Still')
op = translate(still, 'ignored', (0, 0, 0))
op.GetAttr().Clear()
op.Set(Gf.Vec3d(0, 0, 0), 0)
op.Set(Gf.Vec3d(50, 0, 0), 24)
translate(still, 'at', (4, 0, 0))
order(still, ['xformOp:translate:ignored', RESET, 'xformOp:translate:at'])

undone = mesh(stage, '/World/Undone')
translate(undone, 'at', (9, 9, 9))
translate(undone, 'back', (1, 1, 1))
order(undone, [RESET, 'xformOp:translate:at', '!invert!xformOp:translate:back'])

# A reset below a reset, with a plain prim between them.
nested = UsdGeom.Xform.Define(stage, '/World/First/Nested')
translate(nested, 'at', (0, 0, 1))
deep = mesh(stage, '/World/First/Nested/Deep')
translate(deep, 'at', (6, 0, 0))
deep.SetResetXformStack(True)

# A reset that arrives through a reference.
ref = UsdGeom.Xform.Define(stage, '/World/Ref')
translate(ref, 'at', (0, 0, 20))
ref.GetPrim().GetReferences().AddReference('./reset-part.usda')

lamp = UsdLux.SphereLight.Define(stage, '/World/Lamp')
lamp.CreateRadiusAttr(1)
translate(lamp, 'at', (2, 2, 2))
lamp.SetResetXformStack(True)
view = UsdGeom.Camera.Define(stage, '/World/View')
translate(view, 'at', (0, -5, 0))
view.SetResetXformStack(True)

# Visibility: a reset leaves the transform behind, not what hides it.
blink = UsdGeom.Xform.Define(stage, '/Blink')
translate(blink, 'at', (0, 30, 0))
vis = blink.CreateVisibilityAttr()
vis.Set('inherited', 0)
vis.Set('invisible', 8)
vis.Set('inherited', 16)
ward = mesh(stage, '/Blink/Ward')
translate(ward, 'at', (0, 0, 0))
ward.SetResetXformStack(True)
mesh(stage, '/Blink/Ward/Below')
own = mesh(stage, '/Blink/Own')
translate(own, 'at', (1, 1, 1))
own.SetResetXformStack(True)
vis = own.CreateVisibilityAttr()
vis.Set('invisible', 0)
vis.Set('inherited', 12)
# Hidden by its own samples and its parent's in turn, so it is never shown.
never = mesh(stage, '/Blink/Never')
translate(never, 'at', (2, 2, 2))
never.SetResetXformStack(True)
vis = never.CreateVisibilityAttr()
vis.Set('invisible', 0)
vis.Set('inherited', 8)
vis.Set('invisible', 16)

# A rig that resets under the moving parent.
rig = UsdSkel.Root.Define(stage, '/World/Rig')
translate(rig, 'at', (3, 0, 0))
rig.SetResetXformStack(True)
skel = UsdSkel.Skeleton.Define(stage, '/World/Rig/Skel')
skel.CreateJointsAttr(['a', 'a/b'])
one = Gf.Matrix4d(1)
up = Gf.Matrix4d().SetTranslate(Gf.Vec3d(0, 1, 0))
skel.CreateBindTransformsAttr(Vt.Matrix4dArray([one, up]))
skel.CreateRestTransformsAttr(Vt.Matrix4dArray([one, up]))
anim = UsdSkel.Animation.Define(stage, '/World/Rig/Skel/Bend')
anim.CreateJointsAttr(['a', 'a/b'])
anim.CreateTranslationsAttr(Vt.Vec3fArray([Gf.Vec3f(0, 0, 0), Gf.Vec3f(0, 1, 0)]))
anim.CreateScalesAttr(Vt.Vec3hArray([Gf.Vec3h(1, 1, 1), Gf.Vec3h(1, 1, 1)]))
spin = anim.CreateRotationsAttr()
for time, degrees in ((0, 0), (24, 60)):
    q = Gf.Rotation(Gf.Vec3d(0, 0, 1), degrees).GetQuat()
    spin.Set(Vt.QuatfArray([Gf.Quatf(1, 0, 0, 0), Gf.Quatf(q)]), time)
UsdSkel.BindingAPI.Apply(skel.GetPrim()).CreateAnimationSourceRel().SetTargets([anim.GetPath()])
skin = mesh(stage, '/World/Rig/Skin')
skin.GetPointsAttr().Set([(0, 0, 0), (1, 0, 0), (0, 2, 0)])
binding = UsdSkel.BindingAPI.Apply(skin.GetPrim())
binding.CreateSkeletonRel().SetTargets([skel.GetPath()])
binding.CreateJointsAttr(['a', 'a/b'])
binding.CreateJointIndicesPrimvar(False, 1).Set([0, 0, 1])
binding.CreateJointWeightsPrimvar(False, 1).Set([1, 1, 1])
binding.CreateGeomBindTransformAttr(one)
stage.GetRootLayer().Save()

times = [0, 6, 7.5, 8, 12, 13.25, 16, 20, 24]
out = {'tcps': 24, 'start': 0, 'times': times, 'prims': {}, 'skinned': {}, 'resets': []}
for prim in Usd.PrimRange.Stage(stage):
    if not prim.IsA(UsdGeom.Imageable):
        continue
    path = str(prim.GetPath())
    x = UsdGeom.Xformable(prim)
    if x and x.GetResetXformStack():
        out['resets'].append(path)
    entry = {'world': [], 'visible': []}
    image = UsdGeom.Imageable(prim)
    for t in times:
        tc = Usd.TimeCode(t)
        entry['world'].append([v for row in image.ComputeLocalToWorldTransform(tc) for v in row])
        entry['visible'].append(image.ComputeVisibility(tc) != UsdGeom.Tokens.invisible)
    out['prims'][path] = entry

cache = UsdSkel.Cache()
root = UsdSkel.Root(stage.GetPrimAtPath('/World/Rig'))
cache.Populate(root, Usd.PrimDefaultPredicate)
for bound in cache.ComputeSkelBindings(root, Usd.PrimDefaultPredicate):
    bones = cache.GetSkelQuery(bound.GetSkeleton())
    for query in bound.GetSkinningTargets():
        frames = []
        for t in times:
            tc = Usd.TimeCode(t)
            points = Vt.Vec3fArray(UsdGeom.Mesh(query.GetPrim()).GetPointsAttr().Get(tc))
            query.ComputeSkinnedPoints(bones.ComputeSkinningTransforms(tc), points, tc)
            place = UsdGeom.Imageable(bound.GetSkeleton().GetPrim()).ComputeLocalToWorldTransform(tc)
            frames.append([list(place.Transform(Gf.Vec3d(p))) for p in points])
        out['skinned'][str(query.GetPrim().GetPath())] = frames
json.dump(out, open(os.path.join(folder, 'reset.json'), 'w'))
print('RESETTRUTH', len(out['prims']), len(out['resets']))
