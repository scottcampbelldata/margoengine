export { Vector2 } from './vector2.js';
export { Vector3 } from './vector3.js';
export { Vector4 } from './vector4.js';
export { Quaternion } from './quaternion.js';
export { Euler, degreesToQuaternion, quaternionToDegrees } from './euler.js';
export { Matrix3 } from './matrix3.js';
export { Matrix4 } from './matrix4.js';
export {
  Color,
  hexColor,
  SRGBToLinear,
  LinearToSRGB,
  P3_TO_SRGB,
  SRGB_TO_P3,
  linearP3ToLinearSRGB,
  linearSRGBToLinearP3,
  clipToSRGB,
  gradeSRGB,
} from './color.js';
export type { ColorGrade, ColorLike, HSL } from './color.js';
export { Box3 } from './box3.js';
export { Sphere } from './sphere.js';
export { Plane } from './plane.js';
export { Ray } from './ray.js';
export { Frustum } from './frustum.js';
export { Spherical } from './spherical.js';
export * as MathUtils from './mathutils.js';
export { MargoError, type MargoErrorCode } from './errors.js';
export type {
  Vec2,
  Vec3,
  Vec4,
  Quat,
  MutableVec2,
  MutableVec3,
  Mat4,
  ColorInput,
  HeightField,
  Vec2Like,
  Vec3Like,
  Vec4Like,
  SphereLike,
  PlaneLike,
  BoxLike,
  MatrixLike,
  NumberArray,
  ColorSpace,
  EulerOrder,
  AreaLightShadow,
  RectAreaLight,
} from './types.js';
// meshWorldMatrix lives only in the ./mesh entry: it imports @margoengine/core/extension at runtime.
