/** True when the primitive's effective material extension sets `afterOpaque: true`. */
export declare function primitiveAfterOpaque(primitive: {
  extension?: { afterOpaque?: boolean };
  material: { extension?: { afterOpaque?: boolean } };
}): boolean;
