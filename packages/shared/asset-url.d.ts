export function assetURL(
  uri: unknown,
  base: string | URL | undefined,
  allowedURLs?: readonly string[],
  label?: string,
): URL;
export function checkRedirect<T extends { url: string; body?: { cancel(): Promise<void> } | null }>(
  response: T,
  base: string | URL | undefined,
  allowedURLs?: readonly string[],
  label?: string,
): T;
