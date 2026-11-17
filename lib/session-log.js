/**
 * Canonical session-log discovery and bounded/streaming reads.
 *
 * Deletion only needs the header for identity and the raw body for optional
 * media reference scanning. It must not depend on the current build being able
 * to decode every event, so this module deliberately treats the log as text.
 *
 * @module dsh-session-deleater/session-log
 */

import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'

import { assertHeader, assertSessionId, candidateSessionDirs, sessionArtifactVersion } from './ids.js'

const HEADER_PROBE_BYTES = 1024 * 1024

/**
 * Find the highest canonical generation in one session directory.
 * @param dir - session directory.
 * @returns the selected path and version, or undefined when the directory has no canonical log.
 */
export async function findHighestArtifact(dir) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const candidates = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const version = sessionArtifactVersion(entry.name)
    if (version === undefined) continue
    candidates.push({ path: join(dir, entry.name), version })
  }
  candidates.sort((left, right) => right.version - left.version)
  return candidates[0]
}

/**
 * Read the first JSONL record of a session log.
 * @param path - log path (`.jsonl` or `.jsonl.zstd`).
 * @returns parsed header.
 */
export async function readSessionHeader(path) {
  let text
  if (path.endsWith('.zstd')) {
    const info = await fs.stat(path)
    const probeSize = Math.min(info.size, HEADER_PROBE_BYTES)
    let probe = Buffer.alloc(0)
    if (probeSize > 0) {
      const handle = await fs.open(path, 'r')
      try {
        probe = Buffer.alloc(probeSize)
        await handle.read(probe, 0, probeSize, 0)
      } finally {
        await handle.close()
      }
    }
    try {
      text = zstdDecompressSync(probe).toString('utf8')
    } catch {
      // The header frame is small in practice; a larger than 1 MiB frame falls
      // back to a full decode. Session headers are far below that bound.
      text = zstdDecompressSync(await fs.readFile(path)).toString('utf8')
    }
  } else {
    const handle = await fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(HEADER_PROBE_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      text = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  }
  const newline = text.indexOf('\n')
  if (newline < 0) throw new Error('会话工件缺少完整头行')
  return assertHeader(JSON.parse(text.slice(0, newline)))
}

/**
 * Scan one session directory's header without trusting the directory name.
 * @param dir - session directory.
 * @param expectedId - requested session id.
 * @returns header and selected artifact, or undefined when no log is present.
 */
export async function readHeaderFromDir(dir, expectedId) {
  const artifact = await findHighestArtifact(dir)
  if (artifact === undefined) return undefined
  const header = await readSessionHeader(artifact.path)
  if (expectedId !== undefined && header.id !== expectedId) {
    throw new Error(`会话工件 header id "${header.id}" 与请求 "${expectedId}" 不一致`)
  }
  return { header, artifact }
}

/**
 * Locate a session directory when `stat().location` is unavailable.
 * This is the legacy/raw-id and unsupported-header fallback; canonical sessions
 * use the backend-provided location.
 * @param root - sessions root.
 * @param id - session id.
 * @returns directory and header, or undefined.
 */
export async function findSessionDirByIdentity(root, id) {
  assertSessionId(id)
  let projects
  try {
    projects = await fs.readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
  const candidates = candidateSessionDirs(id)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    for (const candidate of candidates) {
      const dir = join(root, project.name, candidate)
      const found = await readHeaderFromDir(dir, id).catch(error => {
        if (error?.code === 'ENOENT') return undefined
        throw error
      })
      if (found !== undefined) return { dir, header: found.header, artifact: found.artifact }
    }
  }
  return undefined
}

/**
 * Extract every `attachmentId` from a session log. This is a literal JSON field
 * scan over decompressed text; it does not need the current event vocabulary.
 * @param path - log path.
 * @returns referenced attachment ids.
 */
export async function collectAttachmentIds(path) {
  const ids = new Set()
  const input = createReadStream(path)
  let stream = input
  if (path.endsWith('.zstd')) {
    stream = input.pipe(createZstdDecompress())
  }
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const pattern = /"attachmentId"\s*:\s*"([^"]+)"/g
      let match
      while ((match = pattern.exec(line)) !== null) ids.add(match[1])
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return ids
}

/**
 * Resolve the canonical session directory from a backend location path.
 * @param locationPath - absolute log path from `SessionPersistence.stat`.
 * @param id - requested session id.
 * @returns the session directory.
 */
export function sessionDirFromLocation(locationPath, id) {
  assertSessionId(id)
  const dir = dirname(locationPath)
  const candidates = candidateSessionDirs(id)
  const base = basename(dir)
  if (!candidates.includes(base)) {
    throw new Error(`会话目录名 "${base}" 与请求 id "${id}" 不匹配`)
  }
  return dir
}
