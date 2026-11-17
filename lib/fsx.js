/**
 * Small filesystem/HTTP helpers shared by the Host half.
 * @module dsh-session-deleater/fsx
 */

import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Default maximum accepted JSON request body. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Resolve the DSH home directory.
 * @returns `$DSH_HOME` when absolute, otherwise `~/.dsh`.
 */
export function resolveHome() {
  const env = process.env.DSH_HOME
  if (typeof env === 'string' && env !== '' && env.startsWith('/')) return env
  return join(homedir(), '.dsh')
}

/**
 * Resolve a path under the DSH home.
 * @param parts - path segments under the home.
 * @returns the absolute path.
 */
export function homePath(...parts) {
  return join(resolveHome(), ...parts)
}

/**
 * Read one JSON HTTP request body with a hard byte cap.
 * @param req - Node request.
 * @param maxBytes - maximum accepted bytes.
 * @returns the UTF-8 body.
 */
export async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      const error = new Error('请求体过大')
      error.code = 'too-large'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Send one JSON response.
 * @param res - Node response.
 * @param status - HTTP status.
 * @param value - JSON-serializable value.
 */
export function sendJson(res, status, value) {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

/**
 * Race a promise against a timeout.
 * @param operation - promise-like operation.
 * @param ms - timeout in milliseconds.
 * @param label - timeout label.
 * @returns the operation result.
 */
export async function withTimeout(operation, ms, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(Object.assign(new Error(`${label}超时`), { code: 'timeout' }))
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Best-effort `fsync` of a directory.
 * @param path - directory path.
 */
export async function fsyncDir(path) {
  let handle
  try {
    handle = await fs.open(path, 'r')
    await handle.sync()
  } catch {
    // Some filesystems reject directory fsync; deletion already happened.
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * Whether a path exists (any type).
 * @param path - path to test.
 * @returns true when `lstat` succeeds.
 */
export async function exists(path) {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/**
 * Read JSON, returning a fallback for a missing file.
 * @param path - JSON path.
 * @param fallback - value returned when absent.
 * @returns parsed value or fallback.
 */
export async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

/**
 * Atomically replace a small JSON file: temp write, fsync, rename, directory fsync.
 * @param path - destination path.
 * @param value - JSON-serializable value.
 * @param mode - file mode, default 0600.
 */
export async function writeJsonAtomic(path, value, mode = 0o600) {
  const dir = dirname(path)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomBytes(6).toString('hex')}.tmp`
  let handle
  try {
    handle = await fs.open(temp, 'wx', mode)
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temp, path)
    await fsyncDir(dir)
  } catch (error) {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Remove a file or directory recursively, retrying transient Windows locks.
 * @param path - target path.
 */
export async function removePath(path) {
  await fs.rm(path, {
    recursive: true,
    force: true,
    maxRetries: 4,
    retryDelay: 100,
  })
}

/**
 * A tiny cross-process file lock used for the provider upload index and the
 * journal. It is best-effort: a stale lock older than `staleMs` is replaced.
 * @param path - lock path.
 * @param operation - critical section.
 * @param options - timeout and staleness.
 * @returns the operation result.
 */
export async function withFileLock(path, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000
  const staleMs = options.staleMs ?? 30_000
  const deadline = Date.now() + timeoutMs
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  let handle
  const token = randomBytes(12).toString('hex')
  for (;;) {
    try {
      handle = await fs.open(path, 'wx', 0o600)
      await handle.writeFile(token)
      break
    } catch (error) {
      await handle?.close().catch(() => {})
      if (error?.code !== 'EEXIST') throw error
      try {
        const info = await fs.stat(path)
        if (Date.now() - info.mtimeMs > staleMs) {
          await fs.rm(path, { force: true })
          continue
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue
        throw statError
      }
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`锁正被占用: ${path}`), { code: 'locked' })
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  try {
    return await operation()
  } finally {
    await handle?.close().catch(() => {})
    try {
      if (await fs.readFile(path, 'utf8') === token) await fs.rm(path, { force: true })
    } catch {
      // A stale-lock replacement may have removed our token; nothing to do.
    }
  }
}

/**
 * Whether a path is writable for the current user.
 * @param path - path to probe.
 * @returns true when `access(W_OK)` succeeds.
 */
export async function canWrite(path) {
  try {
    await fs.access(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}
