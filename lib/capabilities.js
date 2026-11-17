/**
 * Runtime capability probes for the non-public lifecycle pieces.
 * @module dsh-session-deleater/capabilities
 */

import { getCacheTable } from './cache.js'

/**
 * Probe the services and private fields the Host half may need.
 * @param ctx - Host context.
 * @returns capability flags used by preview/delete/health.
 */
export function probeCapabilities(ctx) {
  const sessions = ctx.get?.('sessions')
  const agents = ctx.get?.('agents')
  const persistence = ctx.get?.('sessionPersistence')
  const workspace = ctx.get?.('workspaceRegistry')
  const schedule = ctx.get?.('schedule')
  const spill = ctx.get?.('spillStore')
  const cacheTable = getCacheTable(ctx)
  const cacheReady = cacheTable !== undefined
    && ['get', 'put', 'delete'].every(name => typeof cacheTable[name] === 'function')
  return {
    sessionsStore: typeof sessions?.store?.get === 'function',
    agentsStore: typeof agents?.store?.get === 'function',
    agentsDetach: typeof agents?.detachEntered === 'function',
    persistenceTracker: typeof persistence?.tracker?.writers?.get === 'function'
      && typeof persistence?.tracker?.openHandles?.[Symbol.iterator] === 'function',
    cacheTable: cacheReady,
    cacheTombstone: cacheReady,
    workspace: typeof workspace?.list === 'function',
    schedule: typeof schedule?.catalog === 'function' && typeof schedule?.edit === 'function',
    spill: typeof spill?.root === 'string',
  }
}

/**
 * Whether the private surface needed for a live session is present.
 * @param capabilities - result of {@link probeCapabilities}.
 * @returns true when hot teardown can proceed.
 */
export function hotCapabilitiesReady(capabilities) {
  return capabilities.sessionsStore
    && capabilities.agentsStore
    && capabilities.agentsDetach
    && capabilities.persistenceTracker
    && capabilities.cacheTable
}
