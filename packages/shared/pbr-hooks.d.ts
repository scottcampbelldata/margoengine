export interface PBRHooks {
  readonly declarations: string;
  direct?(direct: string): string;
  readonly light?: string;
  readonly ambient?: string;
  readonly coat?: string;
  readonly sheen?: string;
  output?(color: string): string;
}
export function lightPBR(code: string, hooks: PBRHooks): string;
