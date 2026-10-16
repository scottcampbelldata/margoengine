'use client';
import { ModelResource, type ModelProps } from './model.js';
export type FbxProps = ModelProps;
/** Native FBX loader with the same ownership, Suspense and event contract as Gltf. */
export function Fbx(props: FbxProps) {
  return <ModelResource {...props} format="fbx" />;
}
