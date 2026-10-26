'use client';
import { ModelResource, type ModelProps } from './model.js';
/** Props of the Fbx component; every prop is optional unless noted. */
export type FbxProps = ModelProps;
/** Native FBX loader with the same ownership, Suspense and event contract as Gltf. */
export function Fbx(props: FbxProps) {
  return <ModelResource {...props} format="fbx" />;
}
