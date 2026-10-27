import { forwardRef, useEffect, useRef } from 'react';
import { Mesh, type MeshProps, type MeshRef } from './components.js';
import { useScene, useMesh, report } from './internal.js';
import { ContactGround, type ContactGroundOptions } from './kit-contact.js';
import { loadShadows } from './shadows-loader.js';

interface ErrorProps {
  onError?: (error: unknown) => void;
}

/** Props of the ContactShadows component; every prop is optional unless noted. */
export interface ContactShadowsProps extends MeshProps, ErrorProps, ContactGroundOptions {}
function ContactBinding({ onError, ...options }: ContactGroundOptions & ErrorProps) {
  const scene = useScene(),
    registry = useMesh(),
    latest = useRef({ options, onError });
  latest.current = { options, onError };
  useEffect(() => scene.requestShadows(loadShadows), [scene.requestShadows]);
  useEffect(() => {
    if (!scene.shadows) return;
    const ground = new ContactGround(registry, scene.shadows, () => latest.current.options);
    try {
      scene.engine.use(ground);
    } catch (error) {
      report(scene, error, latest.current.onError);
      return;
    }
    return () => {
      scene.engine.removePlugin(ground.name);
      ground.dispose();
    };
  }, [scene.engine, registry, scene.shadows]);
  return null;
}
/** A transparent ground that draws only the existing shadow map's occlusion. */
export const ContactShadows = forwardRef<MeshRef, ContactShadowsProps>(function ContactShadows(
  { width = 10, height = 10, opacity = 0.5, color = [0, 0, 0], onError, children, ...props },
  ref,
) {
  return (
    <Mesh {...props} ref={ref}>
      <ContactBinding width={width} height={height} opacity={opacity} color={color} onError={onError} />
      {children}
    </Mesh>
  );
});
