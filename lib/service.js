/**
 * The Host-side delete service.
 *
 * The service keeps the destructive sequence in one place: preflight, stop,
 * cache tombstone, flush, rename commit, live teardown, quarantine cleanup,
 * metadata cleanup, optional media purge. Public HTTP and the startup reaper
 * are thin wrappers over these methods.
 *
 * @module dsh-session-deleater/service
 */

import * as fs from 'node:fs/promises'

import { assertHeader, assertSessionId } from './ids.js'
import { beginCacheDeletion, getCacheTable, listCacheRecords, removeCacheFiles } from './cache.js'
import { hotCapabilitiesReady, probeCapabilities } from './capabilities.js'
import {
  exists,
  removePath,
  resolveHome,
  withTimeout,
} from './fsx.js'
import { Journal } from './journal.js'
import { attachmentsOf, noLiveSessions, purgeMedia } from './media.js'
import {
  assertSessionDirectory,
  assertUnderSessionsRoot,
  deleteQuarantineDir,
  deleteSessionDirDirect,
  isDirectory,
  listQuarantine,
  pruneProjectDir,
  quarantineRoot,
  quarantineSessionDir,
  sessionsRoot,
} from './paths.js'
import {
  findHighestArtifact,
  findSessionDirByIdentity,
  sessionDirFromLocation,
} from './session-log.js'

export const API_PREFIX = '/session-deleater/api'
const STEP_TIMEOUT_MS = 4000
const QUARANTINE_STALE_MS = 10 * 60 * 1000
const EXTERNAL_WARNING =
  '本地删除不会撤回已发送给模型 provider 的日志/图片，也不会删除导出文件、备份或工作区文件。'

/** A user-facing failure with an HTTP status and optional partial-failure fields. */
export class DeleteError extends Error {
  /**
   * @param code - stable code.
   * @param message - human message.
   * @param status - HTTP status.
   * @param fields - extra result fields.
   */
  constructor(code, message, status = 500, fields = {}) {
    super(message)
    this.name = 'DeleteError'
    this.code = code
    this.status = status
    Object.assign(this, fields)
  }
}

/** Log a warning if the host logger exists. */
function warn(ctx, message) {
  try {
    ctx.logger?.warn?.(`session-deleater: ${message}`)
  } catch {
    // Logging is best-effort.
  }
}

/** Build the service bound to a Host context. */
export function createDeleteService(ctx) {
  const home = resolveHome()
  const quarantineBase = quarantineRoot(home)
  const journal = new Journal(home)
  const ready = journal.load()

  const persistence = () => {
    const service = ctx.get?.('sessionPersistence')
    if (service === undefined) throw new DeleteError('unsupported', 'sessionPersistence 不可用', 503)
    return service
  }
  const sessions = () => ctx.get?.('sessions')
  const agents = () => ctx.get?.('agents')
  const schedule = () => ctx.get?.('schedule')
  const registry = () => ctx.get?.('workspaceRegistry')

  /**
   * Resolve one session to its live/durable identity and directory.
   * @param id - session id.
   * @returns target descriptor, or undefined when no live/stored session exists.
   */
  async function resolveTarget(id) {
    assertSessionId(id)
    const liveSession = sessions()?.get?.(id)
    let snapshot
    try {
      snapshot = await persistence().stat(id)
    } catch {
      snapshot = undefined
    }
    const header = liveSession?.header ?? snapshot?.header
    if (header === undefined) return undefined
    assertHeader(header)
    let dir
    if (typeof snapshot?.location?.path === 'string') {
      dir = sessionDirFromLocation(snapshot.location.path, id)
      await assertSessionDirectory(dir, id)
    } else {
      const found = await findSessionDirByIdentity(sessionsRoot(), id).catch(() => undefined)
      if (found !== undefined) {
        dir = await assertUnderSessionsRoot(found.dir, id)
      }
    }
    return {
      id,
      header,
      live: liveSession !== undefined,
      dir,
      artifact: dir === undefined ? undefined : await findHighestArtifact(dir),
    }
  }

  /**
   * Resolve all target descriptors from a root plus its subagent descendants.
   * @param root - root target.
   * @returns root and descendants.
   */
  async function collectTargets(root) {
    let snapshots = []
    try {
      snapshots = await persistence().list()
    } catch (error) {
      throw new DeleteError('scan-failed', `无法扫描会话列表: ${String(error)}`, 500)
    }
    const headers = new Map()
    for (const snapshot of snapshots) {
      const header = snapshot?.header
      if (header?.id !== undefined) headers.set(header.id, header)
    }
    for (const live of sessions()?.list?.() ?? []) {
      if (live?.header?.id !== undefined) headers.set(live.header.id, live.header)
    }
    headers.set(root.id, root.header)
    const children = new Map()
    for (const header of headers.values()) {
      if (header?.origin !== 'subagent' || typeof header.parentSession !== 'string') continue
      const list = children.get(header.parentSession) ?? []
      list.push(header)
      children.set(header.parentSession, list)
    }
    const targets = [root]
    const visited = new Set([root.id])
    const queue = [root.id]
    while (queue.length > 0) {
      const parent = queue.shift()
      for (const child of children.get(parent) ?? []) {
        if (visited.has(child.id)) continue
        visited.add(child.id)
        queue.push(child.id)
        const live = sessions()?.get?.(child.id)
        targets.push({
          id: child.id,
          header: live?.header ?? child,
          live: live !== undefined,
          dir: undefined,
          artifact: undefined,
        })
      }
    }
    // Resolve directories after the tree is known, so a bad child aborts before
    // any destructive step.
    for (const target of targets) {
      if (target.dir !== undefined) continue
      const resolved = await resolveTarget(target.id).catch(() => undefined)
      if (resolved !== undefined) {
        target.dir = resolved.dir
        target.artifact = resolved.artifact
        target.header = resolved.header
        target.live = resolved.live || target.live
      }
    }
    return targets
  }

  /**
   * Ask the composition what is still running for one session.
   * @param id - session id.
   * @returns activity rows.
   */
  async function activityOf(id) {
    const rows = []
    const agent = agents()?.get?.(id)
    if (agent?.status === 'running') rows.push({ kind: 'turn', items: [{ id }] })
    if (typeof ctx.waterfall === 'function') {
      try {
        const reported = await withTimeout(
          ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([])),
          STEP_TIMEOUT_MS,
          `检查会话 '${id}' 活动`,
        )
        if (Array.isArray(reported)) rows.push(...reported)
      } catch (error) {
        throw new DeleteError('activity-check-failed', String(error?.message ?? error), 500)
      }
    }
    return rows
  }

  /**
   * Stop one target's running work.
   * @param target - target descriptor.
   */
  async function stopTarget(target) {
    const id = target.id
    const agent = agents()?.get?.(id)
    if (agent !== undefined) {
      try {
        if (typeof agent.cancel === 'function') {
          await withTimeout(agent.cancel({ kind: 'disposed' }), STEP_TIMEOUT_MS, `取消会话 '${id}'`)
        }
        if (typeof agent.whenIdle === 'function') {
          await withTimeout(agent.whenIdle(), STEP_TIMEOUT_MS, `等待会话 '${id}' 空闲`)
        }
      } catch (error) {
        throw new DeleteError('stop-failed', `无法停止会话 '${id}': ${String(error)}`, 409)
      }
    }
    if (typeof ctx.parallel === 'function') {
      try {
        await withTimeout(
          ctx.parallel('workspace/session-stop', { sessionId: id }),
          STEP_TIMEOUT_MS,
          `停止会话 '${id}' 活动`,
        )
      } catch (error) {
        throw new DeleteError('stop-failed', `停止会话 '${id}' 活动失败: ${String(error)}`, 409)
      }
    }
    const remaining = await activityOf(id)
    if (remaining.length > 0) {
      throw new DeleteError('session-busy', `会话 '${id}' 仍有活动任务，未删除文件`, 409)
    }
  }

  /**
   * Close every write handle the persistence tracker knows for one id.
   * @param target - target descriptor.
   */
  async function closeWriters(target) {
    if (!target.live) return
    const tracker = persistence()?.tracker
    if (tracker === undefined) {
      throw new DeleteError('unsupported', '持久化 writer 跟踪不可用，拒绝热删除', 503)
    }
    const writers = new Set()
    const direct = tracker?.writers?.get?.(target.id)
    if (direct) writers.add(direct)
    for (const handle of tracker?.openHandles ?? []) {
      if (handle?.id === target.id && handle.access === 'write') writers.add(handle)
    }
    for (const writer of writers) {
      if (typeof writer?.close !== 'function') {
        throw new DeleteError('unsupported', `会话 '${target.id}' 的写入句柄不可关闭`, 503)
      }
      await withTimeout(writer.close(), STEP_TIMEOUT_MS, `关闭会话 '${target.id}' 写入`)
    }
  }

  /**
   * Detach one live session and agent in the order that avoids API re-adds.
   * @param target - target descriptor.
   */
  async function detachLive(target) {
    if (!target.live) return
    const session = sessions()?.get?.(target.id)
    if (session !== undefined) {
      const entry = sessions()?.store?.get?.(target.id)
      if (entry === undefined || typeof entry.detach !== 'function') {
        throw new DeleteError('unsupported', `会话 '${target.id}' 缺少可用的 detach 能力`, 503)
      }
      entry.detach()
    }
    const agentEntry = agents()?.store?.get?.(target.id)
    const detachEntered = agents()?.detachEntered
    if (agentEntry !== undefined) {
      if (typeof detachEntered !== 'function') {
        throw new DeleteError('unsupported', `会话 '${target.id}' 缺少可用的 Agent detach 能力`, 503)
      }
      detachEntered.call(agents(), agentEntry)
    }
    await closeWriters(target)
  }

  /**
   * Detach workspace membership, pin, and archive for one id.
   * @param id - session id.
   * @param warnings - warning sink.
   */
  async function cleanWorkspace(id, warnings) {
    const service = registry()
    if (service === undefined) return
    try {
      for (const workspace of service.list?.() ?? []) {
        if (typeof workspace?.detachSession === 'function') {
          await workspace.detachSession(id)
        }
      }
    } catch (error) {
      warnings.push(`workspace 成员清理失败: ${String(error)}`)
    }
    try {
      if (typeof service.unpinSession === 'function') await service.unpinSession(id)
    } catch (error) {
      warnings.push(`pin 清理失败: ${String(error)}`)
    }
    try {
      if (typeof service.unarchiveSession === 'function') await service.unarchiveSession(id)
    } catch (error) {
      warnings.push(`archive 清理失败: ${String(error)}`)
    }
  }

  /**
   * Delete schedule tasks that reference one id.
   * @param id - session id.
   * @param all - true for secure purge, false for active target only.
   * @param warnings - warning sink.
   */
  async function cleanSchedule(id, all, warnings) {
    const service = schedule()
    if (service === undefined || all !== true) return 0
    try {
      const tasks = await service.catalog()
      let removed = 0
      for (const task of tasks) {
        const hit = (task?.target?.kind === 'session' && task.target.sessionId === id)
          || (Array.isArray(task?.involvedSessionIds) && task.involvedSessionIds.includes(id))
          || (task?.pendingDelivery?.targetSessionId === id)
        if (!hit) continue
        await service.edit({ id: task.id, action: 'delete' })
        removed += 1
      }
      return removed
    } catch (error) {
      warnings.push(`计划任务清理失败: ${String(error)}`)
      return 0
    }
  }

  /**
   * Count schedule references for a set of target ids.
   * @param ids - session ids.
   * @returns number of unique tasks referencing any id.
   */
  async function scheduleRefCount(ids) {
    try {
      const tasks = await schedule()?.catalog?.()
      if (!Array.isArray(tasks)) return 0
      const wanted = new Set(ids)
      const hits = new Set()
      for (const task of tasks) {
        const hit = (task?.target?.kind === 'session' && wanted.has(task.target.sessionId))
          || (Array.isArray(task?.involvedSessionIds) && task.involvedSessionIds.some(id => wanted.has(id)))
          || wanted.has(task?.pendingDelivery?.targetSessionId)
        if (hit) hits.add(task.id)
      }
      return hits.size
    } catch {
      return 0
    }
  }

  /**
   * Remove one cache row through the table when possible, otherwise by file.
   * @param target - target descriptor.
   * @param warnings - warning sink.
   */
  async function removeCacheRow(target, warnings) {
    const table = getCacheTable(ctx)
    if (table !== undefined) {
      try {
        const record = table.get(target.id)
        if (record !== undefined && record.identity?.createdAt !== target.header.createdAt) return
        await table.delete(target.id)
        return
      } catch (error) {
        warnings.push(`投影缓存表删除失败 (${target.id}): ${String(error)}`)
      }
    }
    try {
      await removeCacheFiles(home, target.id)
    } catch (error) {
      warnings.push(`投影缓存文件清理失败 (${target.id}): ${String(error)}`)
    }
  }

  /**
   * Read a display title from the projection cache without requiring a log read.
   * @param header - session header.
   * @returns title or undefined.
   */
  function cachedTitle(header) {
    try {
      const value = ctx.get?.('sessionProjectionCache')?.cachedSnapshot?.(header)
      const title = value?.values?.title
      return typeof title === 'string' && title !== '' ? title : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Build the delete preview.
   * @param id - session id.
   * @returns preview payload.
   */
  async function preview(id) {
    const root = await resolveTarget(id)
    if (root === undefined) throw new DeleteError('session-not-found', `会话 '${id}' 不存在`, 404)
    const targets = await collectTargets(root)
    const activity = []
    for (const target of targets) activity.push(...await activityOf(target.id))
    const capabilities = probeCapabilities(ctx)
    const live = targets.some(target => target.live)
    const hotReady = !live || hotCapabilitiesReady(capabilities)
    return {
      sessionId: id,
      displayTitle: cachedTitle(root.header) ?? id,
      origin: root.header.origin ?? null,
      live,
      running: activity.length > 0,
      activity,
      subagentCount: targets.length - 1,
      subagents: targets.slice(1).map(target => ({ id: target.id, displayTitle: cachedTitle(target.header) ?? target.id })),
      scheduleRefs: await scheduleRefCount(targets.map(target => target.id)),
      attachmentsKnown: false,
      canDelete: hotReady,
      hotReady,
      capabilities,
      externalWarning: EXTERNAL_WARNING,
      childOnlyWarning: root.header.origin === 'subagent'
        ? '这是子智能体会话；删除后父会话日志中的 catalog 引用仍会保留该 id/标题。'
        : undefined,
    }
  }

  /**
   * Read all attachment ids from the target logs before they are destroyed.
   * @param targets - target descriptors.
   * @param warnings - warning sink.
   * @returns unique ids.
   */
  async function collectTargetAttachments(targets, warnings) {
    const ids = new Set()
    for (const target of targets) {
      if (target.artifact?.path === undefined) continue
      try {
        for (const id of await attachmentsOf(target.artifact.path)) ids.add(id)
      } catch (error) {
        warnings.push(`读取附件引用失败 (${target.id}): ${String(error)}`)
      }
    }
    return ids
  }

  /**
   * Run metadata cleanup after the commit.
   * @param targets - target descriptors.
   * @param controllers - cache controllers by id.
   * @param allSchedule - true for secure purge.
   * @param warnings - warning sink.
   */
  async function cleanupMetadata(targets, controllers, allSchedule, warnings) {
    for (const target of targets) {
      const current = await persistence().stat(target.id).catch(() => undefined)
      if (current !== undefined && current.header.createdAt !== target.header.createdAt) {
        warnings.push(`会话 '${target.id}' 已被新生命周期复用，跳过 id 清理`)
        continue
      }
      const controller = controllers.get(target.id)
      if (controller !== undefined) {
        try {
          await controller.remove()
        } catch (error) {
          warnings.push(`投影缓存清理失败 (${target.id}): ${String(error)}`)
        }
      } else {
        await removeCacheRow(target, warnings)
      }
      await cleanWorkspace(target.id, warnings)
      await cleanSchedule(target.id, allSchedule, warnings)
      if (!target.live) {
        try {
          ctx.emit?.('api-session/removed', target.id)
        } catch {
          // The API event is an internal notification; client refresh remains.
        }
      }
    }
  }

  /**
   * Delete one session and its subagent subtree.
   * @param id - session id.
   * @param options - media mode.
   * @returns result payload.
   */
  async function deleteSession(id, options = {}) {
    await ready
    assertSessionId(id)
    const secure = options.media === 'purge'
    const root = await resolveTarget(id)
    if (root === undefined) {
      return {
        deleted: false,
        filesRemoved: false,
        deletedSubagents: [],
        warnings: [],
        mediaPending: false,
      }
    }
    const targets = await collectTargets(root)
    const capabilities = probeCapabilities(ctx)
    const anyLive = targets.some(target => target.live)
    if (anyLive && !hotCapabilitiesReady(capabilities)) {
      throw new DeleteError('delete-unsupported', '当前 DSH 版本缺少热删除所需的内部能力；请重启 DSH 后重试冷删除', 503)
    }
    if (targets.some(target => target.dir !== undefined)) {
      for (const target of targets) {
        if (target.dir !== undefined) await assertSessionDirectory(target.dir, target.id)
      }
    }
    const warnings = []
    const controllers = new Map()
    const intent = {
      id,
      header: root.header,
      createdAt: Date.now(),
      phase: 'starting',
      media: secure ? 'purge' : 'keep',
      mediaPending: false,
      attachmentIds: [],
      targets: targets.map(target => ({
        id: target.id,
        header: target.header,
        live: target.live,
        quarantine: undefined,
        direct: false,
        deleted: false,
      })),
    }
    await journal.put(intent)
    try {
      for (const target of targets.slice().reverse()) await stopTarget(target)
      for (const target of targets) {
        const controller = beginCacheDeletion(ctx, target.id, target.header)
        if (controller === undefined && target.live) {
          throw new DeleteError('delete-unsupported', `会话 '${target.id}' 的投影缓存 tombstone 不可用`, 503)
        }
        if (controller !== undefined) controllers.set(target.id, controller)
      }
      for (const target of targets) {
        if (!target.live) continue
        const session = sessions()?.get?.(target.id)
        if (session !== undefined) {
          try {
            await withTimeout(sessions()?.flush?.(session), STEP_TIMEOUT_MS, `刷新会话 '${target.id}'`)
          } catch (error) {
            throw new DeleteError('flush-failed', `刷新会话 '${target.id}' 失败: ${String(error)}`, 500)
          }
        }
      }
      if (secure) {
        const ids = await collectTargetAttachments(targets, warnings)
        intent.attachmentIds = [...ids]
        await journal.patch(id, { attachmentIds: intent.attachmentIds, mediaPending: ids.size > 0 })
      }
      const renamed = []
      try {
        for (const target of targets.slice().reverse()) {
          if (target.dir === undefined || !await isDirectory(target.dir)) continue
          const targetEntry = intent.targets.find(entry => entry.id === target.id)
          const quarantine = await quarantineSessionDir(target.dir, target.id, quarantineBase)
          if (quarantine === undefined) {
            targetEntry.direct = true
          } else {
            targetEntry.quarantine = quarantine
            renamed.push({ dir: target.dir, quarantine, id: target.id })
          }
          intent.phase = 'renamed'
          await journal.patch(id, { targets: intent.targets, phase: 'renamed' })
        }
      } catch (error) {
        let rollbackFailed = false
        for (const item of renamed.reverse()) {
          try {
            if (!await exists(item.dir)) await fs.rename(item.quarantine, item.dir)
          } catch {
            rollbackFailed = true
          }
        }
        if (rollbackFailed) {
          intent.phase = 'partial'
          await journal.patch(id, { targets: intent.targets, phase: 'partial' }).catch(() => {})
        } else {
          intent.phase = 'starting'
        }
        throw new DeleteError('rename-failed', `无法移出会话目录: ${String(error)}`, 500)
      }
      if (intent.phase === 'starting') {
        intent.phase = 'renamed'
        await journal.patch(id, { targets: intent.targets, phase: 'renamed' })
      }
      try {
        for (const target of targets) await detachLive(target)
      } catch (error) {
        warnings.push(`live 注册清理未完成，将在重启后重试: ${String(error)}`)
        intent.phase = 'teardown-pending'
        await journal.patch(id, { targets: intent.targets, phase: 'teardown-pending' })
      }
      let filesRemoved = false
      for (const target of targets) {
        const targetEntry = intent.targets.find(entry => entry.id === target.id)
        try {
          if (targetEntry.quarantine !== undefined) {
            await deleteQuarantineDir(targetEntry.quarantine)
            filesRemoved = true
          } else if (targetEntry.direct && target.dir !== undefined) {
            await deleteSessionDirDirect(target.dir)
            filesRemoved = true
          }
          targetEntry.deleted = true
          intent.phase = 'deleted'
          await journal.patch(id, { targets: intent.targets, phase: 'deleted' })
          if (target.dir !== undefined) await pruneProjectDir(target.dir)
        } catch (error) {
          warnings.push(`隔离目录清理失败 (${target.id}): ${String(error)}`)
        }
      }
      await cleanupMetadata(targets, controllers, secure, warnings)
      let mediaPending = false
      if (secure && intent.attachmentIds.length > 0) {
        if (noLiveSessions(ctx)) {
          try {
            const result = await purgeMedia({
              ctx,
              persistence: persistence(),
              home,
              targetIds: targets.map(target => target.id),
              attachmentIds: new Set(intent.attachmentIds),
            })
            if (result.skipped) {
              warnings.push(result.reason ?? '媒体清理跳过')
              mediaPending = true
            }
          } catch (error) {
            warnings.push(`媒体清理失败: ${String(error)}`)
            mediaPending = true
          }
        } else {
          mediaPending = true
        }
      }
      if (warnings.length === 0 && !mediaPending) {
        await journal.remove(id).catch(error => warnings.push(`journal 清理失败: ${String(error)}`))
      } else {
        intent.phase = mediaPending ? 'media-pending' : 'cleanup-warnings'
        await journal.patch(id, {
          targets: intent.targets,
          mediaPending,
          phase: intent.phase,
        })
      }
      return {
        deleted: true,
        filesRemoved,
        wasLive: anyLive,
        deletedSubagents: targets.slice(1)
          .filter(target => intent.targets.find(entry => entry.id === target.id)?.deleted === true)
          .map(target => target.id),
        subagentCount: targets.length - 1,
        remainingSessionIds: intent.targets.filter(entry => !entry.deleted).map(entry => entry.id),
        warnings,
        partialFailure: warnings.some(warning => warning.includes('失败') || warning.includes('未完成')),
        mediaPending,
        quarantinePath: intent.targets.find(entry => entry.quarantine !== undefined)?.quarantine,
      }
    } catch (error) {
      for (const controller of controllers.values()) controller.rollback?.()
      if (intent.phase === 'starting') await journal.remove(id).catch(() => {})
      if (error instanceof DeleteError) throw error
      throw new DeleteError('delete-failed', String(error?.message ?? error), 500, {
        deletedSubagents: [],
        remainingSessionIds: targets.map(target => target.id),
      })
    }
  }

  /**
   * Resume one journaled operation at startup.
   * @param entry - journal entry.
   */
  async function resumeEntry(entry) {
    const warnings = []
    const targetIds = entry.targets.map(target => target.id)
    for (const target of entry.targets) {
      const targetHeader = target.header
      if (targetHeader === undefined) continue
      if (sessions()?.get?.(target.id) !== undefined) {
        warnings.push(`会话 '${target.id}' 在启动恢复时仍是 live，跳过`)
        continue
      }
      const current = await persistence().stat(target.id).catch(() => undefined)
      if (current !== undefined && current.header.createdAt !== targetHeader.createdAt) {
        warnings.push(`会话 '${target.id}' 已被新生命周期复用，跳过`)
        continue
      }
      if (target.quarantine !== undefined && await exists(target.quarantine)) {
        await deleteQuarantineDir(target.quarantine).catch(error => warnings.push(String(error)))
      } else if (target.direct === true) {
        const found = await findSessionDirByIdentity(sessionsRoot(), target.id).catch(() => undefined)
        if (found !== undefined) await deleteSessionDirDirect(found.dir).catch(error => warnings.push(String(error)))
      } else {
        const resolved = await resolveTarget(target.id).catch(() => undefined)
        if (resolved?.dir !== undefined) {
          const quarantine = await quarantineSessionDir(resolved.dir, target.id, quarantineBase)
          if (quarantine !== undefined) {
            await deleteQuarantineDir(quarantine).catch(error => warnings.push(String(error)))
          } else {
            await deleteSessionDirDirect(resolved.dir).catch(error => warnings.push(String(error)))
          }
        }
      }
      await removeCacheRow({ id: target.id, header: targetHeader }, warnings)
      await cleanWorkspace(target.id, warnings)
      const allSchedule = entry.media === 'purge'
      await cleanSchedule(target.id, allSchedule, warnings)
    }
    if (entry.media === 'purge' && Array.isArray(entry.attachmentIds) && entry.attachmentIds.length > 0) {
      if (noLiveSessions(ctx)) {
        try {
          const result = await purgeMedia({
            ctx,
            persistence: persistence(),
            home,
            targetIds,
            attachmentIds: new Set(entry.attachmentIds),
          })
          if (result.skipped) {
            warnings.push(result.reason ?? '媒体清理跳过')
            warn(ctx, warnings.join('; '))
            return
          }
        } catch (error) {
          warnings.push(`媒体清理失败: ${String(error)}`)
          warn(ctx, warnings.join('; '))
          return
        }
      } else {
        warn(ctx, '仍有 live 会话，媒体清理延后')
        return
      }
    }
    if (warnings.length > 0) {
      warn(ctx, `启动恢复完成但有警告: ${warnings.join('; ')}`)
    }
    await journal.remove(entry.id)
  }

  /**
   * Startup: resume intents and remove old/orphan residue.
   */
  async function startup() {
    await ready
    for (const entry of journal.list()) {
      try {
        await resumeEntry(entry)
      } catch (error) {
        warn(ctx, `恢复删除意图 '${entry.id}' 失败: ${String(error)}`)
      }
    }
    try {
      const snapshots = await persistence().list()
      const known = new Set(snapshots.map(snapshot => snapshot.header.id))
      for (const live of sessions()?.list?.() ?? []) known.add(live.header.id)
      const cacheTable = getCacheTable(ctx)
      for (const record of await listCacheRecords(home)) {
        if (known.has(record.id)) continue
        if (journal.get(record.id) !== undefined) continue
        if (cacheTable !== undefined) {
          await cacheTable.delete(record.id).catch(() => {})
        } else {
          await removePath(record.path).catch(() => {})
        }
      }
      const service = registry()
      if (service !== undefined) {
        for (const id of service.pinnedSessionIds ?? []) {
          if (!known.has(id) && sessions()?.get?.(id) === undefined) {
            await service.unpinSession?.(id).catch(() => {})
          }
        }
        for (const id of service.archivedSessionIds ?? []) {
          if (!known.has(id) && sessions()?.get?.(id) === undefined) {
            await service.unarchiveSession?.(id).catch(() => {})
          }
        }
      }
    } catch (error) {
      warn(ctx, `孤儿缓存/引用清理失败: ${String(error)}`)
    }
    try {
      const journalPaths = new Set(journal.list().flatMap(entry =>
        entry.targets.map(target => target.quarantine).filter(Boolean)))
      for (const path of await listQuarantine(home)) {
        if (journalPaths.has(path)) continue
        const info = await fs.lstat(path).catch(() => undefined)
        if (info === undefined) continue
        if (Date.now() - info.mtimeMs < QUARANTINE_STALE_MS) continue
        await deleteQuarantineDir(path).catch(() => {})
      }
    } catch (error) {
      warn(ctx, `隔离区清理失败: ${String(error)}`)
    }
  }

  /**
   * Health/capability payload.
   * @returns health payload.
   */
  function health() {
    const capabilities = probeCapabilities(ctx)
    return {
      ok: true,
      version: '0.1.0',
      capabilities,
      hotReady: hotCapabilitiesReady(capabilities),
      home,
      api: API_PREFIX,
    }
  }

  return { preview, deleteSession, startup, health, resolveTarget, collectTargets }
}
