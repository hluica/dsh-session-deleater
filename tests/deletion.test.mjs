import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { projectKey } from '../lib/ids.js'
import { createDeleteService } from '../lib/service.js'

/**
 * Build a temporary session layout and a fake Host context.
 * @returns {Promise<{home: string, ctx: object, calls: object, cleanup: Function}>}
 */
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-deleater-test-'))
  const cwd = join(home, 'project')
  await mkdir(cwd, { recursive: true })
  const id = 'session-test'
  const sessionDir = join(home, 'sessions', projectKey(cwd), id)
  await mkdir(sessionDir, { recursive: true })
  const header = {
    type: 'session',
    version: 4,
    id,
    createdAt: 1234567890,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  }
  const logPath = join(sessionDir, 'session.v4.jsonl.zstd')
  await writeFile(logPath, zstdCompressSync(`${JSON.stringify(header)}\n`))
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cachePath = join(cacheDir, `${id}.json`)
  await writeFile(cachePath, JSON.stringify({ version: 7, record: { identity: { formatVersion: 4, createdAt: header.createdAt, cwd, isSeeded: false }, rows: {} } }))

  const calls = { detach: 0, unpin: 0, unarchive: 0, removed: [] }
  const snapshot = {
    header,
    formatStatus: 'current',
    revision: 'test',
    location: { kind: 'jsonl', path: logPath },
  }
  const persistence = {
    async stat(requested) {
      if (requested !== id) return undefined
      try {
        await stat(logPath)
      } catch {
        return undefined
      }
      return snapshot
    },
    async list() {
      try {
        await stat(logPath)
      } catch {
        return []
      }
      return [snapshot]
    },
  }
  const workspace = {
    async detachSession() { calls.detach += 1 },
    async unpinSession() { calls.unpin += 1 },
    async unarchiveSession() { calls.unarchive += 1 },
  }
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'sessions') return { get() {}, list() { return [] } }
      if (name === 'agents') return { get() {}, list() { return [] } }
      if (name === 'workspaceRegistry') {
        return {
          list() { return [workspace] },
          pinnedSessionIds: [],
          archivedSessionIds: [],
          unpinSession: workspace.unpinSession.bind(workspace),
          unarchiveSession: workspace.unarchiveSession.bind(workspace),
        }
      }
      if (name === 'schedule') return undefined
      return undefined
    },
    async parallel() {},
    async waterfall(_name, _request, next) { return next() },
    emit(name, value) { if (name === 'api-session/removed') calls.removed.push(value) },
  }
  return {
    home,
    ctx,
    calls,
    logPath,
    cachePath,
    id,
    async cleanup() { await rm(home, { recursive: true, force: true }) },
  }
}

test('cold session delete removes log, cache, workspace refs, and emits removal', async () => {
  const f = await fixture()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = f.home
  try {
    const service = createDeleteService(f.ctx)
    const preview = await service.preview(f.id)
    assert.equal(preview.subagentCount, 0)
    assert.equal(preview.canDelete, true)
    const result = await service.deleteSession(f.id, { media: 'keep' })
    assert.equal(result.deleted, true)
    assert.equal(result.filesRemoved, true)
    await assert.rejects(stat(join(f.home, 'sessions', projectKey(join(f.home, 'project')), f.id)), { code: 'ENOENT' })
    await assert.rejects(stat(f.cachePath), { code: 'ENOENT' })
    assert.equal(f.calls.detach, 1)
    assert.deepEqual(f.calls.removed, [f.id])
    const second = await service.deleteSession(f.id, { media: 'keep' })
    assert.equal(second.deleted, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await f.cleanup()
  }
})

test('invalid ids are refused before any filesystem work', async () => {
  const f = await fixture()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = f.home
  try {
    const service = createDeleteService(f.ctx)
    await assert.rejects(service.deleteSession('../escape', { media: 'keep' }), /sessionId/)
    assert.equal(await readFile(f.logPath).then(() => true), true)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await f.cleanup()
  }
})

test('live session uses the private detach path and closes writers', async () => {
  const f = await fixture()
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = f.home
  try {
    const calls = { sessionDetach: 0, agentDetach: 0, writerClose: 0, cacheDelete: 0 }
    const header = {
      type: 'session', version: 4, id: f.id, createdAt: 1234567890,
      cwd: join(f.home, 'project'), isSeeded: false, delegationDepth: 0,
    }
    const session = { header }
    const agent = { status: 'idle', async cancel() {}, async whenIdle() {} }
    const writer = { id: f.id, access: 'write', async close() { calls.writerClose += 1 } }
    const table = {
      get() { return undefined },
      async put() {},
      async delete() { calls.cacheDelete += 1 },
    }
    const persistence = {
      tracker: {
        writers: new Map([[f.id, writer]]),
        openHandles: new Set([writer]),
      },
      async stat(requested) {
        if (requested !== f.id) return undefined
        try { await stat(join(f.home, 'sessions', projectKey(join(f.home, 'project')), f.id)) } catch { return undefined }
        return {
          header,
          formatStatus: 'current',
          revision: 'test',
          location: { kind: 'jsonl', path: join(f.home, 'sessions', projectKey(join(f.home, 'project')), f.id, 'session.v4.jsonl.zstd') },
        }
      },
      async list() { return [] },
    }
    const sessions = {
      get() { return session },
      list() { return [session] },
      store: new Map([[f.id, { detach() { calls.sessionDetach += 1 } }]]),
      async flush() {},
    }
    const agents = {
      get() { return agent },
      list() { return [agent] },
      store: new Map([[f.id, { agent }]]),
      detachEntered() { calls.agentDetach += 1 },
    }
    const ctx = {
      logger: { warn() {}, error() {}, info() {} },
      get(name) {
        if (name === 'sessionPersistence') return persistence
        if (name === 'sessions') return sessions
        if (name === 'agents') return agents
        if (name === 'sessionProjectionCache') return { requireTable() { return table } }
        if (name === 'workspaceRegistry') {
          return {
            list() { return [] },
            pinnedSessionIds: [],
            archivedSessionIds: [],
            async unpinSession() {},
            async unarchiveSession() {},
          }
        }
        return undefined
      },
      async parallel() {},
      async waterfall(_name, _request, next) { return next() },
      emit() {},
    }
    const service = createDeleteService(ctx)
    const preview = await service.preview(f.id)
    assert.equal(preview.hotReady, true)
    const result = await service.deleteSession(f.id, { media: 'keep' })
    assert.equal(result.deleted, true)
    assert.equal(calls.sessionDetach, 1)
    assert.equal(calls.agentDetach, 1)
    assert.equal(calls.writerClose, 1)
    assert.equal(calls.cacheDelete, 1)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await f.cleanup()
  }
})

test('secure purge keeps shared attachments and removes unique media', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-session-deleater-media-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const cwd = join(home, 'project')
    await mkdir(cwd, { recursive: true })
    const unique = `sha256:${'a'.repeat(64)}`
    const shared = `sha256:${'b'.repeat(64)}`
    const ids = ['session-target', 'session-other']
    const snapshots = []
    for (const id of ids) {
      const dir = join(home, 'sessions', projectKey(cwd), id)
      await mkdir(dir, { recursive: true })
      const header = { type: 'session', version: 4, id, createdAt: 1, cwd, isSeeded: false, delegationDepth: 0 }
      const log = join(dir, 'session.v4.jsonl.zstd')
      const line = JSON.stringify({ type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'x' }, { type: 'image', attachment: { attachmentId: id === ids[0] ? unique : shared } }, { type: 'image', attachment: { attachmentId: shared } }] } })
      await writeFile(log, zstdCompressSync(`${JSON.stringify(header)}\n${line}\n`))
      snapshots.push({ header, formatStatus: 'current', revision: id, location: { kind: 'jsonl', path: log } })
    }
    const persistence = {
      async stat(requested) {
        const found = snapshots.find(snapshot => snapshot.header.id === requested)
        if (found === undefined) return undefined
        try { await stat(found.location.path) } catch { return undefined }
        return found
      },
      async list() {
        const live = []
        for (const snapshot of snapshots) {
          try { await stat(snapshot.location.path); live.push(snapshot) } catch { /* deleted */ }
        }
        return live
      },
    }
    const blob = (hex) => join(home, 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
    await mkdir(join(home, 'attachments', 'v1', 'objects', 'aa'), { recursive: true })
    await mkdir(join(home, 'attachments', 'v1', 'objects', 'bb'), { recursive: true })
    await writeFile(blob('a'.repeat(64)), 'unique')
    await writeFile(blob('b'.repeat(64)), 'shared')
    const cacheFile = join(home, 'cache', 'attachments', 'request-images', 'aa', 'x')
    await mkdir(join(home, 'cache', 'attachments', 'request-images', 'aa'), { recursive: true })
    await writeFile(cacheFile, 'cache')
    const indexFile = join(home, 'llm-deepseek', 'files-v3.json')
    await mkdir(join(home, 'llm-deepseek'), { recursive: true })
    await writeFile(indexFile, JSON.stringify({ formatVersion: 3, records: [
      { scope: 's', attachmentId: unique, variantId: 'sha256:v', fileId: 'f1', bytes: 1, createdAt: 1, expiresAt: 2 },
      { scope: 's', attachmentId: shared, variantId: 'sha256:w', fileId: 'f2', bytes: 1, createdAt: 1, expiresAt: 2 },
    ] }))
    const ctx = {
      logger: { warn() {}, error() {}, info() {} },
      get(name) {
        if (name === 'sessionPersistence') return persistence
        if (name === 'sessions') return { get() {}, list() { return [] } }
        if (name === 'agents') return { get() {}, list() { return [] } }
        if (name === 'workspaceRegistry') return { list() { return [] }, pinnedSessionIds: [], archivedSessionIds: [] }
        return undefined
      },
      async parallel() {},
      async waterfall(_name, _request, next) { return next() },
      emit() {},
    }
    const service = createDeleteService(ctx)
    const result = await service.deleteSession(ids[0], { media: 'purge' })
    assert.equal(result.deleted, true)
    assert.equal(result.mediaPending, false)
    assert.equal(await stat(blob('b'.repeat(64))).then(() => true), true)
    await assert.rejects(stat(blob('a'.repeat(64))), { code: 'ENOENT' })
    await assert.rejects(stat(cacheFile), { code: 'ENOENT' })
    const index = JSON.parse(await readFile(indexFile, 'utf8'))
    assert.deepEqual(index.records.map(record => record.attachmentId), [shared])
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
