# TRACE：DSH 会话存储全链路与删除反推

- 追踪对象：DeepSeek Harness `0.2.2-rc.3`（Desktop，`DSH_PROFILE=desktop`）
- 追踪时间：2026-11-17
- 追踪方式：以当前正在运行的会话为活样本，交叉核对安装包源码（`app.asar/dsh/node_modules/@deepseek-ai/*/src`）、安装版文档、`~/.dsh` 下的运行时文件，以及 `zstd`、`python3`、进程内文件系统的实际输出。
- 轮次说明：**第一轮（§0–§9）未读取工作区内任何已有文件的内容**（包括当时的 `FEASIBILITY@*.md`、既有插件源码与 `TRACE.md` 之外的产物），只读取了运行时数据与 DSH 安装包源码/文档。**第二轮（§10）** 按用户要求读取了工作区现有的 `REF-IMPLEMENTATION.md`（原 `FEASIBILITY@0.2.2-rc.3.md`）与已安装 `dsh-session-manager` 0.7.8 的删除实现源码，用于与独立追踪结果对照；允许使用非公开函数。
- 本文是解析与安全判断记录，不是插件实现。

---

## 0. 一页结论

1. **一个会话不是“一条数据库记录”，而是一组工件**：一份 append-only 的 JSONL 事件日志、一个跨进程写锁、一份投影缓存记录、若干工作区/计划任务的引用、可选的附件对象，以及浏览器端按会话 id 保存的本地状态。
2. **DSH 当前没有删除会话的 API**。持久化 seam 只有 `create/open/stat/list/flush`，README 明确写着 “Nothing deletes session files … the seam has no deletion API”；工作区 registry 也明确把“session deletion”列为不存在的独立能力。
3. **冷会话的删除是可行的**：删除会话目录（含所有历史格式代际）、删除 `session_projcache` 中的记录、清理工作区/计划任务引用，再按需回收附件；可做到重启后不再出现。
4. **热会话（当前进程内已加载 Agent）无法通过公开 API 干净拆除**：`AgentHandle.dispose()` 只返回给创建者，插件拿不到；`ctx.agents` 没有按 id dispose；`workspace/session-stop` 只停工作、不注销 Agent。使用非公开的 `sessions.store`/`entry.detach` + `agents.detachEntered` 可以做到“数据删除”，但 Agent 的 scoped 资源会留到进程退出；否则需要“归档隐藏 + 删除文件 + 启动时收尾”的两阶段方案。详见 §10。
5. **只删日志文件是不够的**。实测当前机器上有 **31 个会话目录、35 份投影缓存记录**，其中 **4 份缓存对应日志已经不存在的会话**，里面仍保留标题和用户提示词片段。这正是“日志已删、缓存还在”的残留样本。
6. **附件是内容寻址且共享的**。实测 118 个附件对象、118 个引用、其中 3 个被两个会话共同引用。附件不能按会话盲目删除，必须先扫描其余会话的引用；否则会破坏其他会话。
7. **外部副本无法由本地删除撤回**。追踪时当前会话日志已有 **159 条 `session-log-deepseek/delivery-accepted` 事件、已上传至 `throughSeq=1219`**（当时本地共 1224 个事件）；DSH 还会把图片上传到 provider Files API。删除本地会话不会删除这些外部副本。
8. 因此，“彻底删除”应被定义为一个**多阶段、可重入、带意图日志（journal）的清理流程**，而不是一次 `rm -rf`。

---

## 1. 版本、路径与证据坐标

### 1.1 运行版本

| 项 | 值 |
|---|---|
| DSH CLI 包 | `@deepseek-ai/dsh@0.2.2-rc.3` |
| 安装位置 | `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh` |
| 会话格式版本 | `SESSION_FORMAT_VERSION = 4`（`dsh-session/src/types.ts`） |
| 当前日志文件名 | `session.v4.jsonl.zstd` |
| DSH home | `/Users/hanluica/.dsh` |
| 会话根 | `dshHomePath('sessions')` → `/Users/hanluica/.dsh/sessions` |
| 投影缓存根 | `dshHomePath('storages')` → `/Users/hanluica/.dsh/storages` |
| 附件根 | `~/.dsh/attachments/v1` |
| 浏览器本地存储 | `~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb` |

> 文档滞后点：`dsh-session-persistence-jsonl/README.md` 的布局示例仍写 “v3/current”，但代码与磁盘实际都是 v4。删除逻辑必须以 `stat.location.path` 和目录内容为准，不能按 README 的 v3 文件名硬编码。

### 1.2 关键源码坐标

| 主题 | 文件 / 符号 |
|---|---|
| 会话 id 生成（Web） | `dsh-api-session-controller/src/agent.ts` → `ApiSessionAgentController.createMinted()`：`` `session-${randomUUID()}` `` |
| 会话 id 生成（subagent / ACP） | `dsh-subagent/src/manager.ts`、`dsh-acp/src/index.ts`：裸 `randomUUID()` |
| 会话头与事件 | `dsh-session/src/types.ts`、`src/index.ts` |
| 日志路径 / 编码 / 扫描 | `dsh-session-persistence-jsonl/src/format.ts`：`projectKey`、`encodeSegment`、`sessionDir`、`logPath`、`toHeaderLine` |
| 懒物化与追加 | `dsh-session-persistence-jsonl/src/index.ts`：`create`、`open`、`materialize`、`appendLines`、`persistHeader` |
| 写锁 | `dsh-session-persistence-jsonl/src/lease.ts`：`SessionWriteLease`、`session.lock` |
| 投影缓存 | `dsh-session-projection-cache/src/index.ts`、`src/spec.ts` |
| 工作区 | `dsh-workspace/src/index.ts`、`src/entity.ts`、`src/spec.ts` |
| 计划任务 | `dsh-schedule/src/index.ts`、`src/storage.ts` |
| 附件 | `dsh-attachment-local/src/store.ts`、`src/file-store.ts`、`src/request-image.ts` |
| 官方日志上传 | `dsh-session-log-deepseek/src/index.ts` |
| Provider 文件索引 | `dsh-llm-deepseek/src/upload-index.ts` |

---

## 2. 会话从创建到落盘的时序

### 2.1 创建：id、header 与内存 Session

Web 端新建会话时，`ApiSessionAgentController` 生成一个 `session-<uuid>`，然后调用 `ctx.agents.create({ sessionId, meta })`：

```
ApiSessionAgentController.createMinted()
  sessionId = `session-${randomUUID()}`
  ctx.agents.create({ sessionId, agentOptions, meta: { cwd, agentPreset? }, setup })
    AgentLoop.createAgent()
      SessionStore.prepare(sessionId, { meta })       // 仅内存
        header = {
          version: 4,
          id: sessionId,
          createdAt: Date.now(),
          cwd,                                        // 绝对路径
          parentSession?, isSeeded: false,
          origin?, delegationDepth?, agentPreset?
        }
      sessionPersistence.create(header)               // 懒物化，先不写盘
      setup / 初始事件 append
```

关键点：

- **id 不是格式统一的**：主会话是 `session-<uuid>`，subagent / ACP 会话是裸 `<uuid>`，配置型 Agent 还可能是 `${agentId}-session-<uuid>`。因此不能靠 id 前缀判断“主会话/子会话”，必须看 header 的 `origin === 'subagent'`。
- **header 是独立于事件日志的落盘元数据**，包含 `cwd`、`parentSession`、`isSeeded`、`origin`、`delegationDepth`、`agentPreset`。删除时它既是身份校验依据，也是定位目录/子树的依据。
- `SessionStore.prepare()` 只构造内存 Session；`create()` 返回的写 handle 让 session 在本进程可见，但**第一次 append 或 flush 之前磁盘上没有它**。

### 2.2 第一次写盘：懒物化

`dsh-session-persistence-jsonl` 的 `create()` 只登记 pending handle，不碰文件系统。第一次 `append`（或 `flush`）时：

```
materialize(header, inheritedEventCount, events)
  project = <root>/<projectKey(cwd)>
  dir     = project/<encodeSegment(id)>
  mkdir(root, project, dir)                       // 0700
  tmp = session.v4.jsonl.zstd.<hex>.tmp           // 0600
  write header frame + first event frame
  fsync(tmp)
  link(tmp, session.v4.jsonl.zstd)                // 不覆盖已存在文件
  fsync(dir); rm(tmp)
```

其中：

- `projectKey(cwd)` 把路径分隔符和冒号替换为 `-`，特殊字符转 `~XXXX`，首尾加 `--`；例如
  `/Users/hanluica/Documents/.../dsh-session-deleater` →
  `--Users-hanluica-Documents-deepseek-harness-local-plugins-dsh-session-deleater--`。
- `encodeSegment(id)` 把 id 安全转成单一路径段；`.`/`..` 特判，`~` 和非常规字符转 `~XXXX`，因此不会出现路径穿越。
- 物化前会在同目录创建 `session.lock`（POSIX 上是 `flock(2)` 的锁文件，0 字节），并在整个写 handle 生命周期内持有。
- 物化成功后文件布局是：

```
~/.dsh/sessions/
  --<normalized-cwd>--/
    <encoded-id>/
      session.v4.jsonl.zstd
      session.lock
```

### 2.3 持续追加：批次与帧

- 每个 `session/event` 被持久化后端按 session id 路由到写 handle，先进入一个 **200ms 上限**的写后缓冲；到期后作为一个 batch 追加。
- 每次追加是一个独立的 zstd frame（header 单独一帧），追加后 `fsync`；失败会回滚到追加前长度。
- 历史格式代际不会覆盖：如果发生格式迁移，旧代际保留，当前代际另写 `session.vN.jsonl.zstd`；运行期选择数值最高的代际。
- 因此一个会话目录里可能同时存在 `session.jsonl`、`session.v1...v3.jsonl.zstd`、`session.v4.jsonl.zstd`。**删除必须删整个目录，不能只删当前文件**；否则旧代际可能让会话“复活”。

### 2.4 投影缓存：列表与标题的旁路存储

会话事件之外，`session-projection-cache` 会把投影状态写入 `session_projcache` 域：

- 路径：`~/.dsh/storages/session_projcache/sessions/<id>.json`
- 布局：`per-record`，一个会话一个文档
- 域版本：7
- 文档外形：

```json
{
  "version": 7,
  "record": {
    "identity": {
      "formatVersion": 4,
      "createdAt": 1794913299168,
      "cwd": "...",
      "isSeeded": false,
      "inheritedEventCount": 0
    },
    "rows": {
      "title": { "ver": 1, "seq": ..., "val": "..." },
      "turnOutline": { "ver": 2, "seq": ..., "val": { "...": "..." } },
      "...": "..."
    }
  }
}
```

写盘时机（`dsh-session-projection-cache/src/index.ts`）：

- `session/created`：第一次强制写；
- `turn/end`：强制写；
- 每 `200` 个事件或每 `5000ms`：节流写；
- `session/disposed`：最后一次强制写（**这条对热会话删除很关键**：Agent 退出时会重新写缓存）。

缓存里不只是数字统计。实测当前会话缓存包含：

- `title`：会话标题；
- `turnOutline`：每一轮的 prompt 摘要与 response 摘要；
- `titleInput`：首条用户提示词片段；
- `sessionStats`、`tokenUsage`、`contextPressure`、`contextBreakdown`、`modelSelection`、`agentPreset`、`workingDirectory`、`subagentCatalog` 等。

也就是说，**日志删掉后，缓存仍可能保留用户提示词和标题**。

### 2.5 列表读取：日志 header + 缓存 hints

`SessionPersistence.list()` 只扫描会话目录、读最高代际的 header，不读事件体；Web 会话列表再叠加投影缓存中的标题/统计信息。由此产生一个直接后果：

- 删掉日志目录 → 该会话不再出现在 `list()` 中；
- 但缓存文档不会自动消失 → 成为孤儿残留（见 §3.2 实测）。

---

## 3. 一个会话到底留下了什么

### 3.1 工件总表

| 工件 | 位置 / 键 | 产生时机 | 删除方式 | 备注 |
|---|---|---|---|---|
| 会话日志 | `~/.dsh/sessions/<projectKey>/<encodeSegment(id)>/session.v*.jsonl.zstd` | 第一次 append/flush | 删除整个会话目录 | 必须包含所有历史代际与临时文件 |
| 写锁 | 同目录 `session.lock` | 首次物化 / write open | 随目录删除 | POSIX `flock` 锁文件；持锁期间不能删 |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<id>.json` | create / turn end / 节流 / disposed | 通过 `session_projcache` 域 `delete`，或删文件 | 含标题、提示词摘要；可能有 `.bak.<stamp>` |
| 工作区成员 | `~/.dsh/storages/workspace.json` → `tables.workspaces[*].sessionIds` | 创建/导入/调度时 attach | `Workspace.detachSession(id)` | `sessionIds` 可能有内存索引残留 |
| 工作区置顶 | 同上 → `global.pinnedSessionIds` | 用户 pin | `WorkspaceRegistry.unpinSession(id)` | 单项数组 |
| 工作区归档 | 同上 → `global.archivedSessionIds` | 用户归档 | `WorkspaceRegistry.unarchiveSession(id)` | 归档是隐藏，不是删除 |
| 计划任务 | `~/.dsh/storages/schedule.json`（域 `schedule` v2） | 创建提醒/目标任务 | 删除 `target.sessionId` 或 `involvedSessionIds` 含该 id 的任务 | 内置 `session-stop` 只删 active 目标任务 |
| 图片对象 | `~/.dsh/attachments/v1/objects/<2hex>/<sha256>` | 图片上传 | 引用计数为 0 时删除 | 内容寻址、跨会话共享 |
| 文件对象 | `~/.dsh/attachments/v1/file-objects/<2hex>/<digest>` | 文件上传 | 引用计数为 0 时删除 | 同上 |
| 文件引用硬链接 | `~/.dsh/attachments/v1/files/<2hex>/<digest>/<name>` | 文件上传 | 删除整个 `<digest>` 目录 | 与对象分离的只读引用路径 |
| 请求图片缓存 | `~/.dsh/cache/attachments/request-images/<2hex>/<hash>` | 模型请求前派生 | 无逐附件映射；只能整目录清或保留 | `variantId` 哈希，不能从 attachmentId 反推 |
| Provider 上传索引 | `~/.dsh/llm-deepseek/files-v3.json` | 图片上传 Files API 后 | 删除匹配 `attachmentId` 的记录或整文件 | 只含映射，不含图片字节；远端文件另存 |
| 浏览器会话草稿 | `dsh.conversation.<id>`（localStorage） | 输入/切换 View | 客户端 `localStorage.removeItem` | 含草稿文本与引用 |
| 浏览器侧栏布局 | `dsh.sidebar-right.v1.<id>` | 侧栏操作 | 客户端删除 | 含 tab/layout |
| 浏览器 Browser tab | `dsh.sidebar-browser.v1.<id>` | 使用内嵌浏览器 | 客户端删除 | 含 URL/标题等 |
| 浏览器问题草稿 | `dsh.user-questions.drafts.v1.<id>` | 回答用户问题 | 客户端删除 | 含回答草稿 |
| 计划任务 tab 绑定 | `dsh.schedule.task-tab.v1.<id>` | 打开任务页 | 客户端删除 | 只含 task id |
| 当前选择 | `dsh.sessions.current` | 切换会话 | 若指向被删 id，清空/改选 | 形状 `{ sessionId?, subagentAddress? }` |
| 工作区手动排序 | `dsh.workspace.view.v5` | 拖拽排序 | 从 `sessionOrderByAccount` 数组移除 id | 全局文档，需谨慎 |
| 内存 Session | `ctx.sessions` | create/enter | 只能通过 owner fiber/handle 拆除 | 插件无按 id remove |
| 内存 Agent | `ctx.agents` | create/resume | 只能通过 `AgentHandle.dispose()` | 插件拿不到 handle |
| 持久化写 handle | JSONL tracker | create/open write | handle.close / agent dispose | 持有 `session.lock` |
| 投影缓存内存行 | `session_projcache` 域 table | 读取/写入 | 域 `delete` | 只删文件会留下内存行到重启 |
| 查询 prepared 缓存 | `session-query` 内部 LRU | 冷读 | 无公开失效；随 LRU/重启淘汰 | 只在内存；`observeSession` 每次先 stat，删后不可再取 |
| 日志解析 memo | JSONL backend `coldLogMemo` | 冷读 | 无公开失效；随 LRU/重启淘汰 | 只在内存 |
| 父会话 catalog | 父会话日志的 `subagent/catalog` 事件 | 创建 subagent | 不可原地改写 | 删子会话后父日志仍引用子 id |
| 父会话 header | 子会话 header `parentSession` | 创建 subagent | 随子会话删除 | 删父不删子会留下悬空父 id |
| 官方日志副本 | DeepSeek 官方 API | 每次官方模型请求 | 本地无法撤回 | 见 §3.6 |
| OTel/反馈副本 | OTel collector | 用户显式反馈 | 本地无法撤回 | `FEEDBACK_ONLY` |
| 工作区文件 | 会话 cwd 下 | 工具读写 | **不属于会话存储** | 删除会话不应删工作区文件 |

补充：

- **路径根不是唯一形态**：header 没有 `cwd` 时，project 目录是 `_no-cwd`；删除应使用 `stat.location.path` 反推目录，而不是自己拼 project 名。
- **插件自有 sidecar**：本机还安装了既有的会话管理类插件，带有自己的数据文件（例如 `~/.dsh/dsh-session-manager/annotations.v1.json`，本轮未读取其内容）。这类数据不属于 DSH 核心会话存储，新插件不应猜测或改写其 schema；应在 README 中说明由对应插件自行清理，或者在明确适配后再处理。
- **`.DS_Store`**：项目目录里可能存在 Finder 生成的 `.DS_Store`。它不是会话内容，删除会话时不应把它当作会话文件；若要清理空项目目录，需单独判断。

### 3.2 实测盘点（2026-11-17）

| 指标 | 实测值 | 证据 |
|---|---:|---|
| 会话目录 | 31 | `~/.dsh/sessions/*/*/` |
| 当前代际 | 全部 `session.v4.jsonl.zstd` | `find ... -name 'session*.jsonl*'` |
| 投影缓存记录 | 35 | `session_projcache/sessions/*.json` |
| **孤儿缓存** | **4** | 缓存 id 不在会话目录中 |
| 附件对象 | 118 | `attachments/v1/objects/*/*` |
| 附件被引用数 | 118 | 扫描全部日志中的 `attachmentId` |
| 共享附件 | 3 | 同一 attachmentId 出现在两个会话 |
| Provider 上传记录 | 118 | `llm-deepseek/files-v3.json` |
| 工作区记录 | 15 | `workspace.json` |
| 工作区中的会话引用 | 28 | 15 个 workspace 的 `sessionIds` 合计 |
| 归档/置顶 | 0 / 0 | `archivedSessionIds` / `pinnedSessionIds` |
| 当前会话官方日志上传 | 追踪时 159 条 accepted，`throughSeq=1219`（本地 1224 事件） | 当前会话日志解析 |

孤儿缓存的直接含义：

- 4 份 `session-*.json` 对应的会话日志已经不存在；
- 它们仍然包含 `title` 与 `turnOutline.prompt`，例如 “Python简繁转换脚本创建”“Obsidian 正则搜索替换插件开发” 及提示词片段；
- 说明此前至少有一种删除路径只删了日志（或日志因其他原因消失），**没有清缓存**。

这不是理论风险，而是当前磁盘上的实际残留。

### 3.3 工作区引用的“内存索引残留”

`workspace.sessionIds` 不是直接读 `workspace.json` 的数组，而是：

```ts
get sessionIds(): readonly SessionId[] {
  return this.record.sessionIds.filter(id => this.host.candidateMatches(id, this.record.path))
}
```

`candidateMatches` 使用启动时构建的 `sessionPaths` 映射（以及 live session），而不是每次 `stat` 会话是否存在。因此：

- 删掉日志后，只要该 cwd 还存在，`sessionPaths` 里仍有这个 id；
- `workspace.sessionIds` 仍可能返回已删除的 id，直到重启或下一次 header index 刷新；
- 所以删除时必须显式 `detachSession(id)`，不能只指望“日志没了自然就没了”。

### 3.4 计划任务：内置 stop 只清 active target

`dsh-schedule` 的 `workspace/session-stop` 监听器调用 `stopSessionTasks(sessionId)`：

```ts
function activeSessionTasks(domain, sessionId) {
  return [...domain.table('tasks').entries()]
    .map(([, task]) => task)
    .filter(task => task.status === 'active'
      && task.target.kind !== 'new'
      && task.target.sessionId === sessionId)
}
```

它只删除 **active 且直接 target 是该会话** 的任务。以下仍会保留会话 id：

- `status` 为 paused / ended 的任务；
- `involvedSessionIds` 中包含该会话、但 target 不是它的任务；
- `pendingDelivery.targetSessionId` 指向该会话的 `new_once` 任务。

要做到“彻底”，需要在 Host 侧列出任务并删除所有 `target.sessionId`、`involvedSessionIds`、`pendingDelivery.targetSessionId` 命中该 id 的记录，而不是只 dispatch `session-stop`。

### 3.5 附件：内容寻址、共享、且没有删除 API

- 图片：`attachments/v1/objects/<sha 前 2 位>/<sha256>`，attachmentId 形如 `sha256:<hex>`。
- 文件：`file-objects/<2>/<digest>` 与只读硬链接 `files/<2>/<digest>/<name>`。
- 实测 118 个对象全部被至少一个会话引用，其中 3 个被两个会话共同引用。
- 共享来源包括 fork/复制会话、把同一图片粘到另一个会话、导入等。
- 因此**不能按会话目录直接删附件**，必须先建立“剩余会话 → attachmentId”的引用集合，再删除引用计数为 0 的对象。

请求图片缓存：

- 路径由 `variantId` 的 sha256 决定，`variantId` 又包含 attachmentId、目标尺寸、字节目标、编码器参数等；
- 仅凭 attachmentId 无法枚举它的所有 request-image 缓存文件；
- 想要清除被删会话的派生图片字节，实际选择只有“清空整个 `request-images` 缓存”或“保留”；清空是安全的（缓存可重建），但会影响其他会话的首次请求性能。

Provider Files API：

- `~/.dsh/llm-deepseek/files-v3.json` 保存 `attachmentId → fileId` 映射；
- 实测 118 条记录与 118 个附件一一对应；
- 删除本地会话不会删除远端文件；远端文件有 `expiresAt`，但过期前仍是外部副本；
- 本地可以做的是删除该 attachmentId 对应的索引记录（避免继续复用），或在具备 provider 删除能力时调用 provider API。

### 3.6 外部副本：本地删除无法撤回

当前会话日志里追踪时已经有 159 条：

```json
{
  "type": "session-log-deepseek/delivery-accepted",
  "seq": 1220,
  "data": {
    "sessionId": "session-2b56e96a-3962-48f4-9509-ba7ea8531a8f",
    "sessionFormatVersion": 4,
    "throughSeq": 1219
  }
}
```

含义：

- `session-log-deepseek` 默认启用（`enabled: true`），每次官方模型请求会携带 `dsh_session_log` 字段；
- 本地日志的绝大部分已经到达 provider；
- 删除本地文件不会撤回这些副本；
- 同理，OTel 反馈、产品分析、导出文件、Time Machine/备份、Chromium HTTP 缓存中的副本，都不在会话存储的删除范围内。

因此 README/UI 必须明确声明：“删除会话 = 删除本机 DSH 存储中的副本；不撤回已发送给模型 provider 的内容，也不删除工作区文件/备份”。

### 3.7 浏览器端残留

DSH Desktop 的 localStorage 落在：

```
~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb
```

按源码，至少这些键是会话级的：

| 键 | 来源 | 内容 |
|---|---|---|
| `dsh.conversation.<id>` | `dsh-client-ui-conversation/src/client/stores.ts` | 草稿、View 选择 |
| `dsh.sidebar-right.v1.<id>` | `dsh-client-ui-sidebar-right/src/client/persistence.ts` | 侧栏布局/tab |
| `dsh.sidebar-browser.v1.<id>` | `dsh-client-ui-sidebar-browser/src/client/browser/store.ts` | 内嵌浏览器 tab |
| `dsh.user-questions.drafts.v1.<id>` | `dsh-client-ui-user-questions/src/client/draft-store.ts` | 问题回答草稿 |
| `dsh.schedule.task-tab.v1.<id>` | `dsh-client-ui-schedule/src/client/task-tab-bindings.ts` | 任务页绑定 |
| `dsh.sessions.current` | `dsh-client-ui-workspace/src/client/navigation.ts` | 当前选中会话 |
| `dsh.workspace.view.v5` | `dsh-client-ui-workspace/src/client/stores.ts` | 手动排序数组，可能含 id |

注意：

- `localStorage.removeItem` 只是写入删除标记；LevelDB 的 `.ldb` 旧段可能保留旧值到 compaction；
- 浏览器/Electron 的 HTTP 缓存、blob_storage、`Cache/Cache_Data` 可能保留图片响应；
- 这些属于“本机用户级删除”的边界，不是 DSH 会话存储的一部分。

### 3.8 内存态

删除文件后，以下内存态仍然持有已删会话的内容，直到进程退出或对象被淘汰：

- `ctx.sessions` 中的 live Session（如果存在）；
- `ctx.agents` 中的 Agent（如果存在）；
- JSONL 写 handle 及其缓冲；
- `session_projcache` 域的内存行；
- `session-query` 的 prepared LRU（默认 5）与观测 lease；
- JSONL backend 的 `coldLogMemo`；
- 客户端 session manager 的列表/会话对象/历史流。

其中，对**冷会话**，`session-query` 的冷读每次都会先 `persistence.stat(id)`，所以会话删除后新的 `observeSession(id)` 会返回 `SESSION_QUERY_SESSION_NOT_FOUND`；但删除前已拿到的 lease 仍能在内存里读到内容。对**热会话**，`ctx.sessions.get(id)` 仍然命中 live Session，`observeSession` 会直接返回它。这不是磁盘残留，但会影响“删除后立即不可见”的语义。

---

## 4. 删除反推：一条可实施的路径

### 4.1 先做能力判断

| 会话状态 | 判断方式 | 能否删除 | 建议 |
|---|---|---|---|
| 冷会话（仅磁盘） | `ctx.sessions.get(id) === undefined` 且 `stat(id)` 有 `location` | 可以 | 主路径 |
| 热会话（当前进程已加载） | `ctx.sessions.get(id) !== undefined` | 公开 API 无法拆除 | 两阶段/重启，或拒绝 |
| 仅 pending、未物化 | `stat(id)` 无 `location` | 无文件可删 | 只能依赖 owner 释放；拒绝并提示 |
| 其他进程持写锁 | write open / flock 返回 `SessionAlreadyOwnedError` | 不可以 | 拒绝并提示“正在使用” |
| 历史格式 | `stat.formatStatus === 'migration-required'` | 可以删目录，但不要用 write open | write open 会触发迁移，产生副作用 |
| 子会话 | `header.origin === 'subagent'` | 可以，但父日志仍引用 | 建议整棵子树删除，或明确警告 |
| Fork 会话 | `isSeeded === true`，`origin` 通常 undefined | 独立副本 | 不随源会话自动删；要提示用户 |

### 4.2 子树解析

“删除父会话”不等于“删除它的 subagent 子会话”。子会话有自己的日志文件，位于同一项目目录下，id 是裸 uuid。

建议：

1. `sessionPersistence.list()` 取全部 header；
2. 以 `origin === 'subagent'` 且 `parentSession` 链能到达目标 id 的节点为后代；
3. 防环（`parentSession` 可能被历史数据写坏）；
4. 对外部/未知子会话（没有本地日志）只删父日志中的引用是不可行的，直接忽略；
5. 对普通 fork（`isSeeded` 但 `origin !== 'subagent'`）不递归，只提示“这是独立副本”。

### 4.3 写互斥：两种方案

#### 方案 A：走公开 seam（兼容用于非损坏的 v4 冷会话）

> 第二轮修正：见 §10.4.4。冷删除的首选已改为“rename 提交点 + 可选原生 flock”；`open('write')` 会读完整日志，遇到损坏/超大/历史日志会阻塞删除，只适合作为兼容路径。

```
const handle = await ctx.sessionPersistence.open(id, 'write')
```

- 会走 `claimWrite` + `flock`，能可靠排除本进程与其他进程的写者；
- 对 v4 现有日志不会迁移；
- 缺点：`open` 会读取并验证整个日志（`requireStoredLog`），大日志耗时/占内存；
- 对历史格式会触发迁移发布，不适合删除路径；
- 关闭 handle 不会改写日志（没有 append 时不 truncate）。

#### 方案 B：直接 `flock(session.lock)`（更轻，但更底层）

- `@deepseek-ai/node-addon-system` 在安装包内提供了 `./flock` 入口（`tryLockExclusive(fd): Promise<void>`）；它是否能在插件运行时直接解析，取决于插件的依赖声明与宿主模块解析路径，实施前需要验证；
- 需要复刻 `SessionWriteLease` 的 inode 校验（锁定后确认路径仍指向同一 inode，必要时重试）；
- 不读取日志，适合大日志；
- Windows 的锁是命名 semaphore，不是 `session.lock` 文件，需要平台分支；
- 必须同时检查 `ctx.sessions.get(id)`，否则本进程 live writer 也会被绕过。

无论哪种方案，**绝不能在持锁写者仍活跃时删除 `session.lock`**。lease 文档明确说：POSIX 删除锁文件会丧失互斥，且“nothing in the harness does so”。

### 4.4 删除顺序与可重入性

建议以“意图日志（journal）”为中心，而不是一次不可恢复的 `rm -rf`：

```
prepare(intent):
  intent = {
    id, header: { createdAt, cwd, isSeeded, parentSession, origin },
    subtreeIds, attachmentIds, createdAt
  }
  persist intent durably (plugin-owned sidecar)

phase 1: stop & hide
  - workspace/session-stop (cancel turns/jobs/subagents, schedule active tasks)
  - archiveSession(id, { stopActivity: true })   // 热会话先隐藏并阻断后续 step
  - 递归处理子树

phase 2: metadata cleanup
  - 从所有 workspace 的 sessionIds detach
  - 若会话不是“被我们为隐藏而归档的热会话”：unpin / unarchive
  - 热会话保留 archive 标记到启动收尾（此时 unarchive 会把它重新暴露给 UI）
  - 删除所有 schedule 任务中引用该 id 的记录
  - 删除 session_projcache 记录（域 delete 优先）

phase 3: logs
  - 对每个目标会话目录：先删非当前代际，再删当前代际，最后删 session.lock
  - fsync 会话目录与 project 目录
  - rmdir 会话目录；若 project 目录为空，可 best-effort rmdir

phase 4: attachments (可选，建议放到启动时)
  - 扫描剩余会话与 live 事件，得到仍被引用的 attachmentId 集合
  - 仅删除 intent 中且已无其他引用的对象/引用路径
  - 清理 provider upload index 记录
  - 视策略清空 request-image 缓存
  - fsync 相关目录

phase 5: client
  - 删除已知 localStorage 会话键
  - 若 dsh.sessions.current 指向该 id，清空/改选
  - 从 dsh.workspace.view.v5 的排序数组移除
  - 刷新会话列表；热会话由插件的 Client 端从本地列表移除并刷新，不能依赖 Host 的 `session/disposed`（热会话不会触发它）

phase 6: finish
  - 删除 intent
```

为什么 phase 2 在 phase 3 之前：

- `workspace.detachSession` / `unpinSession` / `unarchiveSession` 都不要求会话仍存在；
- 先清小工件，崩溃后日志仍在，重试成本低；
- 但隐私优先时也可以反过来，只要 journal 记录完整、每步幂等。

为什么 phase 4 建议放到启动时：

- 附件引用扫描需要读取全部剩余会话；
- 如果进程内还有 live session，用户可能刚上传了同字节附件但尚未写入日志，立即 GC 会误删；
- 启动时没有本进程的 live Agent，竞态最小（仍要防范其他进程）。

### 4.5 热会话的两阶段策略

> 第二轮修正：见 §10.4.2 / §10.7.1。若允许使用非公开 `sessions.store`/`entry.detach` 与 `agents.detachEntered`，热会话可以直接“数据删除 + 注册脱离”，不需要本节的两阶段归档；本节保留为“不允许私有面/无法安全 detach”时的备选。

公开 API 下没有“按 id dispose Agent”的能力，因此建议：

1. `archiveSession(id, { stopActivity: true })`
   - 立即从默认列表隐藏（`archivedSessionIds`）；
   - `ArchivedSessionGate` 阻断后续 `agent/pre-step`；
   - `session-stop` 取消当前 turn、jobs、subagents、active schedule；
2. 删除日志目录与缓存；
3. 记录 intent，保持 archive 标记，防止用户在进程存活期间误恢复；
4. 下次启动时：
   - 进程中没有 live Agent；
   - 重放 intent，删掉可能被 `session/disposed` 重新写出的缓存；
   - 清理 `archivedSessionIds` / `pinnedSessionIds` / workspace 引用；
   - 删除 intent。

这条路径的语义是“**文件立即删除，内存残留到进程退出，重启后彻底消失**”。如果产品不能接受“重启前 live 会话仍在内存中”，则只能拒绝删除热会话，要求用户重启 Harness 后再删。

### 4.6 为什么缓存必须用域删除，而不是只 `rm`

- `session_projcache` 的读是同步内存读；只删文件，内存行仍会被 `cachedSnapshot()` 命中，直到重启；
- `coldSnapshot()` 的写回是 fire-and-forget；搜索/冷读可能在删除后重新写回文件；
- 域删除 `table.delete(id)` 会排在写链上，能在内存和磁盘两侧同时生效；
- 但域已被 `session-projection-cache` 通过 `open()` 占用，插件不能再次 `open()` 同名域；可用的入口是 `ctx.storageDomain.get('session_projcache')`（诊断面）后 `table('sessions').delete(id)`，或者后续在上游增加正式的删除 API。
- 若不想依赖诊断面：直接删文件，并接受内存行到重启；同时在启动时做一次“缓存 id 不在持久化列表 → 删除”的孤儿清理。实测的 4 份孤儿缓存说明这个清理本身也有价值。

### 4.7 删除路径的安全检查

删除前至少检查：

1. `stat(id)` 返回的 header id 与请求 id 相同；
2. `header.createdAt` 与 intent 中记录的一致（防止 id 复用误删新会话）；
3. `stat.location.path` 的 basename 等于 `encodeSegment(id)`；
4. 目录位于该 backend 的 root 下（默认 `~/.dsh/sessions`，或从 `location.path` 反推并校验）；
5. 不跟随 symlink：`lstat` 目录，拒绝 symlink；
6. 写互斥成功（open write 或 flock）；
7. `ctx.sessions.get(id) === undefined`（或走热会话两阶段）；
8. 远端调用需 `ctx.remoteAccess.allows({ kind: 'session', id })` 授权；
9. 删除操作必须二次确认，且不要默认暴露给模型工具。

### 4.8 删除后的验收断言

| 断言 | 检查 |
|---|---|
| 日志目录不存在 | `lstat(sessionDir)` → `ENOENT` |
| 会话不在列表 | `sessionPersistence.list()` 无该 id |
| `stat` 不存在 | `persistence.stat(id) === undefined` |
| 缓存不存在 | `session_projcache/sessions/<id>.json` 不存在，域 `get` 为空 |
| 工作区无引用 | 所有 workspace `sessionIds`、pin、archive 不含 id |
| 计划任务无引用 | 所有 task 的 target/involved/pendingDelivery 不含 id |
| 子会话处理 | 子树全部满足上述条件，或按策略保留并提示 |
| 附件 | 共享附件保留；唯一附件对象/引用路径删除；provider 索引记录删除 |
| 客户端 | 已知 localStorage 键不存在；当前选择不指向 id |
| 重启后 | 列表、搜索、标题、统计、`readTitle` 均无该会话 |
| 崩溃重入 | 在任一 phase 后 kill 进程，重启后 intent 继续完成且不误删其他会话 |

---

## 5. 关键难点与未解问题

### 5.1 热会话无法干净拆除

这是当前版本最大的结构性限制：

- `AgentRegistry` 公开方法只有 `create`、`resume`、`register/enter/announce`、`get`、`list`；没有 `remove(id)` / `dispose(id)`；
- `AgentHandle.dispose()` 是 capability，只返回给创建者；
- Web 的 `ApiSessionAgentController` 只取 `.agent`，丢弃 handle；
- `workspace/session-stop` 只 cancel，不 dispose；
- 直接 dispose `agent.scope`（或 `agent.ctx.fiber`）只会撤销该 Agent 作用域的注册，不会触发 `AgentLoop` 的 teardown（关闭写 handle、detach session/agent、发出 disposed）；
- 通过 `ctx.sessions` 的私有 `detachEntered` 或 `ctx.agents` 的私有 `store` 强行拆除属于未公开内部 API，版本升级即坏，不建议。

因此必须二选一：

- **产品上拒绝删除热会话**，提示“先重启 Harness”；
- **两阶段删除**：归档隐藏 + 删文件 + 启动时收尾（§4.5）。

### 5.2 缓存会在退出时“复活”

`session/disposed` 是投影缓存的强制写点。热会话即使当前被删除了缓存文件，进程退出时仍可能重新写出 `<id>.json`。因此：

- 热会话删除必须留下 intent，在下次启动时再删一次缓存；
- 或者只在冷会话上提供删除；
- 启动时还应对“持久化列表里不存在的 id”做孤儿缓存清理（当前已有 4 个实例）。

### 5.3 附件 GC 的竞态与共享

- 附件按内容哈希共享，不能按会话删除；
- 需要扫描全部剩余会话（含 live）的 `attachmentId`；
- 刚上传但尚未写入日志的 live 会话会造成“引用尚未可见”，立即 GC 可能误删；
- 请求图片缓存无法按 attachmentId 反查，只能整目录清或保留；
- Provider 远端文件无法由本地删除；
- 建议：默认只删日志/缓存/引用；媒体清理作为可选项，并在启动时、无 live 会话、持有全局清理锁时执行。

### 5.4 跨会话引用不可改写

会话日志是 append-only，且格式迁移也只追加新代际，不原地改写。以下引用写在**其他会话的日志**里，删除目标后仍会保留，无法原地移除：

- 父会话的 `subagent/catalog` 引用子会话 id；
- 子会话的 header `parentSession` 引用父会话 id；
- 普通 fork 的 `parentSession`（历史数据）；
- `session-reference` 把另一个会话的 surface 快照复制进本会话（内容已经复制，删源不影响副本）。

另外，以下**外部状态**中的引用可以清理，但必须主动清理：

- 计划任务的 `target.sessionId` / `involvedSessionIds` / `pendingDelivery.targetSessionId`；
- 工作区的 `sessionIds` / `pinnedSessionIds` / `archivedSessionIds`。

因此“彻底删除一个子会话”在严格意义上要求连同父会话一起删除；只删子会话会在父日志中留下一个可诊断但不可移除的引用。产品上应明确：

- 删除顶层会话 → 级联删除它的 subagent 子树；
- 删除单个 subagent 子会话 → 允许，但提示父会话仍会保留其 id/标题；
- fork/引用副本 → 独立删除，不自动级联。

### 5.5 历史格式与跨平台

- 当前所有日志都是 v4；但代码支持 v0-v4 代际。删除应删整个目录，而不是只删 `session.v4.*`。
- 对历史格式不要走 `open(id,'write')`，否则会触发迁移发布；如果要加写互斥，应使用原生 `flock`（POSIX）或专门的平台实现。
- Windows 没有 `session.lock` 文件（命名 semaphore），删除逻辑不能假设锁文件存在；跨平台需要单独验证。

### 5.6 工作区/列表的内存索引

- `workspace.sessionIds` 依赖启动时 header 索引，删除日志后仍可能返回旧 id；必须 `detachSession`。
- `ApiSessionList` / Client 的列表缓存可能在删除后短暂显示旧行；需要客户端 refresh 或删除通知。
- 对于热会话，Host 列表仍会把 live session 算进去；归档只是 UI 过滤，不是 Host 列表移除。

### 5.7 删除“当前会话”

如果用户在正在对话的会话里触发删除，Host 会尝试停止/删除自己所在的 Agent：

- 工具调用可能在中途被 cancel；
- 写 handle 被关闭后，删除动作本身可能无法完成；
- 客户端还会在卸载时重新持久化草稿。

建议禁止删除当前活动会话，或要求先切换到其他会话/使用独立的管理面板。

### 5.8 已发送给 provider 的内容

这不是插件能解决的，但必须在产品语义中写清楚：

- 官方 API 的 `dsh_session_log` 已上传日志；
- 图片已上传 provider Files API；
- OTel 反馈副本；
- 导出的 Markdown/JSON 文件；
- Time Machine/备份/文件系统快照。

“删除会话”只能承诺本机 DSH 存储的清理，不能承诺外部副本撤回。

---

## 6. 建议的测试矩阵

| 场景 | 步骤 | 预期 |
|---|---|---|
| 冷顶层会话 | 新建 → 结束 → 重启 → 删除 | 目录/缓存/工作区/列表全部消失 |
| 热顶层会话 | 新建 → 保持打开 → 删除 | 按策略拒绝，或归档+删文件+重启后消失 |
| 带 subagent 的父会话 | 父会话启动 subagent → 删父 | 父子目录都消失；父日志不再可读 |
| 单独删 subagent | 只删子会话 | 子日志消失；父日志保留 catalog 引用（可诊断） |
| fork 会话 | fork 一个会话 → 删源 | fork 保留；提示独立副本 |
| 共享附件 | 两个会话引用同一图片 → 删其中一个 | 对象保留；另一个会话仍可读 |
| 唯一附件 | 只被目标会话引用 → 删 | 对象/引用路径/索引记录删除 |
| 归档/置顶 | 归档并置顶 → 删 | archive/pin 列表都不含 id |
| 计划任务 | active/paused/ended 任务引用会话 → 删 | 全部引用任务删除（或按策略） |
| 历史格式 | v0-v3 日志 → 删 | 整个目录删除；不触发迁移 |
| 第二进程持写 | 另一个进程 write open → 删 | 拒绝，提示正在使用 |
| 删除中崩溃 | 在每个 phase 后 kill → 重启 | journal 继续完成；不误删新会话 |
| 路径穿越 | 构造 `../` 等 id | 拒绝；不越出 sessions root |
| Windows | 同冷会话用例 | 无 `session.lock` 假设；semaphore 分支正确 |
| 客户端 | 删除后刷新页面 | 无草稿/布局/浏览器 tab 残留；当前选择不指向 id |
| 外部副本 | 删除后检查 provider | 不承诺撤回；文档明确说明 |

---

## 7. 建议的文档/产品措辞

建议在插件 README 和确认对话框中明确区分三件事：

1. **删除会话（本机）**：删除 DSH 会话日志、投影缓存、工作区/计划引用、可选的附件对象和客户端本地状态。
2. **不删除**：会话 cwd 下的工作区文件；已上传给模型 provider 的日志/图片；OTel/分析/导出/备份副本。
3. **热会话**：如果当前进程已加载该会话，删除会在重启后彻底完成，或需要先重启。

---

## 8. 参考坐标

### 8.1 安装包源码

- `@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts`
  - `projectKey`、`encodeSegment`、`sessionDir`、`logPath`、`toHeaderLine`
- `@deepseek-ai/dsh-session-persistence-jsonl/src/index.ts`
  - `create`（懒物化）、`open`（写互斥/迁移）、`stat`（`location`）、`list`（header-only）、`materialize`、`appendLines`
- `@deepseek-ai/dsh-session-persistence-jsonl/src/lease.ts`
  - `SessionWriteLease`、`session.lock`、`release` 不删锁文件
- `@deepseek-ai/dsh-session-persistence-jsonl/src/storage.ts`
  - `LIVE_WRITE_BATCH_MAX_DELAY_MS = 200`、`close` 只 drain + release
- `@deepseek-ai/dsh-session-persistence/src/index.ts`
  - 只有 `create/open/flush/stat/list`，没有 delete
- `@deepseek-ai/dsh-session/src/index.ts`
  - `SessionStore.prepare/enter/announce`、`session/disposed`
- `@deepseek-ai/dsh-agent/src/index.ts`
  - `AgentRegistry.get/list/create/resume`、`AgentHandle.dispose`
- `@deepseek-ai/dsh-agent-loop/src/index.ts`
  - `createStoredSession`、`initializeAgent`、teardown（scope/handle/detach）
- `@deepseek-ai/dsh-session-projection-cache/src/index.ts`
  - `session/created`、`turn/end`、`session/disposed` 写点；`cachedSnapshot`
- `@deepseek-ai/dsh-session-projection-cache/src/spec.ts`
  - `session_projcache` v7、`per-record`、`invalidRecords: 'backup-and-skip'`
- `@deepseek-ai/dsh-workspace/src/index.ts`
  - `candidateMatches`、`sessionPaths`、`archiveSession/unarchiveSession/pinSession/unpinSession`
- `@deepseek-ai/dsh-workspace/src/entity.ts`
  - `detachSession`、`attachSession`、`mutate`
- `@deepseek-ai/dsh-schedule/src/index.ts`
  - `activeSessionTasks`、`stopSessionTasks`、`workspace/session-stop`
- `@deepseek-ai/dsh-attachment-local/src/store.ts`
  - `objects/<2>/<sha>`、内容寻址
- `@deepseek-ai/dsh-attachment-local/src/file-store.ts`
  - `file-objects`、`files/<2>/<digest>/<name>`
- `@deepseek-ai/dsh-attachment-local/src/request-image.ts`
  - `request-images/<2>/<hash>`、`variantId` 哈希
- `@deepseek-ai/dsh-llm-deepseek/src/upload-index.ts`
  - `files-v3.json`、`attachmentId/variantId/fileId`
- `@deepseek-ai/dsh-session-log-deepseek/src/index.ts`
  - `dsh_session_log`、`session-log-deepseek/delivery-accepted`

### 8.2 运行时数据

- `~/.dsh/sessions/`：31 个会话目录、全部 v4
- `~/.dsh/storages/session_projcache/sessions/`：35 份缓存、4 份孤儿
- `~/.dsh/storages/workspace.json`：15 个工作区、28 个会话引用
- `~/.dsh/attachments/v1/objects/`：118 个对象、3 个共享
- `~/.dsh/llm-deepseek/files-v3.json`：118 条远端文件映射
- `~/Library/Application Support/@deepseek-ai/dsh-desktop/Local Storage/leveldb`：客户端会话级 localStorage

### 8.3 文档中明确写出的限制

- `dsh-session-persistence-jsonl/README.md`：
  - “Nothing deletes session files — logs accumulate under `root` until removed externally; the seam has no deletion API.”
  - 保留历史代际；压缩帧；`session.lock` 的 POSIX 删除语义。
- `dsh-workspace/README.md`：
  - 归档是隐藏，不是删除；
  - “session deletion … separate, absent capabilities.”
- `dsh-session-projection-cache/README.md`：
  - 无 eviction/retention surface；记录按会话累积，清理是 out-of-band。
- `dsh-attachment-local/README.md`：
  - 附件永不自动删除；无未引用对象收集。
- `dsh-session-query-sqlite/README.md`：
  - 派生索引会在语料变化时 reconcile；当前安装是 `:memory:` + `openAt: never`。

---

## 9. 待决策问题（新 `FEASIBILITY@0.2.2-rc.3.md` 第 8 节给出建议）

以下语义仍需最终确认（§10 已给出综合建议）：

1. **热会话**：拒绝删除并要求重启，还是“归档 + 删文件 + 启动收尾”？
2. **子会话**：删顶层会话时是否级联删除 subagent 子树？（建议是）
3. **附件**：默认是否删除仅被该会话引用的附件？请求图片缓存是否整目录清空？
4. **Fork/引用副本**：是否提示“独立副本，不随源删除”？是否提供按 lineage 级联？
5. **历史格式**：只支持 v4，还是支持删除整个目录（含旧代际）？
6. **外部副本**：是否在 UI 中强制展示“provider 已收到日志/图片，无法撤回”的警告？
7. **删除审计**：是否需要记录删除历史？若记录，如何避免新的敏感 sidecar？
8. **权限**：删除入口是否只对 owner 开放？是否允许模型工具调用？

这些问题已在新 `FEASIBILITY@0.2.2-rc.3.md` 第 8 节综合；确认后按该文件第 6 节进入代码实现。

---

## 10. 综合判断：如何安全地删除会话

> 本节是第二轮补充。输入有三部分：
>
> 1. 本文 §2–§5 对会话生成、落盘与工件的独立追踪；
> 2. 工作区现有的 [REF-IMPLEMENTATION.md](REF-IMPLEMENTATION.md)（原 `FEASIBILITY@0.2.2-rc.3.md`）对 `dsh-session-manager` 0.7.8 删除实现的调查（R1–R12、私有符号表、方案 B）；
> 3. 对 `~/.dsh/profiles/desktop/node_modules/dsh-session-manager` 源码的复核。
>
> 用户已明确允许使用非公开函数。但“允许使用”不等于“可以静默依赖”：私有面必须做能力探测、失败关闭、版本固定，并把不可恢复的语义写清楚。

### 10.1 判断口径

先把“安全”和“彻底”拆开，否则会得到互相矛盾的结论。

| 维度 | 本文采用的定义 |
|---|---|
| 路径安全 | 只能删除 `<sessions root>/<project>/<sessionDir>`，不能越界、不能跟随符号链接、不能因为 id 碰巧匹配就删。 |
| 生命周期安全 | 不能误删同 id 的新会话；不能在持锁 writer 仍活跃时删除锁文件；不能把已删会话“写回来”。 |
| 并发安全 | 停止活动后再删除；删除窗口内 resume/new 输入不能重新 materialize 出同一个会话。 |
| 一致性 | 不能出现“文件还在、列表已消失、用户无法重试”的 torn state；失败必须可恢复或至少可诊断。 |
| 附带损害 | 不破坏其它会话共享的附件、父会话 catalog、fork、工作区文件、外部副本。 |
| 可见性 | 删除成功后 Host 列表、工作区、pin/archive、计划任务、客户端会话键都不再引用该 id。 |
| 彻底性 | 本机 DSH 存储 + 客户端会话状态 + （可选）仅被该会话引用的媒体；**不包括** provider/OTel/导出/备份等工作区外副本。 |

**结论先行：**

- **冷会话的“安全删除”可以做到接近事务性**：先用 rename 把会话目录移出 `sessions` 根作为提交点，再删隔离目录，最后做元数据与缓存清理；全过程用 journal 重入。
- **热会话的“安全删除”只能做到“数据删除 + 注册表脱离”**：使用非公开的 `sessions.store`/`entry.detach` 与 `agents.detachEntered`，但 Agent 的 scoped 资源不会立刻 unwind；要么接受它留到进程退出，要么拒绝热删除、要求重启。
- **“彻底删除”必须分层承诺**：默认只承诺 DSH 本机会话存储；附件、provider 副本、浏览器缓存、备份需要单独说明或单独模式。

### 10.2 既有实现中应当保留的部分

`dsh-session-manager` 的删除核心不是 `rm -rf`，以下机制方向正确，应该保留：

| 机制 | 保留理由 |
|---|---|
| `assertSessionId` + header id 复核 + project/session 两层路径限定 | 即使 id 来自 HTTP，也不能拼接出 `../`；目录名匹配但 header 不一致时拒绝。 |
| `assertSessionDirectory` 的逐层 `lstat` + `realpath` + 符号链接/junction 拒绝 | 防止 session 目录被替换成链接后误删外部目标。 |
| `connection.admit(req)` + owner principal | 破坏性操作只允许本机 owner；无凭证/跨站失败关闭。 |
| `workspace/session-activity` + `workspace/session-stop` | 用组合层公开事件停止 turn/jobs/subagents/schedule，而不是逐个猜测插件。 |
| `ctx.sessions.flush(session)` → `entry.detach()` → 关闭 writer | 先排空缓冲、再脱离、再删文件的方向正确；`session/disposed` 让持久化与 API controller 做最后排空和列表移除。 |
| 删除前预检所有后代 | 避免“删了一半后代才发现主会话不能删”。 |
| 投影缓存 tombstone | 解决 `session/disposed` 后迟到的 `table.put` 把缓存写回的问题；这是必要的。 |
| 后代先删、父会话最后 | 与 subagent 的父 catalog 引用方向一致。 |
| 部分失败返回 `deletedSubagents` / `remainingSessionIds` / `partialFailure` | 至少让调用方知道删除已经部分发生。 |
| UI 二次确认 + 预览失败禁用确认 | 破坏性操作没有“一键误删”路径。 |
| MIT 归属 | 若复制其删除核心，必须保留许可证与来源说明。 |

这些机制解决了“路径注入、越权、误操作、缓存迟到写入”的大部分问题。新实现不应从零重写，而应在它们之上修正**顺序、提交点、失败恢复、范围完整性**。

### 10.3 与本次追踪对照后新增/修正的问题

下表只列“既有实现没有解决、或解决得不够”的点；R1–R12 的编号沿用 REF-IMPLEMENTATION.md。

| # | 主题 | 既有实现 | 本次追踪的补充 | 判断/修法 |
|---|---|---|---|---|
| N1 | 工件发现固定列表 | `ARTIFACT_NAMES = [v4, v3, v2, session.jsonl.zstd, session.jsonl]` | DSH 还支持 `session.v1.jsonl.zstd`，未来还会有 `v5+`；`persistence.locate()` 又只返回当前 v4 路径。v1-only 会话在磁盘 fallback 里找不到目录，`sessionDirOf` 返回 undefined，删除会“成功”但把日志留下；v1 子会话也不会被验证/级联 | 改为动态匹配 `^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$`，取最高代际；删除仍删整个目录 |
| N2 | 空目录/损坏目录全局阻塞 | `scanSessionHeaders` 把任何无工件的会话目录计入 `errors`，`complete=false` 后所有删除预览失败 | 删除失败留下的空目录会形成“从此删不了”的死锁（R7） | 只对**目标子树**失败关闭；无关空目录跳过并 warning；损坏目标子树才拒绝 |
| N3 | 工作区成员读取私有 `entity.record` | `detachFromWorkspaces` 用 `entity.record.sessionIds` 绕过 stale 的 `sessionIds` getter | 我们确认 `workspace.sessionIds` 依赖启动时 `sessionPaths` 索引，日志删除后仍可能返回旧 id；必须显式 detach | 保留 detach，但不必读 `record`：对所有 workspace 无条件调用公开的 `detachSession(id)`，id 不存在时它本身就是 no-op |
| N4 | `pinnedSessionIds` 未清理 | 只 `unarchiveSession`，没有 `unpinSession` | 置顶会话删除后 pin 集合残留 | 提交点之后调用 `workspaceRegistry.unpinSession(id)`；失败 warning + 启动重试 |
| N5 | 计划任务只清 active target | `session-stop` 只删除 `status=active && target.sessionId===id` 的任务 | paused/ended、`involvedSessionIds`、`pendingDelivery.targetSessionId` 仍保留 id | 默认至少停止 active；安全彻底模式用公开 `schedule.list`/`edit` 删除所有引用该 id 的任务，或明确文档说明保留 |
| N6 | 投影缓存孤儿 | 删除时清缓存，但没有启动时孤儿清理 | 实测 35 份缓存中 4 份对应日志已不存在，仍保留标题/提示词 | 启动时扫描 `session_projcache/sessions`，删除持久化列表里不存在的 id；也是热删除崩溃后的兜底 |
| N7 | 冷会话伪造 `session/disposed` | 无 live entry 时 `ctx.emit("session/disposed", {id})` | 真实签名是 `(session: Session)`；payload 不合约，且无监听器错误隔离 | 冷会话改发 `api-session/removed(id)`；不要构造假 Session；live 会话用真实 `entry.detach()` |
| N8 | `rm` 前先 detach + 清理 | `entry.detach()` 后做 workspace detach/unarchive，再 `rm`；中途失败就 torn | 与 R1 一致；`rm` 失败会留下“文件还在、列表没了” | 用 **rename 到 sessions 根之外的隔离目录**作为提交点；提交后再做元数据/缓存清理；失败保留 journal |
| N9 | 并发 resume/materialize 窗口 | 关闭 writer 后直接 `rm`；REF-IMPLEMENTATION.md 已标 R4 | 我们确认 `materialize()` 会 `mkdir -p`，`appendLines` 会重新打开路径 | rename 使 canonical 路径原子消失，resume 的 `findLog` 找不到；即使并发 create 也只能落到新的 canonical 目录，不会“复活”旧目录 |
| N10 | 热会话 Agent scope 泄漏 | 取消 agent、等 idle、`agents.detachEntered(entry)`，但不 unwind `agent.scope` | `detachEntered` 只移除 registry 并发 `agent/disposed`，不触发 `AgentLoop` 的 teardown；直接 dispose `agent.scope`（或 `agent.ctx.fiber`）只撤销注册，也不触发 teardown | 接受 scoped 资源留到进程退出，或拒绝热删除要求重启；不要假装“完全 dispose” |
| N11 | 客户端会话级键未清理 | 只 `clearCurrentSession()` + refresh | `dsh.conversation.<id>`、`dsh.sidebar-right.v1.<id>`、`dsh.sidebar-browser.v1.<id>`、`dsh.user-questions.drafts.v1.<id>`、`dsh.schedule.task-tab.v1.<id>` 仍保留草稿/布局/URL | 删除成功后由 Client 精确删除这些键；先导航离开再删 `dsh.conversation`，避免卸载时重新持久化 |
| N12 | 附件/外部副本未承诺 | 明确不删附件；未提 provider/官方日志 | 实测 3/118 附件共享；118 个对象都有引用；官方日志已上传；provider Files API 有 118 条映射 | 默认保留附件（安全）；“secure purge”作为可选模式；provider/OTel/导出/备份永远只能声明不撤回 |
| N13 | 当前会话删除 | 标题栏允许删除当前会话，成功后 clear | UI 删除是 Host HTTP 请求，不依赖被删 Agent 的 turn，通常可完成；模型工具自删则可能在 turn 中被 cancel | UI 允许但要先导航/清空；模型工具不要暴露删除当前会话的能力 |
| N14 | tombstone 生命周期 | `guard.removed` 成功后不清理 | 同进程反复删除会缓慢累积；同 id+同 createdAt 的恢复会被永久拦截 | 成功删除后按 id 清理，或使用有 TTL/容量上限的 guard；启动孤儿清理兜底 |
| N15 | 私有面静默降级 | `?.` 大量使用，关键步骤失败也可能“成功” | 升级后可能不关 writer、不移除 agent、不清缓存，但 UI 显示成功 | 启动能力探测；关键能力缺失时删除 API 返回 `delete-unsupported`/503，不进入 teardown |
| N16 | `coordinator` 死代码 | 检查 `persistence.coordinator.retirements/states` | 0.2.2-rc.3 的 JSONL 后端没有 coordinator，永远静默通过 | 删除这段伪检查，改为真实 writer 能力探测 |
| N17 | Agent detach 顺序 | 先 detach agent，再 detach session | `agent/disposed` 监听器 `publishAgentAvailability` 在 session 仍在 store 时会 `api-session/added`，产生瞬时重加行 | 先 `entry.detach()`（session 消失），再 `agents.detachEntered(entry)`；避免重加 |
| N18 | `session-query` / `coldLogMemo` | 未提及 | 删除后新的 `observeSession` 会先 `stat`，冷会话返回 not found；已持有 lease 仍在内存 | 不持久；文档说明“删除后立即不可见”不等于“内存立即清零” |

这些点中，N1、N2、N3、N4、N7、N8、N9、N11、N15 是**必须修**的；N5、N6、N10、N12、N13、N14、N17 是**应当修/明确接受**的。

### 10.4 推荐的安全删除协议

#### 10.4.1 核心思想：用 rename 作为提交点

不要在“已 detach、尚未 rm”的窗口里做不可逆清理。更安全的做法是：

1. 先完成预检、停止活动、排空写缓冲；
2. 把整个会话目录 **rename** 到 `sessions` 根之外的隔离区；
3. rename 成功后，canonical 路径已经原子消失，删除在语义上已经提交；
4. 之后再做 detach、关闭 writer、删隔离目录、清缓存/工作区/客户端；
5. 任何后续失败只影响“残留清理”，不会再出现“文件还在、列表已消失”的 torn state；
6. 崩溃后由 journal + 启动清理完成。

隔离区建议：

```text
<DSH_HOME>/.session-deleter-trash/
  <timestamp>-<encoded-id>-<random>/
    session.v4.jsonl.zstd
    session.lock
```

为什么放在 `sessions` 根之外：

- DSH 的 `list()` 会遍历 `<sessions root>/<project>/*` 所有目录；放在 project 下的 `.deleting-...` 仍可能被当成会话目录读取，甚至在崩溃后显示为异常会话；
- 放在 `<DSH_HOME>` 下与 sessions 根通常同一文件系统，`rename` 是原子的；
- 隔离区权限 `0700`，内容与正式会话相同，必须在删除后尽快清空；
- 若 sessions 根在另一个卷（自定义 root），`rename` 可能 `EXDEV`，回退到“先 detach、再原地 rm”的兼容路径，并明确报告竞态风险。

#### 10.4.2 阶段

```text
P0  intent
    持久化 { id, header(createdAt,cwd,isSeeded,parentSession,origin),
             subtreeIds, attachmentIds?, quarantinePath? }

P1  preflight
    - stat(id)/live/subtree/capability/path/header identity
    - 路径优先用 stat(id).location.path（它对 v0–v4 都返回最高代际的绝对路径）；
      只有 legacy/raw-id 目录才需要磁盘 header 扫描，避免固定 ARTIFACT_NAMES 漏 v1
    - 读取 workspace/session-activity 预览
    - 目标子树里有不可读工件 -> 拒绝；无关空目录 -> warning
    - 当前会话若由模型工具发起 -> 拒绝

P2  stop
    - agent.cancel({kind:'disposed'}) + whenIdle()
    - ctx.parallel('workspace/session-stop', {sessionId})
    - 再查 activity；仍有活动 -> 中止，不进入 P3

P3  flush + cache tombstone + media inventory
    - ctx.sessions.flush(session)（live）
    - 在 session_projcache 的 table 上安装生命周期 tombstone
    - secure purge 时：在 rename 前读取完整日志，把 attachmentId 集合写入 intent
      （P6 删除 quarantine 后就无法再提取）

P4  commit: rename
    - rename 前再次 lstat/realpath 验证会话目录（TOCTOU）
    - rename(sessionDir, quarantineDir)
    - fsync 原 project 目录与隔离区父目录
    - 冷会话若取得了 flock/open write 互斥 handle：rename 后 close() 释放锁 FD
    - 失败: 回滚 tombstone；会话仍完整；报告（active schedule 可能已停止）

P5  live teardown（仅热会话）
    - entry.detach()                    // 真实 session/disposed；API 行移除
    - agents.detachEntered(entry)       // agent/disposed；session 已不在 store，避免重加
    - closeSessionWriters(tracker)      // 等待写句柄关闭
    - 失败: 保留 quarantine + intent；报告“数据已移出，注册清理待重试”

P6  delete quarantine
    - rm(quarantineDir, { recursive:true, force:true, maxRetries })
    - fsync 隔离区父目录
    - 失败: 保留 intent 与路径；不阻塞 P7，启动时重试

P7  metadata / cache / client
    - session_projcache table.delete(id)
    - 所有 workspace detachSession(id)
    - unpinSession(id), unarchiveSession(id)
    - schedule: 所有引用该 id 的任务（默认至少 active target）
    - 插件自有 sidecar（本插件不猜旧插件格式）
    - 冷会话发 api-session/removed(id)
    - Client 删除已知 localStorage 键；清 current

P8  media (可选 secure purge)
    - 使用 P3 写入 intent 的 attachmentIds
    - 扫描剩余会话引用
    - 删除无其他引用的对象/引用路径；清 request-image 缓存
    - 删除 provider upload index 中匹配记录
    - 远端 provider 文件不承诺删除

P9  finish
    - P6 已完成且 P8 已完成（或未启用 secure purge）时删除 intent
    - secure purge 延后到启动时：保留 intent.attachmentIds，P9 不能删
```

**启动清理**（在 `sessionPersistence` 可用之后、UI 会话列表首次读取之前）：

- 重放 `pending` intents（先验证 header 身份）；
- 删除隔离区中超过阈值的残留目录与对应 intent；
- 删除 `session_projcache/sessions` 中不在持久化列表里的孤儿记录（含 `.bak.*`）；
- 清理 `pinnedSessionIds` / `archivedSessionIds` 中既不 live 也不 persisted 的 id（用公开 `unpinSession`/`unarchiveSession`；丢弃 id 不会删除会话）；
- 不主动扫描/改写 workspace `sessionIds`：DSH 的 boot reconcile 已负责，且无条件 detach 可能误删 id 复用后的新成员。

关键顺序说明：

- **P3 flush 必须在 P4 rename 之前**：rename 之后 canonical 路径不存在，flush 若还有缓冲事件会失败。
- **P4 rename 必须在 P5 detach 之前**：rename 是提交点；如果 detach 先发生而 rename 失败，就会回到 R1 的 torn state。
- **P5 先 detach session 再 detach agent**：避免 `agent/disposed` 在 session 仍存在时触发 `api-session/added` 的瞬时重加行。
- **P7 全部放在提交点之后**：workspace/pin/archive/cache 失败只是 warning，不会让“文件还在、列表没了”发生；journal 在下次启动重试。
- **P8 放在启动时更安全**：避免 live 会话刚上传但尚未写日志的附件被误删；启动时没有本进程 live Agent，竞态最小。若本次进程要立即执行，必须先确认没有其它 live 会话可能引用同一附件；否则只保留 `intent.attachmentIds`，等下次启动再清理。

**id 复用保护**：P7 之前重新 `stat(id)`。若该 id 已存在且 `header.createdAt` 与 intent 记录不同，说明旧 id 已被新生命周期复用：

- 跳过所有**仅按 id** 的清理：workspace detach、pin/archive、schedule、`api-session/removed`、客户端 current/keys；
- 缓存删除前检查 `table.get(id)?.identity.createdAt`，不匹配则不要 `table.delete(id)`；
- 旧引用留给启动时的 reconcile/孤儿清理，避免误删新会话；
- 记录 warning，提示“旧会话的引用因 id 复用而未清理”。

UUID 复用概率极低，但这是“安全删除”与“快速删除”的边界之一。

#### 10.4.3 冷会话与热会话的差异

| 阶段 | 冷会话 | 热会话 |
|---|---|---|
| P2 stop | 通常无活动；仍可查 activity | 必须 cancel + whenIdle + session-stop |
| P3 flush | 跳过 | 必须 |
| P5 私有 teardown | 不需要 | 需要 `sessions.store`/`entry.detach`、`agents.detachEntered`、`tracker` |
| 失败恢复 | rename 后可完全由启动清理 | rename 后数据已移出；注册清理失败需重启或重试 |
| 私有面缺失 | 可继续（只要路径/缓存可用） | **拒绝**，不要伪造 disposed |

#### 10.4.4 写互斥

- **冷会话不要强制 `open(id,'write')`**：它会读取并验证整个日志；一个损坏会话、超大日志或历史格式都会让“删除”本身失败，而损坏会话恰恰是用户最需要删除的对象。
- 冷删除的首选是 **rename 作为提交点**，可选再用原生 `flock(session.lock)` 做额外互斥（不读日志、不触发迁移）。
- 如果把 `open(id,'write')` 作为兼容路径，只用于“非损坏、v4、可接受整日志读取代价”的冷会话；历史格式会触发迁移发布，禁止使用。
- 热会话已经持有写 handle，不能 `open`；靠 `entry.detach()` + `tracker` 关闭 writer。
- **绝不能在持锁 writer 仍活跃时 unlink `session.lock`**。rename 不 unlink 锁文件，锁随目录移动；这是 rename 方案优于直接 `rm` 的另一个原因。
- 没有 flock 能力时，rename 仍然能阻止“在原 canonical 路径上重新 materialize”；并发 writer 最多把数据写进即将删除的隔离目录，不会让会话复活。

#### 10.4.5 子树的提交顺序

删除顶层会话时，P3–P7 要对子树中的每个会话执行，而不是只对根：

1. `persistence.list()` 取全部 header，按 `origin === 'subagent'` 且 `parentSession` 链构造子树；防环。
2. 先对每个目标安装 cache tombstone、flush；再按 **子先父后** 逐个 rename 到隔离区。
3. 如果某个子 rename 失败：不要再提交父；把已 rename 的子目录尽量 rename 回原位，回滚 tombstone，报告 `remainingSessionIds`。已经 rename 且无法回滚的，保留 journal，由启动清理完成（数据已移出 canonical，语义上是部分删除）。
4. 全部 rename 成功后，再统一做 P5（detach/agent/writer）与 P6/P7。
5. 父会话最后 rename 的理由与既有实现“后代先删”一致：父 catalog 在父日志里，父最后消失可以避免中间态出现“父已删、子还在”的悬空引用。
6. 子树中任一目标存在不可读工件：在 P1 拒绝整次删除，不要先删可读的兄弟再报错。

### 10.5 删除范围：safe / secure / 不可承诺

| 范围 | safe 默认 | secure purge | 说明 |
|---|---|---|---|
| 会话日志目录（含所有代际） | 是 | 是 | 删除整个目录，非只删当前 `session.v4` |
| 投影缓存记录 | 是 | 是 | 域 delete + tombstone；启动孤儿清理 |
| workspace `sessionIds` / pin / archive | 是 | 是 | 公开 API |
| 计划任务 active target | 是（`session-stop`） | 是 | 默认至少停 active；secure 清所有引用 |
| 计划任务 paused/ended/involved | 否，仅 warning | 是 | 需要公开 `schedule.list`/`edit` 或私有域写 |
| 客户端会话 localStorage 键 | 是 | 是 | 精确前缀删除 |
| 仅被该会话引用的附件对象/引用路径 | 否（保守） | 是 | 先扫描剩余会话，避免破坏共享 |
| request-image 缓存 | 否 | 是（整目录清） | 无法按 attachmentId 反查 |
| provider upload index 记录 | 否 | 是 | `files-v3.json` 中匹配 attachmentId 的记录 |
| spill 文件 | 否 | 可选 | 默认 OS 临时目录、`cleanupPeriodDays=30`；若 `ctx.spillStore.root` 可用，可按 `sessionDir(root,id)` 删除 |
| provider 远端文件 / 官方日志副本 | 否 | 否 | 本地无法撤回；必须在 UI/README 声明 |
| OTel/分析/导出/备份 | 否 | 否 | 同上 |
| 工作区文件/项目目录/Git worktree | 否 | 否 | 删除会话不应删除用户文件 |

> 旧版聚合缓存 `storages/session_projcache.json`：0.2.2 默认是 `per-record`，当前安装不存在；若存在，应沿用 REF-IMPLEMENTATION.md 里的 legacy lock + 原子替换逻辑，未知 unit/schema 拒绝修改，不要当作 per-record 目录处理。

**判断：**

- 如果目标是“不破坏任何其它会话”，默认 **safe** 模式是正确答案；附件保留是保守但安全的。
- 如果目标是“本机尽量不留下会话内容”，需要 **secure purge**；但必须接受“shared 附件保留、request-image 整目录清、provider 远端仍在”的取舍。
- 无论哪种模式，都不能承诺“外部副本撤回”。这是产品语义，不是实现缺陷。

### 10.6 非公开函数清单与探针

用户允许非公开函数。建议把它们集中在一个 `compat/` 层，启动时探测，删除时按能力选择路径。

| 符号 | 用途 | 缺失时 | 级别 |
|---|---|---|---|
| `ctx.sessions.store` / `SessionEntry.detach()` | 移除 live session，发真实 `session/disposed` | 热删除拒绝；冷删除不需要 | 热必需 |
| `ctx.agents.store` / `AgentRegistry.detachEntered(entry)` | 移除 live agent，发 `agent/disposed` | 热删除拒绝；不要退化为 `store.delete` 静默不发事件 | 热必需 |
| `persistence.tracker.writers` / `openHandles` | 找到并关闭该会话写句柄 | 热删除拒绝，或接受“rename 后仍留 open handle 到进程退出”（Windows 上可能阻塞删除） | 热推荐 |
| `sessionProjectionCache.requireTable()` 或 `ctx.storageDomain.get('session_projcache').table('sessions')` | 安装 tombstone、`table.delete(id)` | 冷删除可退化为直接删文件 + 启动孤儿清理；热删除拒绝（迟到 put 会写回） | 缓存必需/热必需 |
| `api-session/removed` | 冷会话通知 API 列表移除 | 可退化为客户端 refresh；不要伪造 `session/disposed` | 冷推荐 |
| `workspaceRegistry.list()` + `Workspace.detachSession()` | 清工作区成员 | 无需私有；缺失则 warning + 启动 reconcile | 公开 |
| `workspaceRegistry.unpinSession()` / `unarchiveSession()` | 清 pin/archive | 缺失则 warning | 公开 |
| `ctx.parallel('workspace/session-stop')` | 停 jobs/subagents/schedule | 拒绝热删除；冷会话通常不需要 | 公开 |
| `persistence.locate()` | 定位工件 | 用 `stat.location` 或磁盘 header 扫描替代 | 可选私有 |
| `entity.record` | 绕过 stale `sessionIds` getter | **不需要**：对所有 workspace 调 `detachSession` 即可 | 避免 |
| `workspaceRegistry.stopSessionActivity()` | 停止活动 | 用公开 `ctx.parallel` 替代 | 避免 |
| `persistence.coordinator` | 旧版 retirement 检查 | 0.2.2-rc.3 不存在；删除这段死代码 | 移除 |

补充：

- **未来 vN**：删除不需要解码事件体，只需要 header 的 `id`/`cwd`（或 `stat.location`）来定位目录；不要因为当前 build 不认识新事件类型就拒绝删除整个目录。若 header 本身也无法读取，则失败关闭，不要猜路径。
- **v1 特别提醒**：不要依赖固定 `ARTIFACT_NAMES`；用 `stat.location` 或动态 `session.vN` 匹配。否则 v1-only 会话可能“删除成功”但日志仍在。

实现建议：

- 插件启动时计算并记录 `capabilities`；`/health` 或日志输出。
- 热删除请求进入前先检查热必需能力；缺失返回 `delete-unsupported`（HTTP 503/409），**不停止任何东西**。
- 冷删除只需要路径/缓存/workspace 能力；即使 live 私有面全缺，也应允许冷删除。
- `package.json` 的 peer 版本建议精确锁定 `0.2.2-rc.3`（或至少 `~0.2.2-rc.3`），不要用宽松范围；私有字段一旦改名/变成 `#private`，探针必须失败而不是静默降级。
- 把 `requireTable`/`table.put` 的 monkeypatch 封装在一个文件里，升级时只改这一处。

### 10.7 关键判断与取舍

#### 10.7.1 热会话：删还是拒绝？

- **可以删数据**：使用私有 `entry.detach` + `agents.detachEntered` + writer close，能把日志、缓存、registry 行清掉；UI 行会消失，后续 append 会失败。
- **不能删干净内存**：Agent 的 scoped 工具、监听器、prompt 注册等不会立刻 unwind；直接 dispose `agent.scope`（或 `agent.ctx.fiber`）只撤销注册，不会触发 loop teardown，强行 dispose 反而可能留下不完整状态。它们会留到进程退出。
- **建议**：
  - 默认允许热删除，但在结果/README 中说明“内存资源在进程退出后完全释放”；
  - 如果产品不能接受这一点，热删除返回“需要重启”，冷删除仍可用；
  - 不要为了“立即干净”去调用私有 `agent.scope.dispose()` / `agent.ctx.fiber.dispose()` 或伪造 `agent/disposed`。
  - 理论上 `agent.scope.dispose()`（运行时的 `ReactLoopAgent.scope`）可以提前 unwind 该 Agent 的 scoped 注册，但它由 `AgentLoop` 的 effect 拥有、并会在正式 teardown 时再次 dispose；顺序、所有权以及与 factory 其它 Agent 的相互影响未经验证，不建议在没有专项测试前使用。

#### 10.7.2 当前会话：UI 可删，模型工具不可删

- 标题栏删除当前会话时，删除请求是 Host 的 HTTP 处理，不依赖被删 Agent 的 turn；`cancel({kind:'disposed'})` 会取消该会话的 turn，但 HTTP 请求仍能完成。成功后 Client `clearMain()`/`clear()`，是可行的。
- 如果删除是由模型工具在当前 turn 内发起，`cancel` 会中断发起删除的 turn，可能让删除只完成一半。**不要向模型暴露“删除当前会话”**；工具的删除目标应排除调用方 session。

#### 10.7.3 子会话与 fork

- 删顶层会话：级联删除 `origin === 'subagent'` 的子树，因为父日志的 `subagent/catalog` 不可改写；只删父会留下可诊断但不可移除的引用。
- 只删子会话：允许，但父会话仍保留 catalog 引用（标题/id）；UI 应提示“父会话仍会保留该子会话的引用”。
- fork：`isSeeded` 但 `origin !== 'subagent'` 是独立副本，不自动级联；提示用户“fork/引用副本不随源删除”。
- `session-reference`：内容已复制到引用方日志，删源不影响副本；这是不可撤回的跨会话复制。

#### 10.7.4 计划任务

- `workspace/session-stop` 是删除前停止活动的唯一统一入口；它会删除 active target 任务，这是删除会话应有的副作用。
- 如果 rename 在 stop 之后失败，active 任务已经被删除，无法用公开 API 精确恢复（task id/时间戳可能变）。这是当前设计的已知取舍；报告“活动已停止，但会话未删除”，并允许用户重建任务。
- secure purge 额外删除 paused/ended/involved 任务；默认模式至少列出这些残留，避免用户误以为“全部清空”。

#### 10.7.5 客户端状态

- 删除成功后必须清理：
  - `dsh.conversation.<id>`（先导航离开，避免卸载时重新写草稿）
  - `dsh.sidebar-right.v1.<id>`
  - `dsh.sidebar-browser.v1.<id>`
  - `dsh.user-questions.drafts.v1.<id>`
  - `dsh.schedule.task-tab.v1.<id>`
  - `dsh.sessions.current`（若指向该 id）
  - `dsh.workspace.view.v5` 的 `sessionOrderByAccount` 数组（best-effort）
- 这些键的删除是“用户级删除”；Electron 的 LevelDB 旧段可能保留到 compaction，Chromium HTTP 缓存可能保留图片响应。README 必须说明，不能承诺取证级擦除。

#### 10.7.6 附件与外部副本

- 默认 safe：不删附件。理由：内容寻址共享、实测 3/118 共享、没有删除 API、可能破坏其它会话。
- secure purge：在启动时（无本进程 live Agent）扫描剩余会话，删除无其他引用的对象/引用路径；清 request-image 缓存；清 provider upload index 记录。仍然不能删远端 provider 文件。
- 扫描时只要有一个剩余会话无法读取，就无法证明附件“无其他引用”，此时应**保留媒体**并报告，而不是猜测删除。
- 官方日志副本：当前会话已有 159 条 accepted、`throughSeq=1219`；本地删除不能撤回。必须在确认对话框/README 中写明。

### 10.8 最终判断

1. **可行**：在 DSH `0.2.2-rc.3` 上，做一个“本机安全删除”插件是可行的；冷会话可以做到接近事务性，热会话可以做到数据删除 + 注册脱离。
2. **不要原样复制**：`dsh-session-manager` 的防御性设计值得保留，但必须修 N1/N2/N3/N4/N7/N8/N9/N11/N15；否则会继承 R1/R2/R3/R5/R6/R7/R10/R11 的已知问题。
3. **首选架构**：
   - Host 零/少依赖，`compat/` 集中私有面；
   - `rename` 到 `<DSH_HOME>/.session-deleter-trash` 作为提交点；
   - journal + 启动 orphan/quarantine 清理；
   - 冷会话不依赖 live 私有面；
   - 热会话私有面缺失则拒绝，不伪造事件；
   - 默认 safe，secure purge 可选；
   - 客户端精确清理会话级 localStorage。
4. **可接受的残余风险**（需写进 README/UI）：
   - 私有 API 与 DSH 版本强耦合；升级后探针失败会拒绝热删除；
   - 热删除的 Agent scoped 资源留到进程退出；
   - provider/OTel/导出/备份副本不可撤回；
   - 默认附件保留；shared 附件即使 secure purge 也必须保留；
   - Electron LevelDB / HTTP 缓存不做取证级擦除；
   - 计划任务在 stop 后、rename 失败时可能已丢失 active 任务；
   - 跨进程缓存写回：tombstone 只在本进程；另一个 DSH 进程的 `coldSnapshot` 仍可能写回缓存。启动孤儿清理兜底；多进程共享 sessions root 时应加跨进程锁或只允许一个删除者。
5. **不推荐的实现**：
   - `rm -rf` 直接删会话目录（不处理锁、缓存、workspace、客户端）；
   - 无 live entry 时伪造 `session/disposed`；
   - 依赖 `?.` 在私有字段缺失时静默“成功”；
   - 全局扫描要求 `complete=true`，让一个空目录阻塞所有删除；
   - 不扫描引用就按会话删附件；
   - 为了“删干净”调用 `agent.scope.dispose()` / `agent.ctx.fiber.dispose()` 或伪造 `agent/disposed`。

### 10.9 对参考实现调查第 10 节决策点的补充建议

> 新 `FEASIBILITY@0.2.2-rc.3.md` 第 8 节已把这些决策收敛为 7 组；本节保留为推导过程。

| 决策点 | 建议 |
|---|---|
| 首期 UI 范围 | 单条删除 + 标题栏/侧栏入口；批量二期。 |
| 与 `dsh-session-manager` 共存 | 默认双入口 + 文档说明；不要劫持旧插件 id。 |
| 回收站/撤销 | 不面向用户提供回收站；`rename` 隔离区只是内部提交点，删除后立即清空，不保留 N 天。 |
| 配置项 | 首期不做配置；secure purge 可作为后续显式选项。 |
| 私有面缺失 | 插件可加载，冷删除可用；热删除返回 `delete-unsupported`；不要静默降级。 |
| 许可证 | 必须保留 MIT 归属；删除核心源自 `dsh-session-manager` 0.7.8。 |

---

## 11. 结论

- 会话生成链路的证据表明：删除不是“删一个文件”，而是“日志目录 + 锁 + 投影缓存 + 工作区/计划引用 + 客户端状态 + 可选媒体”的多工件清理。
- 既有 `dsh-session-manager` 的实现是当前版本上最接近正确的基线；它的 ID/路径/header 防护、活动停止、writer 关闭、cache tombstone 都应保留。
- 真正的安全增益来自三件事：**用 rename 作为提交点**、**用 journal 做可重入清理**、**对私有面做能力探测并失败关闭**。
- 没有这三件事，删除仍然会在失败时产生“列表消失、文件残留”或“删除成功、缓存复活”的状态。
- “彻底删除”只能承诺本机 DSH 存储；provider/OTel/导出/备份/工作区文件不在删除范围，必须在产品语义中明确。
