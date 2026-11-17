/**
 * Session identity and on-disk path encoding.
 *
 * The encoding here must match `@deepseek-ai/dsh-session-persistence-jsonl`
 * `src/format.ts` exactly: `encodeSegment` escapes every unsafe UTF-16 code
 * unit to `~XXXX`, and `projectKey` collapses path separators and wraps the
 * readable project name in `--...--`.
 *
 * @module dsh-session-deleater/ids
 */

import { isAbsolute } from 'node:path'

/** Characters that are never accepted inside a session id. */
const UNSAFE_ID = /[\\/\x00-\x1f<>"|?*]/

/**
 * Validate a session id before it is used in a lookup or a path.
 * @param value - candidate id.
 * @returns the same id.
 * @throws {TypeError} when the id is empty, a dot name, or contains path/control characters.
 */
export function assertSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '' || value === '.' || value === '..'
    || UNSAFE_ID.test(value) || /[. ]$/.test(value)) {
    throw Object.assign(new Error('sessionId 必须是合法的会话标识，不能包含路径或特殊目录名'), {
      code: 'bad-request',
    })
  }
  return value
}

/**
 * Encode a session id as one safe path segment, matching DSH's `encodeSegment`.
 * @param raw - non-empty session id.
 * @returns the encoded segment.
 */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('cannot encode an empty path segment')
  }
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Build the human-readable project directory key for a cwd, matching DSH's
 * `projectKey`. Separator replacement and truncation are intentionally lossy.
 * @param cwd - absolute session working directory.
 * @returns one filesystem-safe project directory name.
 */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * Candidate session-directory names for one id.
 *
 * The canonical encoded segment is primary. Raw ids and the old `--id--`
 * project-key form are accepted only as compatibility fallbacks; the header id
 * is verified before anything is deleted.
 * @param id - session id.
 * @returns unique candidate directory names, primary first.
 */
export function candidateSessionDirs(id) {
  assertSessionId(id)
  const canonical = encodeSegment(id)
  const candidates = [canonical]
  if (id !== canonical) candidates.push(id)
  const legacy = `--${id}--`
  if (legacy !== canonical && legacy !== id) candidates.push(legacy)
  return [...new Set(candidates)]
}

/**
 * Whether a file name is a canonical DSH session-log generation.
 * @param name - one directory entry name.
 * @returns its numeric generation, or undefined when non-canonical.
 */
export function sessionArtifactVersion(name) {
  const match = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/.exec(name)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/**
 * Validate the immutable session header fields this plugin relies on.
 * @param value - parsed header candidate.
 * @returns the header.
 */
export function assertHeader(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('session header 不是 JSON 对象')
  }
  assertSessionId(value.id)
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw new Error('session header 缺少合法的 createdAt')
  }
  if (value.cwd !== undefined && (typeof value.cwd !== 'string' || !isAbsolute(value.cwd))) {
    throw new Error('session header 的 cwd 不是绝对路径')
  }
  return value
}

/**
 * Stable lifecycle identity used by cache/history comparisons.
 * @param header - session header.
 * @returns a string that distinguishes recreations under the same id.
 */
export function lifecycleKey(header) {
  return JSON.stringify([
    header?.createdAt ?? null,
    header?.cwd ?? null,
    header?.isSeeded === true,
  ])
}
