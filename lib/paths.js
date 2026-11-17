/**
 * Session directory discovery, containment checks, and the quarantine commit.
 * @module dsh-session-deleater/paths
 */

import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { assertSessionId, candidateSessionDirs, encodeSegment, projectKey } from './ids.js'
import { exists, fsyncDir, homePath, removePath } from './fsx.js'

/**
 * Resolve the canonical sessions root used by the default composition.
 * @returns absolute sessions root.
 */
export function sessionsRoot() {
  return homePath('sessions')
}

/**
 * Validate that a directory is exactly one session-owned directory under its
 * project directory, with no symlink or containment escape.
 * @param dir - candidate session directory.
 * @param id - requested session id.
 * @returns the resolved directory.
 */
export async function assertSessionDirectory(dir, id) {
  assertSessionId(id)
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('会话目录不是绝对路径')
  const project = dirname(dir)
  const root = dirname(project)
  if (!candidateSessionDirs(id).includes(basename(dir))) {
    throw new Error('会话目录名与会话 id 不匹配')
  }
  const canonicalRoot = await fs.realpath(root)
  for (const current of [project, dir]) {
    const info = await fs.lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('会话目录不能是符号链接、junction 或普通文件')
    }
    const canonical = await fs.realpath(current)
    const child = relative(canonicalRoot, canonical)
    if (isAbsolute(child) || child === '' || child.split(sep).includes('..')) {
      throw new Error('会话目录解析到了允许范围之外')
    }
  }
  return dir
}

/**
 * Validate a directory found by header scanning against the default sessions root.
 * @param dir - session directory.
 * @param id - session id.
 * @returns the directory.
 */
export async function assertUnderSessionsRoot(dir, id) {
  const root = resolve(sessionsRoot())
  const canonicalRoot = await fs.realpath(root).catch(() => root)
  const canonicalDir = await fs.realpath(dir)
  const rel = relative(canonicalRoot, canonicalDir)
  if (isAbsolute(rel) || rel === '' || rel.split(sep).includes('..') || rel.split(sep).length !== 2) {
    throw new Error('会话目录不在 sessions 根内')
  }
  return assertSessionDirectory(dir, id)
}

/**
 * Remove an empty project directory after the last session is gone.
 * @param dir - removed session directory.
 */
export async function pruneProjectDir(dir) {
  const project = dirname(dir)
  try {
    const entries = await fs.readdir(project)
    if (entries.length === 0) await fs.rmdir(project)
  } catch {
    // A non-empty or concurrently-used project directory is normal.
  }
}

/**
 * Move one session directory into the quarantine area.
 * @param dir - validated session directory.
 * @param id - session id.
 * @param quarantineRoot - quarantine root.
 * @returns the quarantine path, or undefined when the filesystem cannot rename it.
 */
export async function quarantineSessionDir(dir, id, quarantineRoot) {
  await fs.mkdir(quarantineRoot, { recursive: true, mode: 0o700 })
  const stamp = `${Date.now()}-${encodeSegment(id).slice(0, 120)}-${randomBytes(4).toString('hex')}`
  const target = join(quarantineRoot, stamp)
  try {
    await fs.rename(dir, target)
    await fsyncDir(dirname(dir))
    await fsyncDir(quarantineRoot)
    return target
  } catch (error) {
    if (error?.code === 'EXDEV' || error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES') {
      return undefined
    }
    throw error
  }
}

/**
 * Delete a quarantine directory and fsync its parent.
 * @param path - quarantine directory.
 */
export async function deleteQuarantineDir(path) {
  await removePath(path)
  await fsyncDir(dirname(path))
}

/**
 * Remove a canonical session directory directly (fallback when rename is
 * unsupported).
 * @param dir - validated session directory.
 */
export async function deleteSessionDirDirect(dir) {
  await removePath(dir)
  await fsyncDir(dirname(dir))
}

/**
 * Compute the default project directory for one header, used only by the
 * legacy disk fallback.
 * @param header - session header.
 * @returns absolute session directory candidate.
 */
export function defaultSessionDir(header) {
  const root = sessionsRoot()
  const project = header.cwd === undefined ? '_no-cwd' : projectKey(header.cwd)
  return join(root, project, encodeSegment(header.id))
}

/**
 * Ensure the quarantine root exists.
 * @param home - DSH home.
 * @returns quarantine root.
 */
export function quarantineRoot(home) {
  return join(home, '.session-deleter-trash')
}

/**
 * List quarantine entries.
 * @param home - DSH home.
 * @returns absolute entry paths.
 */
export async function listQuarantine(home) {
  const root = quarantineRoot(home)
  try {
    return (await fs.readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/**
 * Whether a path exists and is a directory.
 * @param path - path.
 * @returns true for directories.
 */
export async function isDirectory(path) {
  try {
    return (await fs.lstat(path)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export { exists }
