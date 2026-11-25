import { MargoError } from '@margoengine/math/errors';
export const FONT_HELP = 'https://margoengine.com/llms/packages/text.md';
export function fontError(detail: string): never {
  throw new MargoError('failed', `OpenType font ${detail}; provide valid supported font bytes. Help: ${FONT_HELP}`);
}
