# 0.2.2-rc.5 兼容性复核

## 2026-11-18 私有面复核与 peer 范围修复

### 目的与范围

DSH 从 `0.2.2-rc.3` 更新到 `0.2.2-rc.5` 后，插件未被加载。本轮目标不是增加删除功能，而是：

1. 静态核对插件在 rc.3 中依赖的未公开（非公开 Host 服务字段/方法）在 rc.5 是否仍然存在、签名与语义是否仍兼容；
2. 修复导致插件被启动器整体跳过的版本声明；
3. 在 rc.5 运行时中验证 Host API、热会话删除与 Client bundle 注册；
4. 将结论与验证证据记入本文件。

范围仅限 `package.json` 的版本/peer 范围、`README.md` 的版本契约与本文件；不改变删除语义、HTTP 接口、journal/隔离区格式或存储布局。

### 可行性

#### 1. 未加载的直接原因

`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()` 在加载 profile 时读取 bundle 的 `engines.dsh`（若存在）或 `peerDependencies` 中的 `@deepseek-ai/dsh*`，再用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判断。

插件原先声明：

```json
"peerDependencies": { "@deepseek-ai/dsh": "0.2.2-rc.3" }
```

`0.2.2-rc.5` 不满足该精确范围，`loadProfileDirectory()` 将 bundle 放入 `skippedBundles` 并禁用其所有 Loader 行；因此不是插件运行时报错，而是整层未挂载。隔离环境中执行安装时也复现了同样的拒绝：

```text
@local/dsh-session-deleater@0.1.2 is incompatible with dsh 0.2.2-rc.5:
requirements {"@deepseek-ai/dsh":"0.2.2-rc.3"}
```

#### 2. 未公开 Host 面逐项复核

以下结论来自对 rc.5 安装包（`app.asar/dsh/node_modules/@deepseek-ai/**`）中 `src` 与 `lib` 的实际阅读，不是仅凭旧文档推断：

| 插件使用的符号 | rc.5 状态 | 依据（rc.5 源码/运行时） |
|---|---|---|
| `ctx.sessions.get(id)`、`list()`、`flush(session)` | 可用，签名未变 | `@deepseek-ai/dsh-session` 的 `SessionStore.get/list/flush`；`flush` 仍以 `liveEntryFor()` 校验 live 会话 |
| `ctx.sessions.store` / `entry.detach()` | 可用 | `SessionStore.store` 仍是运行时 `Map`；`enter()` 构造的 entry 仍暴露 `detach` |
| `ctx.agents.store` / `AgentRegistry.detachEntered(entry)` | 可用 | `@deepseek-ai/dsh-agent` 的 `AgentRegistry.store` 与 `detachEntered` 仍在；TS `private` 仍编译为普通属性/方法 |
| `agent.status`、`cancel({ kind: 'disposed' })`、`whenIdle()` | 可用 | `AgentHandle` 仍声明并实现这三个成员；`'disposed'` 仍在 `AgentCancelCause` 联合中 |
| `sessionPersistence.stat(id)`、`list()` | 可用，返回结构兼容 | JSONL 后端仍返回 `{ header, revision, location: { kind: 'jsonl', path } }` |
| `persistence.tracker.writers` / `openHandles` / `handle.close()` | 可用 | `JsonlBackendTracker` 仍以 `private writers = new Map()` 和 `readonly openHandles = new Set()` 实现；writer 仍是 `SessionHandle`，`close()` 契约未变 |
| `sessionProjectionCache.requireTable()` / `table.get/put/delete` | 可用 | `SessionProjectionCache.requireTable()` 仍存在；表仍是 `session_projcache` 的 `sessions` KvTable |
| `sessionProjectionCache.cachedSnapshot(header)` | 可用，返回 `{ asOfSeq, values }` | rc.5 签名是 `cachedSnapshot(meta, keys?)`；省略 `keys` 仍返回全部可见值 |
| `storageDomain.get('session_projcache').table('sessions')` | 可用 | `DomainFacility.get(name)` 与 `Domain.table(name)` 仍在 |
| `workspaceRegistry.list()`、`detachSession`、`unpinSession`、`unarchiveSession`、`pinnedSessionIds`、`archivedSessionIds` | 可用 | `@deepseek-ai/dsh-workspace` 的 `WorkspaceRegistry` 与 `Workspace.detachSession` 均保留 |
| `schedule.catalog()`、`edit({ id, action: 'delete' })` | 可用 | `@deepseek-ai/dsh-schedule` 仍提供 `catalog()` 与支持 `delete` 的 `edit()` |
| `spillStore.root` | 可用 | `LocalSpillStore` 仍在构造时设置 `this.root`；隔离实例 health 中 `spill: true` |
| `ctx.waterfall('workspace/session-activity')`、`ctx.parallel('workspace/session-stop')` | 可用 | `@deepseek-ai/dsh-workspace` 仍在删除流程中调用同一对事件；provider 侧事件声明未变 |
| `ctx.emit('api-session/removed', id)` | 可用 | `@deepseek-ai/dsh-api-session-controller` 仍声明并发出该事件 |
| `ctx.connection.admit(req)` | 可用 | `HostConnectionService.admit()` 仍返回 `{ peer }` 或 `{ rejection }`；另有 `admitConnection()` 用于物理 socket，不影响本插件 |
| `ctx.webServer.register({ kind: 'prefix', path, handler })` | 可用 | `@deepseek-ai/dsh-host-webserver` 的 `WebRoute` 仍为 `exact`/`prefix`，`register()` 契约未变 |

结论：**没有任何一个插件使用的未公开方法在 rc.5 中消失或需要改签名。** 关键变化只是 `store`、`writers`、`requireTable` 等在 TypeScript 中继续标记为 `private`，运行时仍以普通属性/方法存在；插件原有的能力探测和缺失时失败关闭策略仍然适用。

#### 3. Client 公开面复核

- `shell.overlay`、`conversation.session.header.actions`、`sidebar.workspaces.session.menu.item` 三个 slot 名称在 rc.5 中均仍存在；前两者为 `list`，菜单项为 `list`。
- 菜单项仍提供 `useMenuOpenState`；`useSessionStatus` 与 `useWorkspaces` 仍是 rc.5 的 global standard props，因此插件的可选调用方式仍成立。
- `uiWorkspace.openSession/connectWorkspace/startSession` 仍存在；`openSession` 仍接受字符串 `SessionId`。

### 核心进路

1. 将精确版本改为同一 minor 的范围：

   ```json
   "peerDependencies": { "@deepseek-ai/dsh": "~0.2.2-rc.3" }
   ```

   `~0.2.2-rc.3` 允许 `0.2.2-rc.5` 等同一 minor 的 rc/patch 升级，同时仍把 `0.2.3+` 拦在门外，避免跨 minor 私有面变化被静默接受。

2. 插件版本从 `0.1.2` 升至 `0.1.3`（兼容契约变化）。
3. `README.md` 的 Harness 版本声明更新为 `0.2.2-rc.5`，并说明 peer 范围与跨 minor 复核要求。
4. 不修改 `index.js`、`client.js`、`lib/` 或测试；本轮静态结论是私有面完全可用，因此没有需要适配的代码。

### 问题与解决办法

- **问题：精确 peer 版本导致启动器整层跳过。**  
  **解决：** 改为 `~0.2.2-rc.3`。  
  **验证：** 修复前隔离环境安装被 `incompatible-version` 拒绝；修复后同一命令成功，`dsh --profile rt --dump-config` 中出现 `id: dsh-session-deleater` 层。

- **问题：当前正在运行的 Desktop 进程不会热加载 Host 插件。**  
  **解决：** 本轮不重启用户的 DSH；用 `DSH_HOME=/tmp/dsh-rt` 的隔离 rc.5 实例完成运行时验证。当前 GUI 仍需用户重启后才会挂载新 peer 范围与插件；隔离实例不接触用户真实 `~/.dsh` 会话。

- **问题：`persistence.tracker.writers`、`agents.store`、`requireTable` 仍是 TS `private`。**  
  **解决：** 不改为依赖新的公开 API；继续通过 existing-or-undefined 能力探测使用，并在缺失时让热删除返回 `delete-unsupported`。rc.5 运行时探针确认这些字段存在。

- **残留风险：** `~0.2.2-rc.3` 对新 rc 仍自动放行，若后续 rc 改变私有面语义而不改字段名，静态存在性检查不会发现。跨 minor 升级仍必须重新执行本复核；热删除的关键行为在每次升级后应至少复跑一次 health/预览/删除。

### 运行时验证

在隔离 profile（`DSH_HOME=/tmp/dsh-rt`，rc.5）中执行，未触碰真实用户会话：

1. **加载与能力探针**  
   `GET /session-deleater/api/health` 返回 200：

   ```json
   {"ok":true,"result":{"ok":true,"version":"0.1.0","capabilities":{"sessionsStore":true,"agentsStore":true,"agentsDetach":true,"persistenceTracker":true,"cacheTable":true,"cacheTombstone":true,"workspace":true,"schedule":true,"spill":true},"hotReady":true,"home":"/tmp/dsh-rt","api":"/session-deleater/api"}}
   ```

   9 项能力全部为 `true`，包括本任务重点核对的 `sessionsStore`、`agentsStore`、`agentsDetach`、`persistenceTracker`、`cacheTable`。

2. **创建并预览 live 会话**  
   通过 rc.5 `POST /api/session/create` 建立 `session-9e46282c-...`；`GET /session-deleater/api/preview?sessionId=...` 返回 `live: true`、`canDelete: true`、`hotReady: true`、`activity: []`。

3. **热删除**  
   `POST /session-deleater/api/delete` 使用 `media: "keep"` 返回：

   ```json
   {"ok":true,"result":{"deleted":true,"filesRemoved":true,"wasLive":true,"deletedSubagents":[],"subagentCount":0,"remainingSessionIds":[],"warnings":[],"partialFailure":false,"mediaPending":false,"quarantinePath":"/tmp/dsh-rt/.session-deleter-trash/..."}}
   ```

   删除后会话日志目录、`session_projcache` 对应记录与隔离目录中的实际目录均不存在；返回无 warning，说明 `entry.detach()`、`agents.detachEntered()`、writer close、cache table delete 全部按预期完成。

4. **幂等**  
   对同一 id 再次删除返回 `{"deleted":false,"filesRemoved":false,...}`，未报错。

5. **Client bundle**  
   rc.5 启动页的 boot manifest 包含：

   ```json
   {"id":"@local/dsh-session-deleater","url":"plugins/??@local/dsh-session-deleater/client.js...","inject":["@deepseek-ai/dsh-client-ui-slots"],"immediately":true}
   ```

   该 `client.js` 路由返回 200；用 VM 模拟 `window.__ModuleLoader__` 与 slots 上下文执行 `client.js`，成功注册 `shell.overlay`、`conversation.session.header.actions`、`sidebar.workspaces.session.menu.item` 三个 slot（id 分别为 `session-deleater-overlay`、`session-deleater-header`、`session-deleater-menu`）。

6. **构建与既有测试**  
   `npm run build` 全项通过（含 `verify` 与 `npm test`）；Host 探针通过，未新增依赖或构建脚本改动。

**结论：** 静态复核显示 rc.5 仍保留插件使用的全部未公开方法，运行时隔离验证中的加载、能力探针、live 预览、热删除、幂等删除与 Client slot 注册均正常。当前版本兼容性修复成立；当前 Desktop 进程重启后即可加载。
