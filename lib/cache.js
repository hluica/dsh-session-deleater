/**
 * Projection-cache deletion helpers.
 *
 * The cache has no public delete API. We access its table through the owning
 * service (or the storage-domain diagnostic handle), install a short-lived
 * lifecycle tombstone before detaching a live session, and remove the row after
 * the log directory is committed away.
 *
 * @module dsh-session-deleater/cache
 */

import * as fs from 'node:fs/promises'
import { join } from 'node:path'

import { lifecycleKey } from './ids.js'
import { exists, fsyncDir, removePath } from './fsx.js'

/** Per-table tombstone state shared by every deletion in this process. */
const guards = new WeakMap()

/** How long a successfully deleted lifecycle remains blocked from cache writes. */
const TOMBSTONE_TTL_MS = 10 * 60 * 1000

/**
 * Locate the open `session_projcache` table, if available.
 * @param ctx - Host context.
 * @returns the table, or undefined.
 */
export function getCacheTable(ctx) {
  try {
    const cache = ctx.get?.('sessionProjectionCache')
    if (cache !== undefined && typeof cache?.requireTable === 'function') {
      const table = cache.requireTable()
      if (table !== undefined) return table
    }
  } catch {
    // Fall through to the storage-domain diagnostic handle.
  }
  try {
    const domain = ctx.get?.('storageDomain')?.get?.('session_projcache')
    const table = domain?.table?.('sessions')
    if (table !== undefined) return table
  } catch {
    // Cache service may not be initialized yet.
  }
  return undefined
}

/** Install the table's put guard once. */
function guardFor(table) {
  let guard = guards.get(table)
  if (guard !== undefined) return guard
  const removed = new Map()
  const originalPut = table.put
  if (typeof originalPut !== 'function') return undefined
  table.put = function putWithDeletionTombstone(key, record) {
    const blocked = removed.get(key)
    if (blocked !== undefined && blocked.has(lifecycleKey(record?.identity))) {
      return Promise.resolve()
    }
    return originalPut.call(this, key, record)
  }
  guard = { removed }
  guards.set(table, guard)
  return guard
}

/**
 * Install a tombstone for one session lifecycle.
 * @param ctx - Host context.
 * @param id - session id.
 * @param header - session header (lifecycle identity).
 * @returns a controller, or undefined when the table is unavailable.
 */
export function beginCacheDeletion(ctx, id, header) {
  const table = getCacheTable(ctx)
  if (table === undefined || ['get', 'put', 'delete'].some(name => typeof table[name] !== 'function')) {
    return undefined
  }
  const guard = guardFor(table)
  if (guard === undefined) return undefined
  let current
  try {
    current = table.get(id)
  } catch {
    current = undefined
  }
  const identity = current?.identity ?? header
  const key = lifecycleKey(identity)
  const previous = guard.removed.get(id)
  const blocked = new Set(previous ?? [])
  blocked.add(key)
  guard.removed.set(id, blocked)
  const timer = setTimeout(() => {
    if (guard.removed.get(id) !== blocked) return
    if (previous !== undefined) guard.removed.set(id, previous)
    else guard.removed.delete(id)
  }, TOMBSTONE_TTL_MS)
  timer.unref?.()
  return {
    /** Delete the durable/memory row after the log commit. */
    async remove() {
      const latest = table.get(id)
      if (latest !== undefined && lifecycleKey(latest.identity) !== key) {
        // A new lifecycle reused the id; never delete its row.
        return false
      }
      return table.delete(id)
    },
    /** Restore the pre-deletion guard state when the operation aborts. */
    rollback() {
      clearTimeout(timer)
      if (guard.removed.get(id) !== blocked) return
      if (previous !== undefined) guard.removed.set(id, previous)
      else guard.removed.delete(id)
    },
    /** Stop the guard's TTL but keep the tombstone for the process lifetime. */
    retain() {
      clearTimeout(timer)
    },
  }
}

/**
 * Direct cache-file deletion used when the table is unavailable.
 * @param home - DSH home.
 * @param id - session id.
 * @returns number of files removed.
 */
export async function removeCacheFiles(home, id) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  const file = join(dir, `${id}.json`)
  let count = 0
  if (await exists(file)) {
    await removePath(file)
    count += 1
  }
  let entries = []
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  for (const name of entries) {
    if (name.startsWith(`${id}.json.bak.`)) {
      await removePath(join(dir, name))
      count += 1
    }
  }
  await fsyncDir(dir)
  return count
}

/**
 * List cache record ids for the startup orphan sweep.
 * @param home - DSH home.
 * @returns ids and file paths.
 */
export async function listCacheRecords(home) {
  const dir = join(home, 'storages', 'session_projcache', 'sessions')
  let entries
  try {
    entries = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    rows.push({ id: name.slice(0, -5), path: join(dir, name) })
  }
  return rows
}
