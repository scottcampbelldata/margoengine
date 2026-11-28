import { moireSpacing } from '@margoengine/optics/interference';

export const pitch = .0105;
export const radians = Math.PI / 180;

export const bandSpacing = (degrees) => moireSpacing(pitch, pitch, radians * Math.abs(degrees));
