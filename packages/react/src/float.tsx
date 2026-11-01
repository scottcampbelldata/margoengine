import { forwardRef, useEffect, useRef } from 'react';
import type { FrameCallback } from '@margoengine/core';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { live, useMesh, useScene } from './internal.js';

/** Props of `<Float>`; every prop is optional. */
export interface FloatProps extends MeshProps {
  /** How fast it moves. Default 1. */
  speed?: number;
  /** Multiplies the sway. 0 keeps it level. Default 1. */
  rotationIntensity?: number;
  /** Multiplies the bob. 0 keeps its height. Default 1. */
  floatIntensity?: number;
  /** Lowest and highest offset along Y, in world units. Default [-0.1, 0.1]. */
  floatingRange?: readonly [number, number];
  /** Phase, so several floats move apart. Default 0. */
  seed?: number;
}
type Motion = Required<Pick<FloatProps, 'speed' | 'rotationIntensity' | 'floatIntensity' | 'floatingRange' | 'seed'>>;
function FloatBinding(motion: Motion) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef(motion);
  latest.current = motion;
  useEffect(() => {
    let time = 0;
    const frame: FrameCallback = (_, delta) => {
      const root = live(registry);
      if (!root) return;
      const { speed, rotationIntensity: sway, floatIntensity, floatingRange: range, seed } = latest.current;
      time += delta * speed;
      const slow = time / 4 + seed,
        height = range[0] + ((Math.sin(time + seed) + 1) / 2) * (range[1] - range[0]);
      root.setPosition([0, height * floatIntensity, 0]);
      root.setRotation([(Math.cos(slow) / 8) * sway, (Math.sin(slow) / 8) * sway, (Math.sin(slow) / 20) * sway]);
    };
    scene.frames.callbacks.add(frame);
    return () => {
      scene.frames.callbacks.delete(frame);
    };
  }, [scene, registry]);
  return null;
}
/** A group that bobs and sways gently, on top of its own position and rotation. Needs a running frame loop. */
export const Float = forwardRef<MeshRef, FloatProps>(function Float(
  { speed = 1, rotationIntensity = 1, floatIntensity = 1, floatingRange = [-0.1, 0.1], seed = 0, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <Mesh>
        <FloatBinding
          speed={speed}
          rotationIntensity={rotationIntensity}
          floatIntensity={floatIntensity}
          floatingRange={floatingRange}
          seed={seed}
        />
        {children}
      </Mesh>
    </Mesh>
  );
});
