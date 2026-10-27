import { ModelResource, type ModelProps } from './model.js';
import { preloadModel, type FormatLoader, type ModelLoader } from './model-assets.js';
import { optionalPeer } from './optional.js';

const loadFBX: FormatLoader = () =>
  optionalPeer('@margoengine/fbx', () => import('@margoengine/fbx')).then(({ loadFBX }) => loadFBX as ModelLoader);
/** Props of the Fbx component; every prop is optional unless noted. */
export type FbxProps = ModelProps;
/** Native FBX loader (`@margoengine/fbx`) with the same ownership, Suspense and event contract as Gltf. */
// A pure Object.assign, not `Component.preload = ...`: a module-level assignment is a side effect that keeps the module
// (and the loaders it imports lazily) in every build that reaches this entry, used or not.
export const Fbx = /* @__PURE__ */ Object.assign(
  function Fbx(props: FbxProps) {
    return <ModelResource {...props} format="fbx" load={loadFBX} />;
  },
  {
    /** Loads `src` into the Canvas cache ahead of the first `<Fbx src>` (queued until a Canvas exists). */
    preload: (src: string): Promise<void> => preloadModel(src, 'fbx', loadFBX),
  },
);
