import { forwardRef } from 'react';
import type { Splats, SplatData } from '@margoengine/splats';
import { useLoader, type Loader } from './hooks.js';
import { useCommit, useCreated, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { MargoError } from '@margoengine/math/errors';
import { attachBinding, detachBinding } from './package-binding.js';

const loadSplat: Loader<SplatData> = async (url, { fetch, signal }) => {
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new MargoError(
      'failed',
      `Splat load failed (${response.status}): ${url}; check the URL and server. See https://margoengine.com/errors#failed`,
    );
  const api = await optionalPeer('@margoengine/splats', () => import('@margoengine/splats'));
  return api.parseSplat(await response.arrayBuffer());
};
/** Exactly one native cloud or Suspense-loaded .splat URL, with optional antialiasing. */
export type SplatProps = ({ data: SplatData; src?: never } | { src: string; data?: never }) & {
  /** Mip-Splatting screen-space filter. Default false. */
  antialias?: boolean;
  onError?: (error: unknown) => void;
};
/** A Gaussian cloud from native SplatData or a Suspense-loaded .splat URL. */
export const Splat = forwardRef<Splats, SplatProps>(function Splat(props, ref) {
  // Separate components keep hook order stable when switching between data and a URL.
  return props.src !== undefined ? <SplatURL {...props} ref={ref} /> : <SplatDataBinding {...props} ref={ref} />;
});
const SplatURL = forwardRef<Splats, SplatProps & { src: string }>(function SplatURL({ src, antialias, onError }, ref) {
  const data = useLoader(loadSplat, src);
  return <SplatDataBinding data={data} antialias={antialias} onError={onError} ref={ref} />;
});
const SplatDataBinding = forwardRef<Splats, SplatProps>(function SplatDataBinding(
  { data, antialias = false, onError },
  ref,
) {
  const scene = useScene();
  const cloud = useCreated(
    scene,
    {
      load: () => optionalPeer('@margoengine/splats', () => import('@margoengine/splats')),
      create: (api) => attachBinding(scene, new api.Splats(data!)),
      dispose: (value) => detachBinding(scene, value),
      ref,
      onError,
    },
    [scene.world, data],
  );
  useCommit(() => {
    if (cloud) cloud.antialias = antialias;
  }, [cloud, antialias]);
  return null;
});
