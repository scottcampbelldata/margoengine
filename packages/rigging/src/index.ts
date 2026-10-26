// @margoengine/rigging: skin weights (automatic bone heat, painting), skin checks before export, and rest skeleton
// helpers. Pure data: no engine, renderer or GPU; core is not imported.
export { WeightMap, type VertexInfluences } from './weight-map.js';
export { boneHeatWeights, type BoneHeatOptions } from './heat.js';
export {
  WeightPainter,
  type BrushMode,
  type BrushFalloff,
  type BrushStroke,
  type WeightEdit,
  type WeightPainterOptions,
} from './paint.js';
export {
  checkSkin,
  assertSkin,
  type SkinCheckInput,
  type SkinIssue,
  type SkinIssueCode,
  type SkinReport,
} from './checks.js';
export { checkRig, rigJoints, type RigJoint, type RigPose } from './rig.js';
export type { WeightMesh } from './mesh.js';
