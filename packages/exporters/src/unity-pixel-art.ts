// Unity Editor C# that imports exported PNG textures with Unity's own pixel-art settings: Point filtering, the mip
// policy and uncompressed storage, the TextureImporter equivalent of Godot's "2D Pixel" image import preset.

/** Options for {@link createUnityPixelArtPostprocessor}. */
export interface UnityPixelArtOptions {
  /** Project folder whose textures (and subfolders') get the settings, e.g. 'Assets/Tiles'. */
  folder: string;
  /** 'none' (default): no mip levels; 'nearest': mip levels kept, picked by distance and sampled Point. */
  mipmaps?: 'none' | 'nearest';
  /** C# class name, unique in the project. Default 'PixelArtTextures'. */
  className?: string;
}

/**
 * An `AssetPostprocessor` (save it under an `Editor` folder) that gives every texture imported at or under `folder`
 * Point filtering, the mip policy, no compression, no mip streaming and no power-of-two rescale; wrap is left as the
 * importer sets it. glTF files imported with glTFast take their samplers from the glTF
 * instead (write them with `pixelArt`); this covers the loose PNGs OBJ, DAE and the atlas tools write.
 * @throws TypeError for a folder outside `Assets/` or a class name that is not a C# identifier; RangeError for an
 * unknown `mipmaps` value.
 */
export function createUnityPixelArtPostprocessor(options: UnityPixelArtOptions): string {
  const { folder, mipmaps = 'none', className = 'PixelArtTextures' } = options ?? ({} as UnityPixelArtOptions);
  if (typeof folder !== 'string' || !/^Assets(\/[A-Za-z0-9 _.-]+)*$/.test(folder) || /\/\.\.?(\/|$)/.test(folder))
    throw new TypeError("folder must be a project path under Assets, like 'Assets/Tiles'; pass the export folder");
  if (typeof className !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(className))
    throw new TypeError("className must be a C# identifier; pass a name like 'PixelArtTextures'");
  if (mipmaps !== 'none' && mipmaps !== 'nearest')
    throw new RangeError(`Unity pixel-art mipmaps must be 'none' or 'nearest', not ${String(mipmaps)}`);
  return `using UnityEditor;
using UnityEngine;

// Pixel-art import settings for textures under ${folder}.
public sealed class ${className} : AssetPostprocessor
{
    const string Folder = "${folder}/";

    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith(Folder)) return;
        var importer = (TextureImporter)assetImporter;
        importer.filterMode = FilterMode.Point;
        importer.mipmapEnabled = ${mipmaps === 'nearest'};
        importer.streamingMipmaps = false;
        importer.textureCompression = TextureImporterCompression.Uncompressed;
        importer.compressionQuality = 100;
        importer.crunchedCompression = false;
        importer.npotScale = TextureImporterNPOTScale.None;
        importer.alphaIsTransparency = false;
    }
}
`;
}
