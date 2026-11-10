import { useEffect } from 'react';
import type { Texture, TextureOptions, KTX2Transcoder } from '@margoengine/materials';
import { useLoader } from './hooks.js';
import { report, useResourceEffect, useScene } from './internal.js';
import { optionalPeer } from './optional.js';
import { textureLoaders, identity, own } from './texture-cache.js';
export { MappedPbrMaterial, TextureMaterial, TextureProvider } from './texture-material.js';
export type { TextureMaterialProps } from './texture-material.js';
/** URLs accepted by the image and compressed-image hooks. */
export type TextureInput = string | readonly string[] | Readonly<Record<string, string>>;
/** Texture values with the same scalar, tuple or record shape as the input. */
export type TextureResult<T> = T extends string ? Texture : { [K in keyof T]: Texture };
export type { Texture, TextureOptions } from '@margoengine/materials';
function useImages<T extends TextureInput>(input: T, options: TextureOptions, decoder?: KTX2Transcoder | 'auto'): TextureResult<T> {
  const loaders = textureLoaders(useScene().assetCache);
  const urls = typeof input === 'string' ? [input] : Object.values(input);
  const key = JSON.stringify([urls, options, decoder === 'auto' ? 'ktx2' : decoder ? identity(decoder) : null]);
  let loader = loaders.get(key);
  if (!loader) {
    loader = async (_, { engine, fetch, signal }) => {
      const api = await optionalPeer('@margoengine/materials', () => import('@margoengine/materials'));
      const result: Texture[] = [];
      const ownedDecoder = decoder === 'auto' ? new (await optionalPeer('@margoengine/decoders', () => import('@margoengine/decoders'))).KTX2Decoder({ device: engine.gpu ?? undefined }) : undefined;
      const transcoder = ownedDecoder ?? (decoder === 'auto' ? undefined : decoder);
      try {
        for (const url of urls) result.push(await (transcoder ? api.loadKTX2Texture(url, { ...options, decoder: transcoder, fetch, signal }) : api.loadTexture(url, { ...options, fetch, signal })));
        signal.throwIfAborted();
        own(engine, result);
        return result;
      } catch (error) {
        result.forEach((texture) => texture.dispose());
        throw error;
      } finally {
        ownedDecoder?.dispose();
      }
    };
    loaders.set(key, loader);
  }
  const textures = useLoader(loader, key);
  return (typeof input === 'string' ? textures[0] : Array.isArray(input) ? textures : Object.fromEntries(Object.keys(input).map((name, i) => [name, textures[i]]))) as TextureResult<T>;
}
/** Suspense image loading. URL, array and record inputs share resources within a Canvas. Canvas disposal releases them. */
export function useTexture<T extends TextureInput>(input: T, options: TextureOptions = {}): TextureResult<T> {
  return useImages(input, options);
}
/** Suspense KTX2 loading with the caller's device-aware decoder, including custom transcoders. */
export function useKTX2<T extends TextureInput>(input: T, options: TextureOptions & { decoder?: KTX2Transcoder } = {}): TextureResult<T> {
  const { decoder, ...textureOptions } = options;
  return useImages(input, textureOptions, decoder ?? 'auto');
}
/** Video readiness, playback and sampling controls. Defaults match a muted looping inline video. */
export interface VideoTextureOptions extends TextureOptions {
  start?: boolean;
  muted?: boolean;
  loop?: boolean;
  playsInline?: boolean;
  crossOrigin?: string;
  unsuspend?: 'loadedmetadata' | 'loadeddata' | 'canplay' | 'canplaythrough';
  onVideoFrame?: VideoFrameRequestCallback;
}
/** Video URL or MediaStream, suspended until ready. Playback is shared and stopped when its last consumer leaves. */
export function useVideoTexture(src: string | MediaStream, options: VideoTextureOptions = {}): Texture {
  const loaders = textureLoaders(useScene().assetCache);
  const { start = true, muted = true, loop = true, playsInline = true, crossOrigin = 'anonymous', unsuspend = 'loadedmetadata', onVideoFrame, ...textureOptions } = options;
  const key = JSON.stringify(['video', typeof src === 'string' ? src : identity(src), textureOptions, muted, loop, playsInline, crossOrigin, unsuspend]);
  let loader = loaders.get(key);
  if (!loader) {
    loader = async (_, { engine, signal }) => {
      const api = await optionalPeer('@margoengine/materials', () => import('@margoengine/materials'));
      const video = document.createElement('video');
      Object.assign(video, { muted, loop, playsInline, crossOrigin });
      const release = () => { video.pause(); video.srcObject = null; video.removeAttribute('src'); video.load(); };
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { video.removeEventListener(unsuspend, ready); video.removeEventListener('error', failed); signal.removeEventListener('abort', aborted); };
          const ready = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(video.error ?? new TypeError('Video failed to load; check its URL and browser codec support.')); };
          const aborted = () => { cleanup(); reject(signal.reason); };
          signal.throwIfAborted();
          video.addEventListener(unsuspend, ready, { once: true });
          video.addEventListener('error', failed, { once: true });
          signal.addEventListener('abort', aborted, { once: true });
          if (typeof src === 'string') video.src = src;
          else video.srcObject = src;
          video.load();
        });
        signal.throwIfAborted();
        const texture = new api.Texture(video, textureOptions);
        own(engine, [texture], release);
        return [texture];
      } catch (error) { release(); throw error; }
    };
    loaders.set(key, loader);
  }
  const texture = useLoader(loader, key)[0];
  const scene = useScene();
  useResourceEffect((lease) => {
    if (!start) return;
    const video = texture.source as HTMLVideoElement;
    const count = (videoUsers.get(video) ?? 0) + 1;
    videoUsers.set(video, count);
    if (count === 1) void video.play().catch((error) => { if (!lease.closed && !scene.engine.disposed) report(scene, error); });
    return () => {
      const remaining = (videoUsers.get(video) ?? 1) - 1;
      videoUsers.set(video, remaining);
      if (!remaining) video.pause();
    };
  }, [texture, start, scene.engine]);
  useEffect(() => {
    const video = texture.source as HTMLVideoElement;
    if (!onVideoFrame || !video.requestVideoFrameCallback) return;
    let handle: number;
    const update: VideoFrameRequestCallback = (now, metadata) => { onVideoFrame(now, metadata); handle = video.requestVideoFrameCallback(update); };
    handle = video.requestVideoFrameCallback(update);
    return () => video.cancelVideoFrameCallback(handle);
  }, [texture, onVideoFrame]);
  return texture;
}
const videoUsers = new WeakMap<HTMLVideoElement, number>();

