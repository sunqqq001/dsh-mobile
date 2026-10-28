import type { ResolvedGatewayConfig } from './config.js'

/**
 * Use the persisted installation identity for an unpinned, automatically identified entry.
 * @param config - Validated gateway configuration containing the legacy identity.
 * @param installationId - Confirmed random identity read from this installation's state.
 * @param explicitIdentity - Whether the operator supplied the gateway identity.
 * @returns Configuration retaining certificate/operator identities or the new and legacy public identities.
 */
export function withInstallationIdentity(
  config: ResolvedGatewayConfig,
  installationId: string,
  explicitIdentity: boolean,
): ResolvedGatewayConfig {
  if (config.pairingCaFile !== undefined || explicitIdentity) return config
  return Object.freeze({ ...config, instanceId: installationId, legacyInstanceId: config.instanceId })
}
