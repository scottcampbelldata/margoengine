import { PbrMaterial, type EngineKernel, type Mesh, type Geometry } from '@margoengine/core';
import { toGeometry, capsuleGeometry, sphereGeometry } from '@margoengine/geometry';

export function createHumanoid(engine: EngineKernel, materials: readonly [PbrMaterial, PbrMaterial, PbrMaterial]) {
  if (
    materials.length !== 3 ||
    !(materials[0] instanceof PbrMaterial) ||
    !(materials[1] instanceof PbrMaterial) ||
    !(materials[2] instanceof PbrMaterial)
  )
    throw new TypeError('Expected three humanoid PBR materials');
  const root = engine.createMesh(),
    focus = engine.createMesh(root),
    joints: Mesh[] = [],
    knees: Mesh[] = [];
  focus.position.y = 1.5;
  const parts: Mesh[] = [];
  const [white, dark, amber] = materials;
  const capsule = toGeometry(capsuleGeometry(1, 1, 4, 10)),
    orb = toGeometry(sphereGeometry(1, 16, 10));
  const part = (
    parent: Mesh,
    geometry: Geometry,
    material: PbrMaterial,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ) => {
    const mesh = engine.createMesh(parent).setGeometry(geometry).setMaterial(material);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    parts.push(mesh);
    return mesh;
  };
  part(root, capsule, white, 0, 1.4, 0, 0.3, 0.32, 0.22);
  part(root, orb, white, 0, 2.03, 0, 0.31, 0.32, 0.29);
  part(root, orb, amber, 0, 2.06, 0.2, 0.26, 0.2, 0.14);
  part(root, capsule, dark, 0, 1.45, -0.22, 0.24, 0.26, 0.12);
  for (let i = 0; i < 4; i++) {
    const leg = i < 2,
      side = i % 2 ? 1 : -1;
    const joint = engine.createMesh(root);
    joint.position.set(side * (leg ? 0.16 : 0.39), leg ? 1.03 : 1.73, 0);
    joints.push(joint);
    part(joint, capsule, leg ? dark : white, 0, -0.23, 0, leg ? 0.105 : 0.085, 0.19, 0.105);
    const knee = engine.createMesh(joint);
    knee.position.y = -0.46;
    knees.push(knee);
    part(knee, capsule, white, 0, -0.21, 0, leg ? 0.105 : 0.075, 0.17, 0.105);
    if (leg) part(knee, orb, dark, 0, -0.42, 0.075, 0.12, 0.095, 0.22);
  }
  return { root, focus, joints, knees, parts };
}

/** Allocation-free walk pose; position is the grounded root, phase/speed come from locomotion. */
export function poseHumanoid(
  rig: ReturnType<typeof createHumanoid>,
  position: ArrayLike<number>,
  heading: number,
  phase: number,
  speed: number,
): void {
  if (
    position.length !== 3 ||
    !Number.isFinite(position[0]) ||
    !Number.isFinite(position[1]) ||
    !Number.isFinite(position[2]) ||
    !Number.isFinite(heading) ||
    !Number.isFinite(phase) ||
    !Number.isFinite(speed) ||
    speed < 0
  )
    throw new RangeError('Invalid humanoid pose');
  rig.root.position.set(position[0], position[1] + Math.sin(phase * 2) * Math.min(0.035, speed * 0.007), position[2]);
  rig.root.rotation.y = heading;
  for (let i = 0; i < 4; i++) {
    const swing = Math.sin(phase + (i % 2 ? Math.PI : 0)) * Math.min(0.65, speed * 0.13);
    rig.joints[i].rotation.x = i < 2 ? swing : -swing;
    rig.knees[i].rotation.x = i < 2 ? Math.max(0, -swing) * 1.2 : -0.18;
  }
}
