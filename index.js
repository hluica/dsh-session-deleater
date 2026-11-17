/**
 * Host half: owner-only HTTP API for the session deleter and startup recovery.
 *
 * @module @local/dsh-session-deleater
 */

import { sendJson, readBody } from './lib/fsx.js'
import { API_PREFIX, createDeleteService, DeleteError } from './lib/service.js'
import { assertSessionId } from './lib/ids.js'

/** Stable Loader entry id; equals the bundle patch id. */
export const ENTRY_ID = 'dsh-session-deleater'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-session-deleater'

/** Required host services. Other lifecycle services are probed at call time. */
export const inject = ['webServer', 'connection', 'sessionPersistence']

/**
 * Owner-only admission for one request.
 * @param ctx - Host context.
 * @param req - Node request.
 * @returns an admission result.
 */
function admit(ctx, req) {
  try {
    const admission = ctx.connection.admit(req)
    if (admission !== null && typeof admission === 'object' && 'rejection' in admission) {
      return { ok: false, status: admission.rejection === 401 ? 401 : 403 }
    }
    if (admission?.peer?.principal?.kind !== 'owner') return { ok: false, status: 403 }
    return { ok: true }
  } catch {
    return { ok: false, status: 401 }
  }
}

/**
 * Parse a request path relative to the API prefix.
 * @param req - Node request.
 * @returns normalized path.
 */
function apiPath(req) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith(API_PREFIX)) return '/'
  return url.pathname.slice(API_PREFIX.length) || '/'
}

/**
 * Mount the Host half.
 * @param ctx - Host context.
 */
export function apply(ctx) {
  const service = createDeleteService(ctx)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const admission = admit(ctx, req)
      if (!admission.ok) {
        sendJson(res, admission.status, { ok: false, error: admission.status === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      try {
        const path = apiPath(req)
        if (req.method === 'GET' && path === '/health') {
          sendJson(res, 200, { ok: true, result: service.health() })
          return
        }
        if (req.method === 'GET' && path === '/preview') {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') ?? ''
          assertSessionId(sessionId)
          const result = await service.preview(sessionId)
          sendJson(res, 200, { ok: true, result })
          return
        }
        if (req.method === 'POST' && path === '/delete') {
          let body
          try {
            const raw = await readBody(req)
            body = raw.trim() === '' ? {} : JSON.parse(raw)
          } catch (error) {
            const status = error?.code === 'too-large' ? 413 : 400
            sendJson(res, status, { ok: false, error: status === 413 ? '请求体过大' : '请求体不是合法 JSON' })
            return
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
            return
          }
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          assertSessionId(sessionId)
          const media = body.media === 'purge' ? 'purge' : 'keep'
          const result = await service.deleteSession(sessionId, { media })
          sendJson(res, 200, { ok: true, result })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      } catch (error) {
        if (error instanceof DeleteError) {
          sendJson(res, error.status, {
            ok: false,
            code: error.code,
            error: error.message,
            deletedSubagents: error.deletedSubagents ?? [],
            remainingSessionIds: error.remainingSessionIds ?? [],
            partialFailure: error.partialFailure ?? false,
            quarantinePath: error.quarantinePath,
          })
          return
        }
        const status = error?.code === 'bad-request' ? 400 : 500
        sendJson(res, status, { ok: false, code: error?.code ?? 'internal', error: String(error?.message ?? error) })
      }
    },
  }), 'session-deleater: api')

  ctx.inject(['sessionPersistence'], (child) => {
    child.effect(() => {
      void service.startup().catch(error => {
        try {
          ctx.logger?.warn?.(`session-deleater: startup recovery failed: ${String(error)}`)
        } catch {
          // Logging is best-effort.
        }
      })
    }, 'session-deleater: startup recovery')
  })
}
