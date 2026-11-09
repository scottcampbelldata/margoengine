/** Fields the view helpers read; a frame `PassContext` satisfies this. An offscreen image pass only has a size. */
export type ViewContext = {
  width: number;
  height: number;
  view?: {
    id: string;
    viewport: readonly [number, number, number, number];
    scissor?: readonly [number, number, number, number];
    index: number;
    layers?: number;
  };
};

export function viewRect(context: ViewContext): readonly [number, number, number, number] | undefined;
export function viewSize(context: ViewContext): [number, number];
export function applyView(pass: GPURenderPassEncoder, context: ViewContext): void;
export function viewLoadOp(context: ViewContext, preferred?: GPULoadOp): GPULoadOp;
export function layerRegistry():
  | { maskOf(mesh: object): number; cameras: WeakMap<object, number>; source: unknown }
  | undefined;
export function meshLayers(mesh: object): number;
export function ownLayers(mesh: object): number | undefined;
export function partialRect(rect: readonly number[] | undefined, width: number, height: number): boolean;
export function validateRectangle(rectangle: readonly number[] | undefined, width: number, height: number): void;
export function checkLayers(mask: number, subject: string): number;
/** `engine` is a core engine (its runtime meshes and store are read); `exclude` its meshes. */
export function withHidden<T>(
  engine: object,
  mask: number,
  exclude: Iterable<object> | undefined,
  run: () => T,
  meshes?: ReadonlyMap<number, object>,
): T;
export function inView(context: { view?: { layers?: number } } | undefined, mesh: object): boolean;
export class ViewStates<State> {
  constructor(create: (context: ViewContext) => State, release?: (state: State) => void);
  get(context: ViewContext): State;
  find(id: string | number): State | undefined;
  values(): IterableIterator<State>;
  drawn(): IterableIterator<State>;
  prune(): void;
  clear(): void;
}
export function toTarget(context: ViewContext, matrix: Float32Array, offset?: number): void;
export function fromTarget(context: ViewContext, matrix: Float32Array, offset?: number): void;
