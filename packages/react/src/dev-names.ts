/** Set by the devtools entry, so an app without it pays for two empty tests per mesh and nothing more. */
export const ownerHook: {
  capture?: () => string | undefined;
  remember?: (mesh: object, name: string | undefined) => void;
} = {};
