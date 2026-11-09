import type { Camera } from '@margoengine/core/extension';
export const temporalCameraSource: unique symbol;
export function unjitteredCamera<T extends Camera>(camera: T): T;
