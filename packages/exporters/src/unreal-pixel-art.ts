// Unreal 5.8 Editor Python that gives imported textures Unreal's own pixel-art settings, which Interchange's glTF
// import does not derive from a NEAREST sampler (it keeps mips, lossy compression and the default texture group).

/** Options for {@link createUnrealPixelArtScript}. */
export interface UnrealPixelArtOptions {
  /** 'none' (default): no mip levels; 'nearest': mip levels kept and sampled nearest, as `pixelArt` writes in glTF. */
  mipmaps?: 'none' | 'nearest';
}

/**
 * Editor Python defining `apply_pixel_art(path)`: every Texture2D at or under the content path `path` (an asset path
 * such as `/Game/Tiles/Atlas` or a folder such as `/Game/Tiles`) gets the "2D Pixels (unfiltered)" texture group,
 * nearest filtering, the mip policy, uncompressed RGBA (UserInterface2D) storage with no lossy compression, and is
 * saved. Every setting is read back; a setting that does not stick raises. Returns the number of textures changed, and
 * logs `PIXEL_ART_PASS <count>`. Run it after an Interchange import, e.g. with `-ExecutePythonScript`.
 * @throws RangeError for a `mipmaps` value other than 'none' or 'nearest'.
 */
export function createUnrealPixelArtScript(options: UnrealPixelArtOptions = {}): string {
  const mipmaps = options?.mipmaps ?? 'none';
  if (mipmaps !== 'none' && mipmaps !== 'nearest')
    throw new RangeError(`Unreal pixel-art mipmaps must be 'none' or 'nearest', not ${String(mipmaps)}`);
  // Simple average keeps the mip chain; TF_NEAREST then samples each level and picks between levels without blending.
  const mip = mipmaps === 'none' ? 'TMGS_NO_MIPMAPS' : 'TMGS_SIMPLE_AVERAGE';
  return `import unreal


def pixel_art_settings():
    return {
        "lod_group": unreal.TextureGroup.TEXTUREGROUP_PIXELS2D,
        "filter": unreal.TextureFilter.TF_NEAREST,
        "mip_gen_settings": unreal.TextureMipGenSettings.${mip},
        "compression_settings": unreal.TextureCompressionSettings.TC_EDITOR_ICON,
        "lossy_compression_amount": unreal.TextureLossyCompressionAmount.TLCA_NONE,
    }


def pixel_art_textures(path):
    library = unreal.EditorAssetLibrary
    if library.does_asset_exist(path):
        asset = library.load_asset(path)
        return [asset] if isinstance(asset, unreal.Texture2D) else []
    found = []
    for name in library.list_assets(path, recursive=True, include_folder=False):
        asset = library.load_asset(name)
        if isinstance(asset, unreal.Texture2D):
            found.append(asset)
    return found


def apply_pixel_art(path):
    textures = pixel_art_textures(path)
    if not textures:
        raise RuntimeError("No Texture2D at or under " + path + "; pass the imported texture or its folder")
    for texture in textures:
        # set_editor_property runs the pre- and post-edit notifications, so each change rebuilds the platform data.
        for name, value in pixel_art_settings().items():
            texture.set_editor_property(name, value)
            if texture.get_editor_property(name) != value:
                raise RuntimeError("Pixel-art setting did not stick: " + texture.get_path_name() + " " + name)
        if not unreal.EditorAssetLibrary.save_loaded_asset(texture, only_if_is_dirty=False):
            raise RuntimeError("Could not save " + texture.get_path_name())
    unreal.log("PIXEL_ART_PASS " + str(len(textures)))
    return len(textures)
`;
}
