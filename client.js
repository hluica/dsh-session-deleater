/**
 * Client half: one title-bar delete action and one sidebar row-menu entry.
 *
 * The confirmation dialog lives in `shell.overlay`, not inside the row menu:
 * the shared menu unmounts its occupants when it closes, so a dialog rendered
 * by an occupant would disappear with the menu.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-session-deleater',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    let IconTrash
    try {
      IconTrash = require('@deepseek-ai/dsh-client-ui-primitives')?.IconTrashOutlineRegular
    } catch {
      IconTrash = undefined
    }

    const API = '/session-deleater/api'
    const NS = 'dsh-session-deleater'

    const zh = (() => {
      const lang = (typeof navigator !== 'undefined' ? navigator.language : '') || ''
      const documentLang = typeof document !== 'undefined' ? document.documentElement.lang : ''
      return `${lang} ${documentLang}`.toLowerCase().includes('zh')
    })()

    const T = zh ? {
      delete: '删除会话',
      title: '删除会话',
      confirm: '确认删除',
      cancel: '取消',
      close: '关闭',
      retry: '重试',
      deleting: '正在删除…',
      previewing: '正在检查会话…',
      description: (title) => `确定删除“${title}”？此操作不可撤销。`,
      localOnly: '只删除本机 DSH 存储中的日志、缓存、工作区引用和客户端状态。',
      external: '不会撤回已发送给模型 provider 的日志/图片，也不会删除导出文件、备份或工作区文件。',
      running: '该会话正在运行；删除会立即中断它。',
      hot: '这是已加载的热会话；当前进程内的内存资源会保留到重启。',
      subagents: (n) => `将连带删除 ${n} 个子智能体会话。`,
      childOnly: '这是子智能体会话；父会话日志中的引用仍会保留。',
      schedule: (n) => `有 ${n} 个计划任务引用该会话。`,
      scheduleDefault: '默认只停止正在运行的计划任务；已暂停/结束的任务会保留。',
      schedulePurge: '勾选后会一并删除所有引用该会话的计划任务。',
      purge: '同时清理仅属于该会话的附件',
      purgeHint: '共享附件保留；没有 live 会话时立即执行，否则下次启动执行。',
      unsupported: '当前 DSH 版本缺少热删除所需的内部能力，请重启 DSH 后再删除。',
      failed: '删除失败',
      notFound: '会话不存在或已经删除。',
      deleted: '会话已删除。',
      partial: (deleted, remaining) => `部分完成：已删除 ${deleted} 个，剩余 ${remaining} 个。`,
      remaining: (ids) => `未完成：${ids.join(', ')}`,
      warnings: '警告',
      quarantine: (path) => `残留隔离目录：${path}`,
      mediaPending: '媒体清理将在下次启动、确认没有 live 会话时执行。',
      navigationFailed: '会话已删除，但自动打开其他会话失败；请从侧边栏选择要打开的会话。',
      noPreview: '无法完成删除前检查。',
    } : {
      delete: 'Delete session',
      title: 'Delete session',
      confirm: 'Delete',
      cancel: 'Cancel',
      close: 'Close',
      retry: 'Retry',
      deleting: 'Deleting…',
      previewing: 'Checking session…',
      description: (title) => `Delete “${title}”? This cannot be undone.`,
      localOnly: 'Removes the local DSH log, cache, workspace references, and client state.',
      external: 'Does not retract logs/images already sent to a model provider, and does not delete exports, backups, or workspace files.',
      running: 'This session is running; deletion interrupts it immediately.',
      hot: 'This Session is loaded; in-memory Agent resources remain until the next restart.',
      subagents: (n) => `${n} subagent session${n === 1 ? '' : 's'} will be deleted too.`,
      childOnly: 'This is a subagent session; the parent log keeps its reference.',
      schedule: (n) => `${n} scheduled task${n === 1 ? '' : 's'} reference this session.`,
      scheduleDefault: 'Only running target tasks are stopped by default; paused or ended references remain.',
      schedulePurge: 'Ticking the media option also deletes every task that references this session.',
      purge: 'Also clean attachments used only by this session',
      purgeHint: 'Shared attachments stay; runs immediately when no live Session remains, otherwise on the next start.',
      unsupported: 'This DSH build lacks the internal capability for live deletion. Restart DSH and retry.',
      failed: 'Delete failed',
      notFound: 'Session not found or already deleted.',
      deleted: 'Session deleted.',
      partial: (deleted, remaining) => `Partial: ${deleted} deleted, ${remaining} remaining.`,
      remaining: (ids) => `Remaining: ${ids.join(', ')}`,
      warnings: 'Warnings',
      quarantine: (path) => `Quarantine directory left behind: ${path}`,
      mediaPending: 'Media cleanup will run on the next start when no live Session remains.',
      navigationFailed: 'Session deleted, but opening another Session failed; choose one from the sidebar.',
      noPreview: 'Could not complete the pre-delete check.',
    }

    const CSS = `
.dsd-header-button{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;flex:0 0 auto}
.dsd-header-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsd-header-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}
.dsd-menu-button{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:0 10px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-state-error-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;text-align:start;cursor:pointer}
.dsd-menu-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsd-menu-button:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dsd-menu-icon{display:inline-flex;flex:0 0 auto}
.dsd-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb, var(--dsw-alias-bg-base) 35%, rgba(0,0,0,.35));padding:24px}
.dsd-dialog{width:min(540px,100%);max-height:min(760px,calc(100vh - 48px));overflow:auto;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 16px 48px rgba(0,0,0,.24);font-family:var(--dsw-font-family);font-size:14px;line-height:22px}
.dsd-dialog:focus{outline:none}
.dsd-dialog-head{padding:18px 20px 8px;font-size:16px;font-weight:600;line-height:24px}
.dsd-dialog-body{display:flex;flex-direction:column;gap:10px;padding:0 20px 16px}
.dsd-muted{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsd-warning{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}
.dsd-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsd-success{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary));font-size:13px;line-height:20px}
.dsd-check{display:flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsd-check input{margin:3px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.dsd-actions{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px 18px;border-top:.5px solid var(--dsw-alias-border-l2)}
.dsd-btn{height:34px;padding:0 14px;border-radius:var(--dsw-radius-sm);border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;cursor:pointer}
.dsd-btn:not(.dsd-btn-danger):hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsd-btn:disabled{opacity:.5;cursor:default}
.dsd-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:2px}
.dsd-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color,#fff)}
.dsd-btn-danger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color,#fff);filter:brightness(.94)}
.dsd-error{border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);padding:8px 10px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;white-space:pre-wrap}
.dsd-list{margin:0;padding-inline-start:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
`

    /** Inject the stylesheet once per page, owned by this plugin's effect. */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = NS
      style.textContent = CSS
      document.head.appendChild(style)
      return () => style.remove()
    }

    /** Read the current client selection id. */
    function currentSessionId() {
      try {
        const raw = localStorage.getItem('dsh.sessions.current')
        if (raw === null) return undefined
        const value = JSON.parse(raw)
        return typeof value?.sessionId === 'string' ? value.sessionId : undefined
      } catch {
        return undefined
      }
    }

    /**
     * Remove browser state keyed by one session id.
     * @param id - deleted session id.
     */
    function removeSessionLocalState(id, keepCurrent = false) {
      const keys = [
        `dsh.conversation.${id}`,
        `dsh.sidebar-right.v1.${id}`,
        `dsh.sidebar-browser.v1.${id}`,
        `dsh.user-questions.drafts.v1.${id}`,
        `dsh.schedule.task-tab.v1.${id}`,
      ]
      try {
        for (const key of keys) localStorage.removeItem(key)
        if (!keepCurrent && currentSessionId() === id) localStorage.removeItem('dsh.sessions.current')
        const raw = localStorage.getItem('dsh.workspace.view.v5')
        if (raw !== null) {
          const value = JSON.parse(raw)
          if (value !== null && typeof value === 'object' && value.sessionOrderByAccount !== null
            && typeof value.sessionOrderByAccount === 'object') {
            for (const account of Object.keys(value.sessionOrderByAccount)) {
              const order = value.sessionOrderByAccount[account]
              if (Array.isArray(order)) value.sessionOrderByAccount[account] = order.filter(item => item !== id)
            }
            localStorage.setItem('dsh.workspace.view.v5', JSON.stringify(value))
          }
        }
      } catch {
        // Browser storage may be unavailable; the Host data is already deleted.
      }
    }

    /** Session ids currently retained by the main conversation view. */
    function mainSessionIds(ctx) {
      const list = ctx.sessions.list.getSnapshot()
      return Object.values(list.byId)
        .filter(summary => (summary.retainedBy?.mainView ?? 0) > 0)
        .map(summary => summary.id)
    }

    /** Try a public openSession; a stale target must not block the next candidate. */
    function tryOpenSession(ctx, id) {
      try {
        ctx.uiWorkspace.openSession(id)
        return true
      } catch (reason) {
        console.warn('session-deleater: could not open the next Session', id, reason)
        return false
      }
    }

    /** Recent surviving top-level Sessions in one Workspace, or globally when omitted. */
    function recentSurvivingSessions(ctx, workspaceId, excluded, archived) {
      const sessions = ctx.sessions.list.getSnapshot()
      const workspaces = ctx.workspaces.list.getSnapshot()
      const ids = workspaceId === undefined
        ? sessions.ids
        : (workspaces.items.find(item => item.workspaceId === workspaceId)?.sessionIds ?? [])
      const rows = []
      for (const id of ids) {
        if (excluded.has(id) || archived.has(id)) continue
        const summary = sessions.byId[id]
        if (summary === undefined || summary.blank === true || summary.origin === 'subagent') continue
        rows.push(summary)
      }
      rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      return rows.map(row => row.id)
    }

    /** Leave a deleted current Session through public uiWorkspace navigation only. */
    async function leaveDeletedCurrent(ctx, { workspaceId, parentId, deletedIds }) {
      const excluded = new Set(deletedIds)
      const workspaces = ctx.workspaces.list.getSnapshot()
      const archived = new Set(workspaces.archivedSessionIds)
      const owning = workspaceId
        ?? workspaces.items.find(item => item.sessionIds.some(id => excluded.has(id)))?.workspaceId
      if (parentId !== undefined && !excluded.has(parentId) && !archived.has(parentId)
        && tryOpenSession(ctx, parentId)) return
      for (const id of recentSurvivingSessions(ctx, owning, excluded, archived)) {
        if (tryOpenSession(ctx, id)) return
      }
      if (owning !== undefined) {
        try {
          const created = await ctx.uiWorkspace.connectWorkspace(owning)
          if (!excluded.has(created) && tryOpenSession(ctx, created)) return
        } catch (reason) {
          console.warn('session-deleater: could not create a blank Session after delete', reason)
        }
      }
      for (const id of recentSurvivingSessions(ctx, undefined, excluded, archived)) {
        if (tryOpenSession(ctx, id)) return
      }
      ctx.uiWorkspace.startSession()
    }

    /** Ask the workspace/session controllers to drop deleted rows. */
    async function refresh(ctx) {
      try { await ctx.sessions?.refresh?.() } catch { /* list refresh is best-effort */ }
      try { await ctx.workspaces?.refresh?.() } catch { /* list refresh is best-effort */ }
    }

    /** Fetch one preview and normalize failures. */
    async function fetchPreview(id) {
      const response = await fetch(`${API}/preview?sessionId=${encodeURIComponent(id)}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw new Error(`${T.noPreview} HTTP ${response.status}`)
      }
      if (!response.ok || payload?.ok !== true) {
        throw Object.assign(new Error(payload?.error ?? T.noPreview), { payload, status: response.status })
      }
      return payload.result
    }

    /** Call the Host delete endpoint. */
    async function requestDelete(id, media) {
      const response = await fetch(`${API}/delete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sessionId: id, media }),
      })
      let payload
      try {
        payload = await response.json()
      } catch {
        throw Object.assign(new Error(`删除请求失败 HTTP ${response.status}`), { payload: undefined, status: response.status })
      }
      if (!response.ok || payload?.ok !== true) {
        throw Object.assign(new Error(payload?.error ?? '删除失败'), { payload, status: response.status })
      }
      return payload.result
    }

    /** The one delete request, shared by the two entry points and the overlay. */
    const deleteUi = (() => {
      let current
      const listeners = new Set()
      const notify = () => { for (const listener of listeners) listener() }
      return {
        get: () => current,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        open(request) {
          current = request
          notify()
        },
        close() {
          current = undefined
          notify()
        },
      }
    })()

    /** Build the trash glyph; the shared primitive is preferred. */
    function TrashGlyph(size) {
      if (typeof IconTrash === 'function') return h(IconTrash, { width: size, height: size })
      return h('svg', {
        viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': 'true',
      }, h('path', {
        d: 'M5 7h14M9.5 7V5.2c0-.66.54-1.2 1.2-1.2h2.6c.66 0 1.2.54 1.2 1.2V7M8 7l.7 11.1A1.7 1.7 0 0 0 10.4 20h3.2a1.7 1.7 0 0 0 1.7-1.9L16 7M10.3 10.5l.2 5M13.7 10.5l-.2 5',
        stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round',
      }))
    }

    /** One confirmation dialog, mounted by the stable shell overlay. */
    function DeleteDialog({ ctx, sessionId, displayTitle, running, workspaceId, isCurrent, currentId, parentId, onClose }) {
      const [preview, setPreview] = React.useState(undefined)
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState(undefined)
      const [details, setDetails] = React.useState(undefined)
      const [busy, setBusy] = React.useState(false)
      const [purge, setPurge] = React.useState(false)
      const [attempt, setAttempt] = React.useState(0)
      const [completion, setCompletion] = React.useState(undefined)
      const dialogRef = React.useRef(null)
      const focusRef = React.useRef(null)
      const previousFocus = React.useRef(null)
      const busyRef = React.useRef(false)
      busyRef.current = busy

      React.useEffect(() => {
        previousFocus.current = typeof document !== 'undefined' ? document.activeElement : null
        if (focusRef.current !== null && focusRef.current.disabled !== true) focusRef.current.focus()
        else dialogRef.current?.focus?.()
        const node = dialogRef.current
        const focusables = () => node === null ? [] : [...node.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )]
        const onKey = event => {
          if (event.key === 'Escape') {
            event.preventDefault()
            if (!busyRef.current) onClose()
            return
          }
          if (event.key !== 'Tab') return
          const items = focusables()
          if (items.length === 0) return
          const first = items[0]
          const last = items[items.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('keydown', onKey)
          try { previousFocus.current?.focus?.() } catch { /* focus restore is best-effort */ }
        }
      }, [onClose])

      React.useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(undefined)
        setDetails(undefined)
        fetchPreview(sessionId).then(
          value => {
            if (cancelled) return
            setPreview(value)
            setLoading(false)
          },
          reason => {
            if (cancelled) return
            setError(reason?.message ?? String(reason))
            setDetails(reason?.payload)
            setLoading(false)
          },
        )
        return () => { cancelled = true }
      }, [sessionId, attempt])

      const title = preview?.displayTitle ?? displayTitle ?? sessionId
      const isLive = preview?.live === true
      const isRunning = preview?.running === true || running === true
      const unsupported = preview?.canDelete === false
      const disabled = loading || busy || unsupported
      const purgeLabel = preview?.scheduleRefs > 0 ? `${T.purge}；${T.schedulePurge}` : T.purge

      /** Clean every deleted id, including cascaded descendants. */
      async function settle(result) {
        const deletedIds = [
          ...(result?.deleted === true ? [sessionId] : []),
          ...(Array.isArray(result?.deletedSubagents) ? result.deletedSubagents : []),
        ]
        const mainIds = mainSessionIds(ctx)
        const currentDeleted = (currentId !== undefined && deletedIds.includes(currentId))
          || deletedIds.some(id => mainIds.includes(id))
          || (isCurrent === true && deletedIds.includes(sessionId))
        let navigationFailed = false
        if (currentDeleted) {
          try {
            await leaveDeletedCurrent(ctx, { workspaceId, parentId, deletedIds })
          } catch (reason) {
            navigationFailed = true
            console.warn('session-deleater: navigation after delete failed', reason)
          }
        }
        for (const id of deletedIds) removeSessionLocalState(id, currentDeleted && !navigationFailed)
        await refresh(ctx)
        return navigationFailed ? T.navigationFailed : undefined
      }

      async function confirm() {
        if (disabled || completion !== undefined) return
        setBusy(true)
        setError(undefined)
        setDetails(undefined)
        try {
          const result = await requestDelete(sessionId, purge ? 'purge' : 'keep')
          const navigationWarning = await settle(result)
          const warnings = Array.isArray(result?.warnings) ? [...result.warnings] : []
          if (navigationWarning !== undefined) warnings.push(navigationWarning)
          if (result?.mediaPending) warnings.push(T.mediaPending)
          if (result?.deleted === false) warnings.push(T.notFound)
          if (warnings.length > 0 || result?.partialFailure || result?.quarantinePath) {
            setCompletion({ ...result, warnings })
            setBusy(false)
            return
          }
          onClose()
        } catch (reason) {
          setError(reason?.message ?? String(reason))
          setDetails(reason?.payload)
          setBusy(false)
        }
      }

      function retry() {
        setError(undefined)
        setDetails(undefined)
        setCompletion(undefined)
        setLoading(true)
        setAttempt(value => value + 1)
      }

      const completionIds = completion?.remainingSessionIds
      const body = h('div', {
        className: 'dsd-overlay',
        onMouseDown: event => {
          if (event.target === event.currentTarget && !busy) onClose()
        },
      },
        h('div', {
          ref: dialogRef,
          className: 'dsd-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-busy': busy,
          'aria-labelledby': 'dsd-title',
          'aria-describedby': 'dsd-desc',
          tabIndex: -1,
        },
          h('div', { id: 'dsd-title', className: 'dsd-dialog-head' }, T.title),
          h('div', { className: 'dsd-dialog-body' },
            h('div', { id: 'dsd-desc' }, loading ? T.previewing : T.description(title)),
            h('div', { className: 'dsd-muted' }, T.localOnly),
            h('div', { className: 'dsd-warning' }, T.external),
            isRunning ? h('div', { className: 'dsd-warning' }, T.running) : null,
            isLive ? h('div', { className: 'dsd-hint' }, T.hot) : null,
            preview?.subagentCount > 0 ? h('div', { className: 'dsd-warning' }, T.subagents(preview.subagentCount)) : null,
            preview?.childOnlyWarning ? h('div', { className: 'dsd-hint' }, T.childOnly) : null,
            preview?.scheduleRefs > 0 ? h('div', { className: 'dsd-hint' }, T.schedule(preview.scheduleRefs)) : null,
            preview?.scheduleRefs > 0 ? h('div', { className: 'dsd-hint' }, purge ? T.schedulePurge : T.scheduleDefault) : null,
            unsupported ? h('div', { className: 'dsd-error' }, T.unsupported) : null,
            completion === undefined
              ? h('div', null,
                h('label', { className: 'dsd-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: purge,
                    disabled: busy || unsupported,
                    onChange: event => setPurge(event.target.checked),
                  }),
                  h('span', null, purgeLabel),
                ),
                h('div', { className: 'dsd-hint' }, T.purgeHint),
              )
              : h('div', { className: 'dsd-success' }, completion.deleted === false ? T.notFound : T.deleted),
            completion !== undefined && completion.warnings?.length > 0
              ? h('div', null,
                h('div', { className: 'dsd-hint' }, T.warnings),
                h('ul', { className: 'dsd-list' },
                  completion.warnings.map((warning, index) => h('li', { key: index }, String(warning))),
                ),
              )
              : null,
            completion?.partialFailure
              ? h('div', { className: 'dsd-warning' },
                T.partial(completion.deletedSubagents?.length ?? 0, completionIds?.length ?? 0))
              : null,
            completionIds?.length > 0 ? h('div', { className: 'dsd-hint' }, T.remaining(completionIds)) : null,
            completion?.quarantinePath ? h('div', { className: 'dsd-hint' }, T.quarantine(completion.quarantinePath)) : null,
            error !== undefined
              ? h('div', { className: 'dsd-error' },
                `${T.failed}: ${error}`,
                details?.deletedSubagents?.length
                  ? `\n${T.partial(details.deletedSubagents.length, details.remainingSessionIds?.length ?? 0)}`
                  : '',
              )
              : null,
          ),
          h('div', { className: 'dsd-actions' },
            completion !== undefined
              ? h('button', { type: 'button', className: 'dsd-btn', onClick: onClose }, T.close)
              : error !== undefined
                ? h(React.Fragment, null,
                  h('button', { type: 'button', className: 'dsd-btn', disabled: busy, onClick: retry }, T.retry),
                  h('button', { type: 'button', className: 'dsd-btn', disabled: busy, onClick: onClose }, T.close),
                )
                : h(React.Fragment, null,
                  h('button', { type: 'button', className: 'dsd-btn', disabled: busy, onClick: onClose }, T.cancel),
                  h('button', {
                    ref: focusRef,
                    type: 'button',
                    className: 'dsd-btn dsd-btn-danger',
                    disabled,
                    onClick: confirm,
                  }, busy ? T.deleting : T.confirm),
                ),
          ),
        ),
      )
      return body
    }

    /** Stable overlay owner: outlives the sidebar menu that opened it. */
    function DeleteOverlay({ ctx }) {
      const request = React.useSyncExternalStore(deleteUi.subscribe, deleteUi.get, deleteUi.get)
      if (request === undefined) return null
      return h(DeleteDialog, { ...request, ctx, onClose: deleteUi.close })
    }

    /** Title-bar action. */
    function HeaderAction(props) {
      const running = props.useSessionStatus?.(map => map.get(props.sessionId)?.running === true) ?? false
      const workspaces = props.useWorkspaces?.(snapshot => snapshot.items) ?? []
      const workspaceId = workspaces.find(item => item.sessionIds.includes(props.sessionId))?.workspaceId
      const parentId = props.ctx?.sessions?.subagentAddress?.(props.sessionId)?.parentSessionId
      return h('button', {
        type: 'button',
        className: 'dsd-header-button',
        title: T.delete,
        'aria-label': T.delete,
        onClick: event => {
          event?.stopPropagation?.()
          deleteUi.open({
            sessionId: props.sessionId,
            displayTitle: undefined,
            running,
            workspaceId,
            isCurrent: true,
            currentId: props.sessionId,
            parentId,
          })
        },
      }, TrashGlyph(16))
    }

    /** Sidebar row menu action. */
    function MenuRow(props) {
      const [, setMenuOpen] = props.useMenuOpenState()
      const running = props.useSessionStatus?.(map => map.get(props.sessionId)?.running === true) ?? false
      const workspaces = props.useWorkspaces?.(snapshot => snapshot.items) ?? []
      const workspaceId = workspaces.find(item => item.sessionIds.includes(props.sessionId))?.workspaceId
      const currentId = mainSessionIds(props.ctx)[0] ?? currentSessionId()
      const openDialog = () => {
        setMenuOpen(false)
        deleteUi.open({
          sessionId: props.sessionId,
          displayTitle: props.displayTitle,
          running,
          workspaceId,
          isCurrent: currentId === props.sessionId,
          currentId,
        })
      }
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsd-menu-button',
        onClick: openDialog,
      },
        h('span', { className: 'dsd-menu-icon' }, TrashGlyph(14)),
        h('span', null, T.delete),
      )
    }

    return {
      inject: ['slots', 'uiWorkspace', 'sessions', 'workspaces'],
      apply(ctx) {
        ctx.effect(() => installStyles(), 'session-deleater: styles')
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-deleater-overlay',
          order: 0,
        }, props => h(DeleteOverlay, { ...props, ctx })))
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions',
          id: 'session-deleater-header',
          order: 30,
        }, props => h(HeaderAction, { ...props, ctx })))
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-deleater-menu',
          order: 550,
        }, props => h(MenuRow, { ...props, ctx })))
      },
    }
  },
})
