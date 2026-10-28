/** Maximum sizes accepted for legacy mobile customization resources. */
export const LEGACY_CUSTOM_ASSET_LIMIT = 256 * 1024

/** Maximum sizes enforced when reading local extension files. */
export const EXTENSION_LIMITS = Object.freeze({
  manifest: 64 * 1024,
  script: 1024 * 1024,
  css: 512 * 1024,
  asset: 8 * 1024 * 1024,
  assetFiles: 256,
  assetBytes: 32 * 1024 * 1024,
  assetDepth: 8,
})
