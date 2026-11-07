export interface PBRHooks {
  readonly declarations: string;
  direct?(direct: string, normal?: string): string;
  readonly light?: string;
  readonly ambient?: string;
  readonly coat?: string;
  readonly sheen?: string;
  output?(color: string): string;
}
/** Declared by a shader whose coat layer adds directional light after the sum: what the `direct` hook lets through. */
export const directVisibility: string;
export function lightPBR(code: string, hooks: PBRHooks): string;
