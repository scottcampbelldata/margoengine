/** Every binding the declarations make, used in a dead branch (`if(false){...}`), for an entry point's body. */
export function keepBindings(...declarations: (string | undefined)[]): string;
