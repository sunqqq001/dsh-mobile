import { createRequire } from 'node:module'

interface PackageManifest {
  readonly version?: unknown
}

const manifest = createRequire(import.meta.url)('../package.json') as PackageManifest

/** Version of the installed DSH Mobile plugin package. */
export const DSH_MOBILE_VERSION = typeof manifest.version === 'string' ? manifest.version : 'unknown'

/** Oldest Android App release supported by this plugin generation. */
export const MINIMUM_ANDROID_APP_VERSION = '0.2.2'

/** Public gateway metadata format understood by the Android App. */
export const MOBILE_METADATA_VERSION = 1
