// Shared lifecycle for optional annotation controllers and portable figure restoration.
export const annotationControllers = new WeakMap<object, { dispose(): void }>();
