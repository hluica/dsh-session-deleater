# 会话删除插件实施可行性（dsh-session-deleater）

- 插件目录：`dsh-session-deleater`
- 计划包名：`@local/dsh-session-deleater`
- 计划版本：`0.1.0`
- 目标 DSH 版本：`0.2.2-rc.3`（Desktop，`DSH_PROFILE=desktop`）
- 设计日期：2026-11-17
- 状态：**设计阶段，待用户确认；本轮不产生实现代码。**
- 关联文档：
  - [`TRACE.md`](TRACE.md)：对当前版本会话生成、落盘、缓存与外部副本的独立追踪，以及第 10 节的安全删除综合判断。
  - [`REF-IMPLEMENTATION.md`](REF-IMPLEMENTATION.md)：对既有 `dsh-session-manager` 0.7.8 删除实现的调查记录。**本文不重复其实现细节**；它仅作为来源、许可证与历史证据保留。

---

## 1 目的与范围

### 1.1 目的

构建一个独立插件，在 DSH Web/Desktop 中安全地删除单个会话，并满足：

1. 删除本机 DSH 存储中的会话日志、投影缓存、工作区/计划任务引用与客户端会话状态；
2. 不误删工作区文件、不误删其它会话共享的附件、不误删同 id 的新生命周期；
3. 删除失败或进程崩溃后可诊断、可重入，不产生“文件还在、列表已消失”的 torn state；
4. 对热会话、附件、provider 副本等无法完全删除的内容，给出明确的范围承诺，而不是假装“彻底”。

### 1.2 范围

**本插件负责：**

- `<DSH_HOME>/sessions/<project>/<session>/` 下的会话日志目录（含全部格式代际、锁文件、临时文件）；
- `<DSH_HOME>/storages/session_projcache/sessions/<id>.json` 及其旧版聚合形式；
- `<DSH_HOME>/storages/workspace.json` 中的 `sessionIds`、`pinnedSessionIds`、`archivedSessionIds`；
- `<DSH_HOME>/storages/schedule.json` 中引用该会话的任务（默认只停 active target，安全彻底模式清理全部引用）；
- 浏览器 `localStorage` 中按会话 id 保存的草稿、侧栏布局、Browser tab、问题草稿、计划任务 tab 绑定、当前选择等；
- 可选：仅被该会话引用的附件对象、request-image 缓存、provider 上传索引、spill 文件。

**本插件不负责、也不承诺：**

- 会话 `cwd` 下的工作区文件、项目目录、Git worktree；
- 已发送给模型 provider 的官方 `dsh_session_log` 副本；
- 已上传到 provider Files API 的远端文件；
- OTel/产品分析/反馈导出/用户手动导出的文件；
- 操作系统备份、Time Machine、APFS 快照；
- Electron LevelDB 的取证级擦除、Chromium HTTP 缓存；
- 多租户授权；本插件只服务本机 owner。

### 1.3 术语

| 术语 | 含义 |
|---|---|
| 冷会话 | 当前进程中 `ctx.sessions.get(id) === undefined`，仅存在于持久化存储。 |
| 热会话 | 当前进程中已加载 Session/Agent，存在 live 写句柄或可运行 turn。 |
| 提交点 | 本设计中指会话目录 `rename` 到隔离区的时刻；之后 canonical 路径已消失，删除语义已成立。 |
| 投影缓存 | `session_projcache` 域的逐会话 checkpoint，包含标题、统计、提示词摘要等。 |
| safe 模式 | 默认模式：删除日志/缓存/引用/客户端状态，保留附件与外部副本。 |
| secure purge | 可选模式：额外回收仅被该会话引用的媒体，并清 request-image/provider 索引；仍不撤回远端副本。 |

---

## 2 结论摘要

| 问题 | 结论 | 依据 |
|---|---|---|
| DSH 是否提供官方会话删除 API | **没有** | `SessionPersistence` 只有 `create/open/stat/list/flush`；README 明确“no deletion API”；workspace 把会话删除列为未提供能力。 |
| 能否安全删除冷会话 | **可以，接近事务性** | 用 `rename` 作为提交点 + journal + 启动清理；不依赖 live 私有面。 |
| 能否删除热会话 | **可以删数据，不能立刻删干净内存** | 非公开 `sessions.store`/`entry.detach` + `agents.detachEntered` + `tracker` 可完成注册脱离；Agent scoped 资源留到进程退出。 |
| 投影缓存会不会复活 | **用 tombstone 可以阻止本进程迟到写入** | `session/disposed` 仍会触发 `put`；必须在 detach 前安装生命周期 tombstone，并在提交后 `table.delete`。 |
| 附件要不要删 | **默认保留，secure purge 可选** | 内容寻址、跨会话共享；实测 118 个对象中 3 个被两个会话共同引用。 |
| 外部副本能不能删 | **不能** | 官方日志已上传、provider Files API 有远端文件、OTel/导出/备份均在工作区外。 |
| 是否需要重启 DSH | **实现完成后需要** | Host 插件与 Client bundle 变化不会在当前页面自动生效。 |
| 实现规模 | **约 1,200–1,800 行** | Host 600–800、Client 300–500、测试 200–400、文档/构建 100–200。 |

**一句话判断：** 做一个“本机安全删除”插件是可行的；正确做法不是 `rm -rf`，而是“冷热分层 + rename 提交点 + journal + 缓存 tombstone + 能力探测”。

---

## 3 依据

### 3.1 会话工件模型

一个会话在本机留下的工件：

| 工件 | 位置 | 说明 |
|---|---|---|
| 会话日志 | `~/.dsh/sessions/<projectKey>/<encodeSegment(id)>/session.vN.jsonl.zstd` | v4 当前；v0–v3 保留；必须删整个目录 |
| 写锁 | 同目录 `session.lock` | POSIX `flock`；持锁期间不能 unlink |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<id>.json` | 标题、统计、`turnOutline.prompt`、`titleInput` 等 |
| 工作区成员 | `~/.dsh/storages/workspace.json` | `tables.workspaces[*].sessionIds` |
| 工作区 pin/archive | 同上 | `global.pinnedSessionIds` / `global.archivedSessionIds` |
| 计划任务 | `~/.dsh/storages/schedule.json` | `target.sessionId`、`involvedSessionIds`、`pendingDelivery.targetSessionId` |
| 图片附件 | `~/.dsh/attachments/v1/objects/<2hex>/<sha256>` | 内容寻址，可共享 |
| 文件附件 | `file-objects/<2hex>/<digest>` 与 `files/<2hex>/<digest>/<name>` | 内容寻址 + 硬链接引用 |
| request-image 缓存 | `~/.dsh/cache/attachments/request-images/<2hex>/<hash>` | 派生图片，不能按 attachmentId 反查 |
| provider 上传索引 | `~/.dsh/llm-deepseek/files-v3.json` | `attachmentId → fileId`，远端文件另存 |
| spill 文件 | 默认 OS 临时目录；可配置 root | 会话级目录，默认 30 天清理 |
| 客户端状态 | Electron localStorage | 草稿、侧栏布局、Browser tab、问题草稿、当前选择 |
| 外部副本 | provider / OTel / 导出 / 备份 | 本机删除无法撤回 |

### 3.2 运行时证据

2026-11-17 追踪时的实际盘点：

| 指标 | 值 | 说明 |
|---|---:|---|
| 会话目录 | 31 | 全部 `session.v4.jsonl.zstd` |
| 投影缓存记录 | 35 | 其中 **4 份**对应日志已不存在 |
| 孤儿缓存内容 | 4 | 仍含标题与 `turnOutline.prompt` 提示词片段 |
| 附件对象 | 118 | 全部至少被一个会话引用 |
| 共享附件 | 3 | 同一 attachmentId 出现在两个会话 |
| provider 上传记录 | 118 | `files-v3.json` 全部有映射 |
| 当前会话官方日志上传 | 追踪时 159 条 accepted，`throughSeq=1219` | 本地删除不能撤回 |
| workspace | 15 个、28 个会话引用 | pin/archive 均为 0 |

这些数字是快照，不是契约；但它们证明了：

1. 只删日志会留下缓存中的标题/提示词（4 份孤儿）；
2. 附件不能按会话盲删（3 份共享）；
3. “本机删除”不等于“provider 删除”（159 条已上传）。

### 3.3 DSH 能力与符号依据

| 能力 | 现状 | 本插件用法 |
|---|---|---|
| `SessionPersistence` 删除 API | 不存在 | 带外删除文件/缓存 |
| `AgentHandle.dispose()` | 只返回给创建者 | 插件拿不到；热删除用非公开 registry detach |
| `ctx.sessions` 按 id 移除 | 不存在 | 用 `sessions.store` + `entry.detach()`（非公开） |
| `ctx.agents` 按 id dispose | 不存在 | 用 `agents.store` + `detachEntered(entry)`（非公开） |
| `sessionProjectionCache` 删除 | 无公开 API | `requireTable()`/`storageDomain.get` + 生命周期 tombstone |
| `workspace.detachSession`/`unpinSession`/`unarchiveSession` | 公开 | 直接调用 |
| `workspace/session-stop` | 公开 parallel 事件 | 停止 turn/jobs/subagents/schedule active |
| `schedule.list`/`edit` | 公开 | secure purge 清理全部引用 |
| `api-session/removed` | Host 内部 emit 事件 | 冷会话通知 API 列表移除 |
| `session/disposed` | `(session: Session) => void` | live 会话由真实 `entry.detach()` 发出；冷会话不得伪造 |

### 3.4 设计不变量

1. **日志 append-only**：不能原地改写；删除只能整目录删除。
2. **内容寻址附件共享**：删除前必须扫描剩余会话引用；不能读全量剩余会话时保留。
3. **单写者**：写锁保护 writer；删除不得在持锁 writer 活跃时 unlink 锁文件。
4. **懒物化**：创建不等于落盘；pending 会话可能没有目录。
5. **缓存写后**：`session/disposed` 仍会触发缓存 `put`；必须 tombstone。
6. **外部副本不可撤回**：产品必须分层承诺。

### 3.5 参考文档的定位

- `REF-IMPLEMENTATION.md` 记录的是“既有插件怎么做”的调查，不是本插件的规范；本文的实现决策以其结论与 `TRACE.md` 的证据为基础，只在许可证与历史来源处引用它。
- `TRACE.md` §10 是本文安全判断的直接来源；本文把它收敛为可执行的契约、阶段和验收。

---

## 4 核心进路

### 4.1 总体架构

```text
dsh-session-deleater/
  package.json
  cordis.patch.yml
  index.js                  # Host 入口：路由、认证、能力探测
  client.js                 # Client 入口：slot、确认框、刷新
  icon.svg
  locale/en.json
  locale/zh.json
  lib/
    session-files.js        # ID/路径/header/zstd 读取与校验
    delete-service.js       # 预检、停止、提交、清理主流程
    journal.js              # intent 持久化与重放
    startup-reaper.js       # 隔离区、孤儿缓存、dangling pin/archive
    media-purge.js          # secure purge：附件引用扫描与回收
    compat/
      session-lifecycle.js  # writer 收集/关闭、私有面探测
      projection-cache.js   # tombstone、table.delete、旧版聚合
      private-state.js      # sessions.store/agents.store 封装
  scripts/                  # 由 build-system/sync.mjs 同步
  README.md
  FEASIBILITY@0.2.2-rc.3.md
  REF-IMPLEMENTATION.md
  TRACE.md
```

Host 插件：

- `inject = ['webServer', 'workspaceRegistry', 'sessions', 'agents', 'sessionPersistence', 'sessionProjectionCache', 'connection']`；
- `schedule`、`spillStore`、`storageDomain` 可选，缺失时降级并 warning；
- 零 npm 依赖：只用 `node:fs`、`node:path`、`node:crypto`、`node:zlib`、`node:stream` 等内置模块；
- Client 使用公开 slot，不依赖私有 Client 结构。

### 4.2 删除提交点：rename

**不要在“已 detach、尚未 rm”的窗口做不可逆清理。** 采用：

1. 预检、停止活动、`flush`、安装 cache tombstone；
2. 把会话目录 `rename` 到 `<DSH_HOME>/.session-deleter-trash/<ts>-<encoded-id>-<rand>/`；
3. rename 成功后 canonical 路径原子消失，删除语义成立；
4. 再做 detach/关闭 writer/删除隔离目录/清缓存/workspace/客户端；
5. 任何后续失败只影响残留清理，不会产生“文件还在、列表没了”；
6. 崩溃后由 journal + 启动清理完成。

为什么放在 `sessions` 根之外：

- `list()` 会遍历 `<sessions root>/<project>/*`；放在 project 下的隔离目录仍可能被当成会话；
- `<DSH_HOME>` 与默认 sessions 根通常同一文件系统，`rename` 原子；
- 若 sessions 根在另一个卷，`rename` 可能 `EXDEV`，回退到“先 detach、再原地 rm”的兼容路径，并明确报告竞态风险。

### 4.3 删除阶段

```text
P0  intent
    持久化 { id, header(createdAt,cwd,isSeeded,parentSession,origin),
             subtreeIds, attachmentIds?, quarantinePath? }

P1  preflight
    - stat(id).location.path；live/subtree/capability/path/header identity
    - 目标子树不可读 -> 拒绝；无关空目录 -> warning
    - 模型工具发起且目标是当前会话 -> 拒绝
    - 读取 workspace/session-activity 预览

P2  stop
    - agent.cancel({kind:'disposed'}) + whenIdle()
    - ctx.parallel('workspace/session-stop', {sessionId})
    - 再查 activity；仍有活动 -> 中止

P3  flush + cache tombstone + media inventory
    - ctx.sessions.flush(session)（live）
    - 在 session_projcache 上安装生命周期 tombstone
    - secure purge 时在 rename 前提取 attachmentIds 写入 intent

P4  commit: rename
    - rename 前再次 lstat/realpath
    - rename(sessionDir, quarantineDir)；fsync 父目录
    - 关闭冷会话的 flock/open write 互斥 handle
    - 失败：回滚 tombstone；会话仍完整；报告

P5  live teardown（仅热会话）
    - entry.detach()               // 真实 session/disposed
    - agents.detachEntered(entry)  // session 已消失，避免 API 重加
    - closeSessionWriters(tracker) // 等待写句柄关闭
    - 失败：保留 quarantine + intent；报告待重试

P6  delete quarantine
    - rm(quarantineDir, { recursive:true, force:true, maxRetries })
    - fsync 隔离区父目录
    - 失败：保留 intent；不阻塞 P7；启动重试

P7  metadata / cache / client
    - 身份校验后 table.delete(id)
    - 所有 workspace detachSession(id)
    - unpinSession(id), unarchiveSession(id)
    - 计划任务：默认 active target；secure purge 清全部引用
    - 冷会话发 api-session/removed(id)
    - Client 删除会话级 localStorage 键；清 current

P8  media (可选 secure purge)
    - 使用 intent.attachmentIds
    - 扫描剩余会话引用
    - 删除无其他引用的对象/引用路径；清 request-image 缓存
    - 删除 provider upload index 中匹配记录
    - 远端 provider 文件不承诺删除

P9  finish
    - P6 完成且 P8 完成（或未启用）时删除 intent
    - secure purge 延后到启动时：保留 intent.attachmentIds
```

**启动清理**（`sessionPersistence` 可用后）：

- 重放 pending intents（验证 header 身份）；
- 清理隔离区中超过阈值的残留；
- 清理 `session_projcache` 中不在持久化列表里的孤儿记录（含 `.bak.*`）；
- 清理 `pinnedSessionIds`/`archivedSessionIds` 中既不 live 也不 persisted 的 id；
- 不主动改写 workspace `sessionIds`：DSH boot reconcile 已负责，且无条件 detach 可能误删 id 复用后的新成员。

### 4.4 冷/热/当前/子树/fork 策略

| 场景 | 策略 |
|---|---|
| 冷会话 | 主路径；rename + journal；不依赖 live 私有面。 |
| 热会话 | 非公开 detach + writer close；Agent scope 留到进程退出；关键私有面缺失则拒绝。 |
| 当前会话（UI 标题栏） | 允许；成功后先 `clearMain()` 离开，再删草稿；被级联删除的子会话也会离开。 |
| 当前会话（模型工具） | 禁止；删除目标应排除调用方 session。 |
| 顶层会话带 subagent | 级联删除 `origin === 'subagent'` 的子树；子先父后 rename。 |
| 只删 subagent | 允许但提示父会话 catalog 仍保留 id/标题；父日志不可改写。 |
| Fork | `isSeeded` 但 `origin !== 'subagent'` 是独立副本，不自动级联。 |
| `session-reference` | 内容已复制到引用方日志；删源不影响副本，提示不可撤回。 |

### 4.5 缓存与迟到写入

- 在 `session/disposed` 之前安装 **生命周期 tombstone**：`table.put` 对同一 `createdAt/cwd/isSeeded` 的写入直接忽略；
- 提交后 `table.delete(id)`；删除前检查 `table.get(id).identity.createdAt`，避免 id 复用误删新缓存；
- tombstone 用 TTL/容量上限，成功后按 id 清理；不能无限累积；
- 启动时清理孤儿缓存。实测 4 份孤儿说明这不是理论问题；
- 旧版聚合 `storages/session_projcache.json` 若存在，按 legacy lock + 原子替换；未知 unit/schema 拒绝修改；
- 跨进程：tombstone 只在本进程；启动孤儿清理兜底；多进程共享 sessions root 时应加跨进程锁。

### 4.6 写互斥

- **冷会话不要强制 `open(id,'write')`**：它会读取并验证整个日志；损坏/超大/历史日志会让删除本身失败。
- 首选 `rename` 作为提交点；可选原生 `flock(session.lock)` 做额外互斥（不读日志、不触发迁移）。
- `open('write')` 只作为“非损坏、v4、可接受整日志读取”的兼容路径；历史格式会迁移，禁止。
- 热会话已经持有写 handle，不能 `open`；靠 `entry.detach()` + `tracker` 关闭 writer。
- **绝不能在持锁 writer 仍活跃时 unlink `session.lock`**；rename 不 unlink，锁随目录移动。

### 4.7 非公开面与能力探测

允许使用非公开函数，但必须集中、探测、失败关闭。

| 符号 | 用途 | 缺失时 |
|---|---|---|
| `ctx.sessions.store` / `SessionEntry.detach()` | 移除 live session，发真实 `session/disposed` | 热删除拒绝；冷删除不需要 |
| `ctx.agents.store` / `AgentRegistry.detachEntered(entry)` | 移除 live agent，发 `agent/disposed` | 热删除拒绝；不要退化为静默 `store.delete` |
| `persistence.tracker.writers` / `openHandles` | 找到并关闭写句柄 | 默认热删除拒绝；仅在明确接受 open handle 留到进程退出时继续（Windows 可能阻塞删除） |
| `sessionProjectionCache.requireTable()` 或 `storageDomain.get('session_projcache').table('sessions')` | tombstone + `table.delete` | 冷删除可退化为直接删文件 + 启动孤儿清理；热删除拒绝 |
| `api-session/removed` | 冷会话通知 API 列表 | 可退化为客户端 refresh；不要伪造 `session/disposed` |
| `workspaceRegistry.list()` + `detachSession()` | 清工作区成员 | 缺失则 warning + 启动 reconcile |
| `workspaceRegistry.unpinSession()` / `unarchiveSession()` | 清 pin/archive | 缺失则 warning |
| `ctx.parallel('workspace/session-stop')` | 停 jobs/subagents/schedule | 热删除拒绝；冷会话通常不需要 |
| `entity.record` / `stopSessionActivity` / `coordinator` | 不需要 | 不要依赖；用公开 `detachSession`、公开事件 |

实现要求：

- 启动时计算 `capabilities`，通过 `/health` 或日志输出；
- 热删除进入前检查热必需能力，缺失返回 `delete-unsupported`（HTTP 503/409），**不停止任何东西**；
- 冷删除不要求 live 私有面；
- `package.json` 精确锁定 `@deepseek-ai/dsh: 0.2.2-rc.3`（或至少 `~0.2.2-rc.3`）；
- 私有字段当前是 TS `private` 普通属性；未来改成 `#private` 时探针失败，不得静默降级；
- 不要把 `agent.scope.dispose()` / `agent.ctx.fiber.dispose()` 当作完整拆除；它不触发 `AgentLoop` teardown。

### 4.8 范围：safe / secure / 不可承诺

| 范围 | safe 默认 | secure purge |
|---|---|---|
| 日志目录（含所有代际） | 是 | 是 |
| 投影缓存 / 旧版聚合 | 是 | 是 |
| workspace `sessionIds` / pin / archive | 是 | 是 |
| 计划任务 active target | 是（`session-stop`） | 是 |
| 计划任务 paused/ended/involved | 否，warning | 是 |
| 客户端会话 localStorage 键 | 是 | 是 |
| 仅被该会话引用的附件 | 否 | 是（引用扫描） |
| request-image 缓存 | 否 | 是（整目录清） |
| provider upload index | 否 | 是 |
| spill 文件 | 否 | 可选（root 可定位时） |
| provider 远端 / 官方日志 / OTel / 导出 / 备份 | 否 | 否 |
| 工作区文件 / Git worktree | 否 | 否 |

### 4.9 失败、幂等与 id 复用

- **提交前失败**：会话完整；tombstone 回滚；active 计划任务可能已停止，报告“活动已停，但会话未删”。
- **提交后失败**：canonical 已消失；返回 `ok:true` + `warnings`；intent 保留，启动重试；若隔离目录未删，返回 `quarantinePath`。
- **部分子树失败**：返回 `deletedSubagents`、`remainingSessionIds`、`partialFailure`；已 rename 的子目录尽量回滚，否则保留 journal。
- **幂等**：第二次删除未知 id 返回 `ok:true, deleted:false`，不报错。
- **id 复用**：P7 前重新 `stat(id)`；`createdAt` 不同则跳过 id-only 清理，避免误删新会话；缓存删除前检查 identity。
- **Windows**：`rename` 可能因 open handle 失败；回退“先 detach、再原地 rm”，`rm` 加 `maxRetries`/`retryDelay`；不要假设 `session.lock` 存在。
- **跨进程**：cache tombstone 是本进程；多进程删除需额外锁，或只允许一个删除者。

### 4.10 UX 与 API

Host API 前缀 `/session-deleater/api`，owner-only：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/health` | 能力探测结果、版本、secure purge 可用性 |
| GET | `/preview?sessionId=` | 子会话数、活动状态、计划任务引用、外部副本警告 |
| POST | `/delete` | body `{ sessionId, media? }`；`media` 取 `keep` 或 `purge`；返回结果/警告/部分失败 |

认证：`ctx.connection.admit(req)`，要求 `owner` principal；body 上限 64 KiB；id 白名单校验。

Client 入口：

- `conversation.session.header.actions`：当前会话标题栏删除；
- `sidebar.workspaces.session.menu.item`：侧栏行“更多”菜单删除；
- `sidebar.session.row.trailing` 是非交互图标，不放按钮；
- 确认框 portal 到 `document.body`/overlay，避免 overflow 裁剪；
- 确认框显示：标题、子会话数、是否运行中、计划任务引用、外部副本警告；
- 预览失败/加载中禁用确认；成功后 `sessions.refresh()`、`workspaces.refresh()`；当前会话使用私有 `clearMain()`（best-effort）离开，并清理所有被删 id（含级联子会话）的客户端状态；
- 失败显示 `deletedSubagents`/`remainingSessionIds`/`partialFailure`，不要只显示 message。

### 4.11 版本契约

- 插件版本 `0.1.0`；行为/接口变化 bump 版本。
- 目标 DSH 精确 `0.2.2-rc.3`；升级后先跑能力探针与回归。
- 私有面缺失：插件可加载；冷删除尽量可用；热删除返回 `delete-unsupported`。
- 不可承诺项必须在 README/UI 中写明；不能把“本机删除”表述为“provider 删除”。

---

## 5 问题与解决办法

| 症状 | 根因 | 修法 | 注意 |
|---|---|---|---|
| 删除失败后列表消失、文件还在，重启又出现 | 先 detach/清理，后 rm；中间失败 | rename 作为提交点；提交后清理；journal | 不要在 rm 前做不可逆 detach |
| 删除成功但缓存又出现 | `session/disposed` 触发迟到 `put`；`coldSnapshot` 写回 | 生命周期 tombstone + `table.delete` + 启动孤儿清理 | tombstone 要有 TTL/容量上限 |
| v1-only 会话“删除成功”但日志仍在 | 固定 `ARTIFACT_NAMES` 漏 v1；`locate` 只给 v4 路径 | `stat.location` 或动态 `session.vN` | 未来 vN 也不要解码事件 |
| 一个空目录导致所有删除预览失败 | 全局扫描要求 `complete=true` | 只对目标子树失败关闭；空目录 warning | 不要因无关损坏阻塞 |
| 置顶会话删除后 pin 残留 | 只 unarchive，没 unpin | `unpinSession(id)` | 失败 warning + 启动清理 |
| 冷会话删除后其它插件收到假的 `session/disposed` | 手动 emit `{id}`，不是 `Session` | 冷会话发 `api-session/removed(id)` | 不要构造假 Session |
| 客户端草稿/布局仍留着 | 只 refresh，不删 localStorage | 精确删除会话级键 | 先导航离开再删 `dsh.conversation` |
| 计划任务 paused/ended 仍引用已删会话 | `session-stop` 只清 active target | 预览显示引用数；默认提示仅停 active，secure purge 用 `schedule.list/edit` 清全部引用 | 默认保留 paused/ended 引用，UI 已明示 |
| 删附件破坏了另一个会话 | 内容寻址共享 | 扫描剩余引用；不可读则保留 | 共享附件永远保留 |
| 热删除后内存仍有会话 | Agent scope 未 unwind | 接受留到进程退出，或拒绝热删除 | 不要假装完全 dispose |
| 同 id 新会话被误删 | id-only 清理 | 校验 `createdAt`；不匹配则跳过 | UUID 复用概率低但要有保护 |
| Windows rename 失败 | open handle/锁 | 回退 detach+rm；`maxRetries` | 不要假设 `session.lock` |
| provider 副本仍在 | 外部系统 | UI/README 明确“不撤回” | 不要承诺“彻底删除” |
| 模型工具删当前会话中断自己 | 删除 turn 被 cancel | 禁止工具删除调用方 session | UI 标题栏可删 |
| 升级后“成功但没清干净” | 私有字段改名/`#private` | 启动能力探测；失败关闭 | 精确版本 + 回归 |

---

## 6 实施步骤

### 6.1 阶段

**Phase 0：骨架与探针**

- 初始化 Git、`.gitignore`、`package.json`、`cordis.patch.yml`；
- 同步 `build-system/` 的 `scripts/`；
- 实现 `compat/private-state.js` 的 `capabilities` 探测；
- `/health` 输出版本与能力。

**Phase 1：冷删除核心**

- `session-files.js`：id 校验、路径编码、header 读取、`session.vN` 动态匹配；
- `journal.js`：intent 持久化/重放；
- `delete-service.js`：P1–P7（冷路径）、workspace/pin/archive、cache；
- `startup-reaper.js`：隔离区、孤儿缓存、dangling pin/archive；
- Host 路由 + owner 认证 + preview/delete；
- 单元测试 + 一次性工作区手工验收。

**Phase 2：热删除与 UI**

- `compat/session-lifecycle.js`：writer 收集/关闭，私有面缺失失败关闭；
- 热 teardown：session detach → agent detach → writer close；
- Client slot、确认框、预览、running 警告、错误详情；
- 当前会话清理与刷新。

**Phase 3：secure purge（可选）**

- `media-purge.js`：附件引用扫描、shared 保留、request-image、provider index、spill；
- 启动时无 live Agent 执行；不可读剩余会话则保留媒体；
- 配置/请求选项 `media: 'purge'`。

**Phase 4：验收**

- `npm run build`、`npm run verify`；
- 功能/安全/崩溃/升级回归；
- 完成后停止并提示用户重启 DSH。

### 6.2 包与构建

- 包名 `@local/dsh-session-deleater`，`private: true`，`type: module`；
- `exports["."] = "./index.js"`、`exports["./client"] = "./client.js"`、`exports["./package.json"]`、`exports["./locale/*.json"]`；
- `dsh.bundle.patch = "./cordis.patch.yml"`；
- `dsh.client = { platform: "web", immediately: true, inject: ["@deepseek-ai/dsh-client-ui-slots"] }`；
- `files` 包含 `index.js`、`client.js`、`lib/`、`cordis.patch.yml`、`icon.svg`、`locale/*.json`、`README.md`；
- `locale/en.json` 必须有 `meta.title`；
- 零 npm 依赖，构建走“不建树”分支；
- `peerDependencies` 精确 `@deepseek-ai/dsh: 0.2.2-rc.3`。

### 6.3 工作量

| 部分 | 估计 |
|---|---|
| Host：session-files、journal、delete-service、compat、startup-reaper、路由/认证 | 600–800 |
| Client：slots、确认框、API、样式、locale | 300–500 |
| 测试：纯函数、Host 单测、手工验收 | 200–400 |
| 构建/探针/文档 | 100–200 |
| **合计** | **约 1,200–1,800 行** |

### 6.4 许可证与归属

若复用参考实现的删除核心代码，保留 MIT 许可证与来源说明；来源与调查记录见 `REF-IMPLEMENTATION.md`。若仅按本文重新实现，也应在 README 的“参考”中说明设计来源。

---

## 7 验证与验收

### 7.1 静态与构建

- `npm run build` 成功，自动 `verify` 通过；
- `npm run verify` 检查 exports、patch、client、locale、icon、符号链接、依赖树、共享构建文件；
- Host 在全新进程可导入；Client 在 VM 中注册两个 slot；
- `/health` 能力探测输出完整。

### 7.2 功能矩阵

| 场景 | 预期 |
|---|---|
| 冷顶层会话 | 目录/缓存/workspace/pin/archive/客户端键全部清理；重启无幽灵 |
| 热空闲会话 | 数据删除、registry 脱离、UI 行消失；Agent scope 留到退出 |
| 热运行中会话 | 先 stop/waitIdle；成功删除；超时则中止且不删 |
| 父会话 + 2 subagent | 预览 2；父子目录都删；结果含 deletedSubagents |
| 只删 subagent | 子目录删除；父 catalog 引用保留并提示 |
| fork 会话 | fork 保留；提示独立副本 |
| 共享附件 | 删一个，另一个仍可读 |
| 唯一附件 + secure purge | 对象/引用/索引删除 |
| v1-only / v2 / v3 | 整个目录删除，不触发迁移 |
| 空目录 + 损坏无关目录 | 不阻塞目标删除 |
| 符号链接 / header 不一致 | 拒绝，目标不动 |
| id 复用 | 新会话不被误删 |
| 当前会话 UI 删除 | 成功、clearMain、草稿清理 |
| 模型工具删当前会话 | 拒绝 |
| 计划任务 active/paused/ended | active 停；paused/ended 预览显示引用数并提示默认保留，secure purge 清 |
| 第二次删除 | 幂等成功、deleted:false |
| Windows | 无 `session.lock` 假设；rename 回退/rm 重试 |

### 7.3 安全验收

- 无 cookie 的 POST → 401；非 owner/跨站 → 403；
- body > 64 KiB → 400/413；
- `../`、绝对路径、控制字符、URL 编码 → 400；
- 符号链接/junction → 拒绝；
- 删除只发生在 `<sessions root>/<project>/<session>` 内；
- 只读/不可写目录 → 失败且不误删其它目录。

### 7.4 崩溃与升级

- 在 P0/P2/P4/P5/P6/P7 后 kill 进程：重启后 intent/隔离区/孤儿缓存被正确清理；
- 多进程共享 root：第二个进程不能打开同一 writer；缓存写回由启动清理兜底；
- DSH 升级：探针失败时热删除返回明确错误；冷删除尽量可用；
- 升级后回归：`sessions.store`、`entry.detach`、`agents.detachEntered`、`tracker`、`requireTable`、`api-session/removed`。

### 7.5 观测

- 日志记录：id、阶段、耗时、警告、quarantinePath、capabilities 版本；
- 不记录会话正文/标题/提示词；
- 删除结果返回 `deleted`、`filesRemoved`、`deletedSubagents`、`warnings`、`partialFailure`、`quarantinePath`。

---

## 8 待用户确认

以下决策已按“安全优先、可恢复、不过度承诺”综合；请确认或修改。

### 8.1 热会话策略

- **A（推荐）**：允许热删除。使用非公开 `sessions.store`/`entry.detach` + `agents.detachEntered` + writer close；Agent scoped 资源留到进程退出；UI/README 说明。
- B：只允许冷删除；热会话返回“需要重启”。
- C：热删除先归档隐藏，重启后再收尾。

**影响**：A 的删除体验最好，但要接受私有面与内存残留；B 最保守；C 需要 archive 状态与启动收尾。

### 8.2 附件/媒体策略

- **A（推荐）**：默认 safe（保留附件）；`secure purge` 作为请求/配置选项，无 live 会话时立即执行、否则下次启动执行；共享附件永远保留。
- B：所有删除默认 secure purge（更彻底，但可能影响其它会话性能，且需要扫描全部剩余会话）。
- C：永不删附件。

**影响**：A 最安全、可解释；B 更符合“彻底”直觉，但成本/风险高；C 会留下图片内容。

### 8.3 子会话与 fork

- **A（推荐）**：删顶层会话级联 `origin=subagent` 子树；fork 不级联；只删子会话时提示父 catalog 保留引用。
- B：只允许删顶层，禁止单独删子会话。
- C：按 lineage 级联 fork/引用副本（不推荐，可能误删独立副本）。

### 8.4 计划任务与当前会话

- **A（推荐）**：计划任务默认只停 active target；secure purge 清 paused/ended/involved；当前会话 UI 可删、模型工具不可删。
- B：无论模式都清全部计划任务引用。
- C：当前会话一律禁止删除。

### 8.5 UI 与旧插件共存

- **A（推荐）**：默认与 `dsh-session-manager` 双入口；README 说明重复；不劫持旧插件 slot id。
- B：检测旧插件后隐藏标题栏按钮（依赖兼容层）。
- C：只提供侧栏入口。

### 8.6 兼容策略

- **A（推荐）**：插件可加载；冷删除尽量可用；热删除关键私有面缺失返回 `delete-unsupported`。
- B：任一私有面缺失就插件加载失败（更响亮，但影响 DSH 启动）。
- C：静默降级（不推荐）。

### 8.7 首期范围

- **A（推荐）**：单条删除 + 标题栏/侧栏入口 + preview + 错误详情；批量二期。
- B：首期同时做批量管理面板。

---

## 9 参考坐标

### 9.1 本工作区文档

- `TRACE.md`：§2–§5 会话生成与工件；§10 安全删除综合判断。
- `REF-IMPLEMENTATION.md`：既有实现调查记录（历史参考；不是本文规范）。

### 9.2 DSH 源码

- `@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts`：`projectKey`、`encodeSegment`、`logPath`、`toHeaderLine`
- `.../src/index.ts`：`create`、`open`、`stat`、`list`、`materialize`、`appendLines`
- `.../src/lease.ts`：`SessionWriteLease`、`session.lock`
- `.../src/storage.ts`：`JsonlBackendTracker`、`openHandles`、`writers`
- `@deepseek-ai/dsh-session/src/index.ts`：`SessionStore`、`entry.detach`、`session/disposed`
- `@deepseek-ai/dsh-agent/src/index.ts`：`AgentRegistry`、`detachEntered`、`AgentHandle`
- `@deepseek-ai/dsh-agent-loop/src/index.ts`：`initializeAgent`、teardown、writer close
- `@deepseek-ai/dsh-session-projection-cache/src/index.ts`、`src/spec.ts`：`requireTable`、`session_projcache` v7
- `@deepseek-ai/dsh-workspace/src/index.ts`、`src/entity.ts`：`detachSession`、`unpinSession`、`unarchiveSession`
- `@deepseek-ai/dsh-schedule/src/index.ts`：`activeSessionTasks`、`stopSessionTasks`
- `@deepseek-ai/dsh-attachment-local/src/store.ts`、`file-store.ts`、`request-image.ts`
- `@deepseek-ai/dsh-session-log-deepseek/src/index.ts`：`dsh_session_log`、`delivery-accepted`
- `@deepseek-ai/dsh-llm-deepseek/src/upload-index.ts`：`files-v3.json`
- `@deepseek-ai/dsh-spill-local/src/store.ts`：`sessionDir`

### 9.3 运行时路径

- `~/.dsh/sessions/`
- `~/.dsh/storages/session_projcache/sessions/`
- `~/.dsh/storages/workspace.json`
- `~/.dsh/storages/schedule.json`
- `~/.dsh/attachments/v1/{objects,file-objects,files}/`
- `~/.dsh/cache/attachments/request-images/`
- `~/.dsh/llm-deepseek/files-v3.json`
- `~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb`

### 9.4 UI 与事件

- `conversation.session.header.actions`：list，replaceRisk none。
- `sidebar.workspaces.session.menu.item`：list，owner props `{ sessionId, displayTitle }`，使用 `useMenuOpenState` 关闭菜单。
- `shell.overlay`：root list；确认框挂在这里，避免随行菜单卸载。
- `sidebar.session.row.trailing`：非交互图标，不放删除。
- `workspace/session-activity`：waterfall。
- `workspace/session-stop`：parallel。
- `api-session/removed`：emit，`(sessionId: SessionId) => void`。
- `session/disposed`：emit，`(session: Session) => void`。

---

## 10 本轮结论

1. 本插件可行，且应做成“本机安全删除”，不是“全宇宙彻底删除”。
2. 冷删除以 `rename` 为提交点、journal 为恢复机制、能力探测为边界；热删除才使用非公开 detach。
3. 默认 safe 保留附件/外部副本；secure purge 作为显式选项，无 live 会话时立即执行，否则下次启动执行。
4. 实现前只需确认 §8 的七组决策；确认后按 §6 分阶段编码，完成后需要重启 DSH。

---

## 11 实施记录（2026-11-17）

### 11.1 已实现

- **Host 半** `index.js`：
  - owner-only `POST /session-deleater/api/delete`、`GET /preview`、`GET /health`；
  - 认证复用 `ctx.connection.admit(req)`；
  - request body 上限 64 KiB；错误返回稳定的 `code`、`deletedSubagents`、`remainingSessionIds`、`partialFailure`、`quarantinePath`。
- **删除服务** `lib/service.js`：
  - 预检、子会话树、活动检查、停止、cache tombstone、flush、隔离 rename、live detach、writer close、隔离目录删除、workspace/pin/archive 清理、secure schedule 清理、媒体清理；
  - 冷会话不依赖 live 私有面；热会话在关键私有面缺失时返回 `delete-unsupported`；
  - id 复用保护：清理前重新 `stat` 并比较 `createdAt`；
  - 冷会话移除通知使用 `api-session/removed`，live 会话使用真实 `entry.detach()`。
- **启动恢复** `lib/service.js`：
  - 重放 journal；
  - 清理隔离区、孤儿投影缓存、悬空 pin/archive；
  - 媒体清理在无 live 会话时执行，否则保留 intent 到下次启动。
- **Client 半** `client.js`：
  - `conversation.session.header.actions`（id `session-deleater-header`，order 30）；
  - `sidebar.workspaces.session.menu.item`（id `session-deleater-menu`，order 550）；
  - `shell.overlay`（id `session-deleater-overlay`）承载确认框，避免行菜单关闭时把对话框一起卸载；
  - 确认对话框、预览、running/热会话分离提示、子会话数、计划任务引用、外部副本警告、媒体复选框；
  - 成功后清理**所有被删 id（含级联子会话）**的会话级 localStorage；若当前会话（含被级联的子会话）在其中，先 `clearMain()` 再清状态；失败/部分失败在对话框内展示，不再使用原生 alert。
- **测试** `tests/deletion.test.mjs`：冷删除、非法 id、热删除私有 detach/writer close、secure purge 共享/唯一附件四条用例。
- **构建**：已同步 `build-system/scripts`，`scripts/host-contract.mjs` 断言路由、认证入口、health 与能力探针。

### 11.2 与设计的偏差

1. **冷删除不使用 `open('write')`**：按设计以 rename 作为提交点，避免完整读取日志；多进程写互斥依赖 rename 的 canonical 路径消失，未额外引入原生 `flock`。
2. **媒体清理可能立即执行**：如果提交后确认没有 live 会话，则立即执行；否则保留 `mediaPending`，下次启动执行。UI 已说明“共享附件保留”。
3. **热删除的 Agent scoped 资源保留到进程退出**：与设计一致；未调用 `agent.scope.dispose()`。
4. **计划任务默认只停 active target**：`workspace/session-stop` 负责 active target；`secure purge` 才通过 `schedule.catalog/edit` 清理所有引用。
5. **无批量删除/管理面板**：按 8.7 决策，仅标题栏和侧边栏“更多”菜单。
6. **当前会话仅在 UI 允许删除**：未提供模型工具；客户端先私有 `clearMain()`（best-effort）离开，再清 localStorage；级联删除的子会话也会清理。

### 11.3 验证结果

- `npm run build`：通过（依赖树、清单、slot、locale、icon、构建系统一致性、Host 探针）。
- `npm test`：4/4 通过。
- 安装：`plugin_manager install_bundle` 返回 `application: applied`，profile 已添加 `@local/dsh-session-deleater`。
- 安装后活体 slot：`conversation.session.header.actions` 的 `session-deleater-header`、`sidebar.workspaces.session.menu.item` 的 `session-deleater-menu` 均为 `active: true`；`shell.overlay` 确认框已在页面刷新后的实删中使用（见 11.6）。
- 未认证 `GET /session-deleater/api/health` 返回 401，证明 Host 路由已注册且认证失败关闭。
- **已实测**：用户在重启后的 GUI 中创建并删除一条一次性会话，删除走通；删除后再次重启，Host 侧工件、投影缓存、工作区引用、journal/隔离区均已清理（详见 11.6）。
- **仍未验证**：取消操作、部分失败展示、删除当前会话的导航、热删除、secure purge 的 GUI 路径；这些需要专门构造场景，未在本次实测覆盖。

### 11.4 已知限制

- 热删除的 Agent scoped 资源留到进程退出；关键私有面缺失时拒绝热删除。
- 默认 safe 不删除附件；secure purge 仅删除无其他引用的对象，request-image 缓存整目录清空，provider 远端文件不删除。
- provider/官方日志/OTel/导出/备份不可撤回。
- 多进程 cache tombstone 只在本进程；启动孤儿清理兜底。
- 未在 Windows 实测 `rename`/`rm` 的锁与重试行为。
- 无批量删除；无用户可见回收站；rename 隔离区只是内部提交点。
- 客户端 localStorage 的 Chromium LevelDB 在压缩前可能在 `.log` 中保留已删除键的历史字节；插件只能删除活动键，不控制 LevelDB 压缩。

### 11.5 后续可选

- 为 secure purge 增加可视化进度/下次启动提示；
- 为单条失败增加“重试预览/重试删除”按钮；
- 增加多进程删除协调锁；
- 在 Windows 上专项验证；
- 若上游提供正式 `deleteSession`/cache delete API，替换 `compat` 私有面。

### 11.6 实测复核：单条会话删除（2026-11-17）

用户删除 `session-ba1c7d75-59fd-4843-98af-806cbc73f296` 并重启后，按下列位置复核：

| 位置 | 结果 |
| --- | --- |
| `~/.dsh/sessions/**/<id>` | 不存在；除当前会话自身的对话内容外，`~/.dsh` 中无该 id 的文件名或内容（含二进制检索） |
| `~/.dsh/storages/session_projcache/sessions/<id>.json` | 不存在；32 个会话目录与 32 个缓存文件一一对应，无孤儿 |
| `~/.dsh/storages/workspace.json` | `sessionIds`、`archivedSessionIds`、`pinnedSessionIds` 均无该 id |
| `~/.dsh/dsh-session-deleater/pending.v1.json` | `entries` 为空 |
| `~/.dsh/.session-deleter-trash` | 为空；无锁文件、临时文件残留 |
| `~/.dsh/attachments`、`request-images`、`files-v3.json` | 该会话无附件；无新增或残留 |
| 其他会话日志 | 解压全部 32 个 `session.v4.jsonl.zstd`，仅当前会话日志含该 id（因本轮对话提到它） |

客户端复核：Chromium LevelDB 中 `dsh.conversation.<id>` 与 `dsh.sidebar-right.v1.<id>` 已有删除记录（DEL），`dsh.sessions.current` 已切回当前会话，活动键值中无该会话；`000060.log` 仍保留删除前的历史写入字节，属于 LevelDB 压缩前的正常行为，不是可读的活动状态。

结论：DSH 的逻辑会话存储与索引已清除。文件系统空闲块、APFS 快照、备份以及 LevelDB 压缩前的历史日志不在本插件的物理擦除承诺内（见 1.2 与 11.4）。

---

## 12 删除确认按钮的悬停样式修复（2026-11-17）

### 12.1 目的与范围

修正删除确认对话框中“确认删除”按钮在 `:hover` 时文字与背景同时变灰、对比度不足的问题。只改本插件注入的对话框 CSS，不改 DSH 主题 token，也不改宿主按钮组件。

### 12.2 现象与根因

现象：按钮默认是红底白字，悬停时变成灰底、文字也发灰，几乎看不清。

本插件 `client.js` 中的相关规则：

```css
.dsd-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.dsd-btn-danger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color,#fff)}
.dsd-btn-danger:hover:not(:disabled){filter:brightness(.94)}
```

根因是选择器特异性：`.dsd-btn:hover:not(:disabled)` 为 `(0,3,0)`，高于 `.dsd-btn-danger` 的 `(0,1,0)`。悬停时背景被通用规则覆盖为 `--dsw-alias-bg-layer-2`；危险按钮的 hover 规则只设置了 `filter`，没有重新声明 `background` 或 `color`。

在浅色主题下：

- `--dsw-alias-bg-layer-2` → `--dsw-static-neutral-bluish-00` → `rgb(255, 255, 255)`（`dsh-client-ui-theme/src/styles/design-platform.css` 第 182、56 行）；
- `--dsw-alias-label-on-color` → `--dsw-static-neutral-bluish-00` → `rgb(255, 255, 255)`（同文件第 254、56 行）。

于是悬停后变成“白底白字”，再叠加 `brightness(.94)`，文字和背景一起被压暗成灰色。深色主题下背景会被换成深灰层，但危险按钮的红色同样丢失。

### 12.3 核心进路

1. 让通用 hover 不再命中危险按钮：`.dsd-btn:not(.dsd-btn-danger):hover:not(:disabled)`。
2. 在 `.dsd-btn-danger:hover:not(:disabled)` 中显式保持红色背景和 on-color 文本，并保留轻微加深：

   ```css
   .dsd-btn-danger:hover:not(:disabled){
     background:var(--dsw-alias-state-error-primary);
     color:var(--dsw-alias-label-on-color,#fff);
     filter:brightness(.94);
   }
   ```

3. 不加新的颜色 token，不引入动画；`busy`/`:disabled` 的透明度规则保持不变。

### 12.4 问题与解决办法

| 问题 | 处理 |
| --- | --- |
| 通用 hover 与危险 hover 同特异性，靠顺序覆盖 | 同时做“排除危险按钮”和“显式声明背景/文字”，避免依赖源码顺序 |
| 深色主题下背景层是深灰，红色同样丢失 | 显式恢复 `--dsw-alias-state-error-primary`，与主题无关 |
| 删除进行中按钮 disabled，hover 不生效 | 保持现有 `:disabled{opacity:.5}`；不再让灰色 hover 规则参与 |
| 焦点可见性 | 保留现有 `:focus-visible` 规则，不把 hover 样式并入 focus |
| 宿主全局按钮样式可能影响颜色 | 危险 hover 显式设置 `color`，不依赖继承 |

### 12.5 验证计划

- 浅色/深色主题下悬停“确认删除”：红底、白字、轻微加深；
- 悬停“取消”“关闭”“重试”：保持中性层背景；
- 删除进行中（disabled）：按钮半透明，不出现灰底灰字；
- 键盘聚焦：focus ring 仍可见；
- 构建后检查 CSS 字符串已更新（`npm run build`）。

### 12.6 实施记录（2026-11-17）

- 通用 hover 改为 `.dsd-btn:not(.dsd-btn-danger):hover:not(:disabled)`，不再命中危险按钮。
- `.dsd-btn-danger:hover:not(:disabled)` 显式恢复 `background: var(--dsw-alias-state-error-primary)`、`color: var(--dsw-alias-label-on-color, #fff)`，并保留 `filter: brightness(.94)`。
- 未改主题 token、未新增依赖；`busy`/`:disabled` 透明度与 focus 规则保持原样。
- 验证方式：浅色/深色主题下人工悬停；构建后由 `npm run build` 检查 CSS 字符串与产物。
- `npm run build` 通过（含 `npm test` 4/4）。

### 12.7 完成态按钮改为中性（2026-11-17）

删除完成/部分失败/导航失败后的第二个对话框是信息通报，不是再次确认；其“关闭”按钮沿用 `dsd-btn-danger` 红底白字会让用户误以为还要执行危险操作。本轮改为普通 `dsd-btn`（中性底、常规文字），按钮文本仍为 `T.close`（「关闭」/“Close”），行为只关闭对话框。

- 不改变 completion 状态、警告列表、导航或删除结果；
- 版本提升为 `0.1.2`；`npm run build` / `npm test` 通过。

---

## 13 删除当前会话后的自动导航（2026-11-17）

### 13.1 目的与范围

删除**当前正在查看**的会话（或被级联删除的当前会话）后，不再停留在已删除会话的视图，而是自动打开一个仍存在的会话，或在当前工作区新建/复用空白会话。删除非当前会话不改变当前视图。

### 13.2 现象与证据

现象：用会话标题栏按钮删除当前会话后，页面仍停留在原会话位置，内容仍可见，只有标题回退成 session id；点击侧边栏另一个会话后才完全消失。

- `uiWorkspace` 的公开契约在 `dsh-client-ui-workspace/src/client/navigation.ts`：
  - `openSession(target)`（第 45 行）：选择会话并显示其 Conversation；
  - `connectWorkspace(workspaceId)`（第 82 行）：复用或创建该工作区的空白会话；
  - `startSession(workspaceId?, options?)`（第 91 行）：打开 `connectWorkspace` 解析出的空白。
- 同一文件第 515 行的 `clearMain()` 是 `UiWorkspaceService` 的**私有方法**，不在 `UiWorkspace` 接口中；它被 `archiveSession`（第 384 行）在归档当前会话时内部调用，所以归档会回到 New Session 空态。
- 本插件修改前的 `client.js` 中 `clearCurrent(ctx)` 调用 `ctx.uiWorkspace?.clearMain()`；当时 client 的 `inject` 只有 `['slots']`，未注入 `uiWorkspace`。内置客户端插件访问该服务时均显式声明 `inject`（例如 `dsh-client-ui-chat`、`dsh-client-ui-schedule`）。因此该调用要么没有可用服务，要么依赖私有方法；两者都不应作为契约。
- 删除后 Host 列表事件把该行从 `sessions.byId` 移除；`SessionSummary.displayTitle` 的兜底顺序是 durable title → project basename → session id（`dsh-api-session-controller/src/client/sessions/service.ts` 第 31-32 行），于是标题显示 id。`mainReference` 仍保留旧会话，Conversation 继续渲染。

### 13.3 核心进路

- 删除成功后，若 `deletedIds` 包含当前选择（`localStorage['dsh.sessions.current']` 的 `sessionId`），在清理会话级 localStorage **之前**导航：
  - 打开仍存在的会话：`ctx.uiWorkspace.openSession(target)`；
  - 或打开当前工作区的空白：`const id = await ctx.uiWorkspace.connectWorkspace(workspaceId); ctx.uiWorkspace.openSession(id)`。`connectWorkspace` 会复用空白，没有空白时才创建。
- 不再调用 `clearMain`；不伪造私有选择状态。
- 在对话框打开时捕获目标行所属 `workspaceId`（header/menu 都有 `useWorkspaces`），避免删除后列表刷新导致无法反查。
- 顺序：删除成功 → 计算排除 `deletedIds` 的候选 → 导航 → 清理会话级 localStorage → `refresh`。这样 `removeSessionLocalState` 看到的是新 selection，不会把刚写入的 `dsh.sessions.current` 删掉。
- 导航失败不把删除标记为失败：删除已经提交；捕获导航异常，作为完成态警告或 `console.warn`，保留用户手动点击其他会话的能力。

### 13.4 落点选择方案（待确认）

| 方案 | 行为 | 优点 | 代价 |
| --- | --- | --- | --- |
| **A. 同工作区最近会话（推荐）** | 在目标会话所属工作区内，按 `updatedAt` 倒序取第一个仍存在、非归档、非空白、非 subagent 的会话；没有则在该工作区新建/复用空白 | 稳定、简单；通常就是侧边栏第一行；删除测试会话后回到上一段工作 | 不严格等于“侧边栏下一行” |
| **B. 侧边栏相邻行** | 按侧边栏当前可见顺序取被删行的下一行，没有下一行取上一行；没有则新建/复用空白 | 最符合“下一个”的直觉 | 需要复刻排序：`updated`/`manual`、pin、blank、archived filter、groupBy 的 flat/workspace 差异；耦合 `dsh.workspace.view.v5` 私有存储 |
| **C. 总是新建/复用空白** | 删除当前后直接 `connectWorkspace(workspaceId)` | 最接近归档当前会话的“回到新会话” | 工作区里明明有其他会话时也开空白，可能不符合预期；没空白时会新建日志 |
| **D. 回到 New Session 空态** | 需要调用私有 `clearMain` 或重建选择状态 | 与系统归档行为一致 | 依赖私有方法，回到本插件刻意避免的版本风险 |

若选 A，候选过滤规则：

- 排除 `deletedIds`（含级联子会话）；
- 排除 `archivedSessionIds`；
- 排除 `blank === true`；
- 排除 `origin === 'subagent'`（子会话不作为侧边栏落点）；
- 按 `updatedAt` 降序，`id` 作为稳定的平局裁决。

当前会话是 subagent、或找不到所属工作区时：

1. 若父会话仍存在，可打开父会话；
2. 否则打开全局最近更新的存活会话；
3. 仍没有则 `startSession()`（由 DSH 选择当前/最近工作区）。

### 13.5 问题与解决办法

| 问题 | 处理 |
| --- | --- |
| 删除父会话时当前是子会话（级联） | `deletedIds` 包含当前 id；落点取父会话的 `workspaceId`，并排除所有被删 id |
| 删除后 `sessions.list` 尚未刷新，仍含已删行 | 候选过滤显式排除 `deletedIds`；不要依赖列表已更新 |
| 当前 selection 仍是已删 id | 先导航再清 localStorage；`removeSessionLocalState` 只清理不再指向的键 |
| `startSession` 是 `void`，异步创建，无法 await | 用 `connectWorkspace` 拿 id，再 `openSession(id)` |
| 空白会话被自动打开 | 候选排除 `blank`；若工作区只有空白，`connectWorkspace` 复用它，不新建 |
| 归档行不可打开 | 候选排除归档 id |
| 删除成功但导航失败 | 保留完成态并显示警告；不把删除结果改成失败 |
| 工作区没有其他会话 | 按 A 的兜底新建/复用空白；是否需要新建待确认（见 13.6） |
| 用户正在运行会话 | 删除会中断；导航到下一个会话，不保留旧视图 |

### 13.6 决策（2026-11-17 已确认）

用户确认：

1. 落点策略采用 **A：同工作区最近更新的其他会话**；
2. 工作区没有其他会话时，允许自动新建/复用空白（`connectWorkspace` 优先复用，没有空白才创建）；
3. 导航失败只作为完成态警告，不把删除结果改成失败。

### 13.7 实施记录（2026-11-17）

- Client `inject` 扩展为 `['slots', 'uiWorkspace', 'sessions', 'workspaces']`。
- 删除成功后：
  - 用实际删除集合（`deleted === true` 的目标 + 实际 `deletedSubagents`）判定当前选择是否被删；判定同时参考 `retainedBy.mainView` 与对话框打开时捕获的当前 id，避免 Host 先移除列表行后漏判；
  - 当前会话被删时调用 `leaveDeletedCurrent`，只使用公开 `uiWorkspace.openSession` / `connectWorkspace` / `startSession`，不再调用私有 `clearMain`；
  - 候选按工作区 `sessionIds` 取数，排除被删 id、归档、空白、`origin === 'subagent'`，按 `updatedAt` 降序；
  - 没有候选时先 `connectWorkspace(workspaceId)` 再打开返回的空白；仍失败则回退到全局最近会话，最后 `startSession()`；
  - 当前是 subagent 且父会话仍存活时优先打开父会话。
- 打开顺序：删除成功 → 导航 → 清理会话级 localStorage → `refresh`；导航成功时 `removeSessionLocalState` 不再删除刚写入的 `dsh.sessions.current`。
- 导航异常被捕获为完成态警告（`navigationFailed`），删除仍报告成功；不会把已提交的删除误报为失败。
- 对话框在打开时捕获目标行所属 `workspaceId` 与当前标记，避免删除后列表刷新导致落点无法反查。
- 版本提升为 `0.1.1`；README 已同步“同工作区最近会话”与 `uiWorkspace` 公开导航说明。

验证计划（需重启/刷新 Client 后人工确认）：

- 删除当前会话且有同工作区其他会话：自动打开最近更新者，旧内容消失，标题正确；
- 删除当前工作区唯一会话：自动新建/复用空白，工作区保留；
- 删除带 subagent 的父会话且当前是子会话：落到同工作区存活会话，不打开被删 id；
- 删除非当前会话：当前视图不变；
- 删除当前后导航失败：完成态显示警告，删除结果仍成功；
- 悬停“确认删除”：红底白字，浅色/深色主题均正常；
- `npm run build` / `npm test` 通过（4/4）。
