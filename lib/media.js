/**
 * Optional media purge.
 *
 * Attachments are content-addressed and shared. This module only deletes an
 * object when no remaining session references it, and it refuses the whole
 * purge when any remaining log cannot be read. Provider-side files are never
 * deleted here.
 *
 * @module dsh-session-deleater/media
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'

import { collectAttachmentIds } from './session-log.js'
import { exists, readJson, removePath, withFileLock, writeJsonAtomic } from './fsx.js'

/** Match a canonical attachment id. */
const ATTACHMENT_ID = /^sha256:([0-9a-f]{64})$/

/**
 * Collect attachment ids from every remaining persisted session.
 * @param persistence - session persistence service.
 * @param exclude - ids of sessions being deleted.
 * @returns referenced ids plus an unreadable flag.
 */
export async function collectRemainingAttachmentIds(persistence, exclude) {
  const referenced = new Set()
  let unreadable = false
  let snapshots
  try {
    snapshots = await persistence.list()
  } catch {
    return { referenced, unreadable: true }
  }
  for (const snapshot of snapshots) {
    const id = snapshot?.header?.id
    if (typeof id !== 'string' || exclude.has(id)) continue
    const path = snapshot.location?.path
    if (typeof path !== 'string') continue
    try {
      for (const attachmentId of await collectAttachmentIds(path)) referenced.add(attachmentId)
    } catch {
      unreadable = true
    }
  }
  return { referenced, unreadable }
}

/**
 * Remove one attachment's local object/file-reference paths.
 * @param home - DSH home.
 * @param attachmentId - `sha256:<hex>`.
 * @returns number of removed paths.
 */
async function removeAttachmentObject(home, attachmentId) {
  const match = ATTACHMENT_ID.exec(attachmentId)
  if (match === null) return 0
  const hex = match[1]
  const prefix = hex.slice(0, 2)
  let removed = 0
  for (const path of [
    join(home, 'attachments', 'v1', 'objects', prefix, hex),
    join(home, 'attachments', 'v1', 'file-objects', prefix, hex),
    join(home, 'attachments', 'v1', 'files', prefix, hex),
  ]) {
    if (await exists(path)) {
      await removePath(path)
      removed += 1
    }
  }
  return removed
}

/**
 * Remove local provider upload-index records for deleted attachments.
 * @param home - DSH home.
 * @param removable - attachment ids.
 * @returns number of removed records.
 */
async function removeProviderIndexRecords(home, removable) {
  const path = join(home, 'llm-deepseek', 'files-v3.json')
  if (!await exists(path)) return 0
  const lockPath = `${path}.lock`
  try {
    return await withFileLock(lockPath, async () => {
      const index = await readJson(path, undefined)
      if (index === null || typeof index !== 'object' || index.formatVersion !== 3
        || !Array.isArray(index.records)) {
        throw new Error('provider 上传索引格式未知，未修改')
      }
      const next = index.records.filter(record => !removable.has(record?.attachmentId))
      const removed = index.records.length - next.length
      if (removed > 0) await writeJsonAtomic(path, { ...index, records: next })
      return removed
    })
  } catch {
    return 0
  }
}

/**
 * Remove the optional spill directory for one session.
 * @param ctx - Host context.
 * @param sessionId - session id.
 * @returns true when a spill directory was removed.
 */
async function removeSpillDir(ctx, sessionId) {
  const spill = ctx.get?.('spillStore')
  const root = spill?.root
  if (typeof root !== 'string') return false
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  const dir = join(root, `session-${hash}`)
  if (!await exists(dir)) return false
  await removePath(dir)
  return true
}

/**
 * Purge local media referenced only by the deleted target sessions.
 * @param options - persistence, home, target ids, attachment ids, and context.
 * @returns a summary; `skipped` is true when no safe purge was possible.
 */
export async function purgeMedia(options) {
  const { ctx, persistence, home, targetIds, attachmentIds } = options
  const exclude = new Set(targetIds)
  const remaining = await collectRemainingAttachmentIds(persistence, exclude)
  if (remaining.unreadable) {
    return {
      skipped: true,
      reason: '存在无法读取的其余会话，无法证明附件无其他引用',
      removedObjects: 0,
      removedProviderRecords: 0,
      removedSpillDirs: 0,
      cacheCleared: false,
    }
  }
  const removable = new Set()
  for (const id of attachmentIds) {
    if (!remaining.referenced.has(id)) removable.add(id)
  }
  let removedObjects = 0
  for (const id of removable) removedObjects += await removeAttachmentObject(home, id)
  const removedProviderRecords = await removeProviderIndexRecords(home, removable)
  let removedSpillDirs = 0
  for (const id of targetIds) {
    if (await removeSpillDir(ctx, id)) removedSpillDirs += 1
  }
  let cacheCleared = false
  if (removedObjects > 0) {
    const cacheDir = join(home, 'cache', 'attachments', 'request-images')
    if (await exists(cacheDir)) {
      await removePath(cacheDir)
      cacheCleared = true
    }
  }
  return {
    skipped: false,
    reason: undefined,
    removedObjects,
    removedProviderRecords,
    removedSpillDirs,
    cacheCleared,
  }
}

/**
 * Read the attachments of one log path into a set.
 * @param path - session log path.
 * @returns attachment ids.
 */
export async function attachmentsOf(path) {
  try {
    return await collectAttachmentIds(path)
  } catch {
    return new Set()
  }
}

/**
 * Whether media purge is safe now: no live sessions may exist in this process.
 * @param ctx - Host context.
 * @returns true when no live session is loaded.
 */
export function noLiveSessions(ctx) {
  return (ctx.get?.('sessions')?.list?.() ?? []).length === 0
}
