// The usual React Three Fiber version of this task wraps the scene in the physics library's world component, adds a
// fixed rigid body with a box collider for the floor and a dynamic rigid body holding a mesh and a ball collider that
// falls onto it, and logs when the two first touch. Margo's Physics, RigidBody and colliders come from the optional
// physics entry with the same shape, running Margo's own physics kernel.
import { Canvas, Sun } from '@margoengine/react';
import { Plane, Sphere } from '@margoengine/react/geometry';
import { BallCollider, CuboidCollider, Physics, RigidBody } from '@margoengine/react/physics';

export function Drop() {
  return (
    <Physics gravity={[0, -9.81, 0]}>
      <Sun direction={[3, 5, 4]} intensity={3} />
      <RigidBody type="fixed" colliders={false}>
        <CuboidCollider args={[5, 0.1, 5]} position={[0, -0.1, 0]} />
        <Plane rotation={[-Math.PI / 2, 0, 0]} scale={[10, 10, 1]} />
      </RigidBody>
      <RigidBody position={[0, 4, 0]} colliders={false} onContactStart={(event) => console.log('landed', event.type)}>
        <BallCollider args={[0.5]} />
        <Sphere />
      </RigidBody>
    </Physics>
  );
}

export function App() {
  return (
    <Canvas style={{ height: 400 }} camera={{ position: [0, 3, 8] }}>
      <Drop />
    </Canvas>
  );
}
