# 会话删除（dsh-session-deleater）

最后实质性修改于Harness版本：0.2.2-rc.5

在会话区域标题栏与会话行“更多”菜单中提供删除入口；删除本机 DSH 存储中的会话日志、投影缓存、工作区引用和客户端会话状态，并可选清理仅属于该会话的媒体。

## 使用与效果

- **标题栏**：打开会话后，标题右侧出现删除按钮。
- **侧边栏**：会话行右侧“更多”菜单中出现“删除会话”。
- 第一次删除会先请求预览：显示子会话数量、运行状态、计划任务引用，并始终提示“不撤回 provider/备份副本”。
- 默认 safe 模式保留附件与外部副本，也只停止正在运行的计划任务；勾选“同时清理仅属于该会话的附件”后，会一并删除所有引用该会话的计划任务（含暂停/结束/关联任务），并在确认没有 live 会话时立即清理媒体，否则留到下次启动。共享附件始终保留。
- 删除顶层会话会级联删除 `origin=subagent` 的子会话；普通 fork 和 `session-reference` 副本不会被自动删除。
- 当前会话可以从标题栏删除；删除成功后自动打开**同一工作区中最近更新的其他会话**；若没有，则在该工作区新建/复用空白会话。若当前打开的是被级联删除的子会话，也会一并离开；自动导航失败时保留完成提示，可从侧边栏手动选择。该能力不暴露给模型工具。

## 工作原理

删除不是一次 `rm -rf`：

1. 预检会话身份、子会话树、路径、活动状态和所需能力；
2. 停止 turn/jobs/subagents/计划任务；
3. 安装投影缓存的生命周期 tombstone，阻止 `session/disposed` 后的迟到写回；
4. 持久化删除意图（journal），把会话目录 `rename` 到 `~/.dsh/.session-deleter-trash/`；rename 是提交点；
5. live 会话才使用非公开的 `sessions.store`/`entry.detach` 与 `agents.detachEntered` 脱离注册，并关闭写句柄；
6. 删除隔离目录，清理缓存、工作区、pin/archive、计划任务和客户端 localStorage；
7. 启动时重放未完成的 journal，并清理孤儿缓存、隔离目录和悬空 pin/archive；
8. 进程崩溃或部分失败不会产生“文件还在、列表已消失”：canonical 路径在 rename 时已消失，残留由隔离区和 journal 收尾。

投影缓存、附件和 provider 上传索引的位置与引用规则见 `TRACE.md` 与 `FEASIBILITY@0.2.2-rc.3.md`。

## 依赖与构建

- 零 npm 运行时依赖；Host 只使用 Node 内置模块。
- Host 需要 DSH 的 `webServer`、`connection`、`sessionPersistence`；live 删除还需要 `sessions`/`agents`/`sessionProjectionCache` 的非公开面。
- Client 使用公开 slot：`conversation.session.header.actions` 与 `sidebar.workspaces.session.menu.item`；删除当前会话后的落点使用公开 `uiWorkspace` 导航（`openSession` / `connectWorkspace` / `startSession`），不调用私有 `clearMain`。

```bash
npm run build
npm run verify
npm test
```

`build` 会物化依赖并自动运行 `verify`；本插件没有 `dependencies`，因此不会创建 `node_modules/`。构建系统由工作区 `build-system/` 同步而来，共享文件按逐字节校验，不要手改 `scripts/`。

## 适用范围与边界

- **只删除本机 DSH 存储**：`~/.dsh/sessions`、`~/.dsh/storages/session_projcache`、工作区/计划任务引用、客户端 localStorage。
- **不删除**：会话 cwd 下的工作区文件、项目目录、Git worktree；已发送给模型 provider 的官方 `dsh_session_log` 副本；provider Files API 远端文件；OTel/分析/导出/备份；Time Machine/APFS 快照。
- **热会话**：日志与缓存会删除，但 Agent 的 scoped 资源留到进程退出；关键非公开能力缺失时拒绝热删除（返回 503），冷删除仍可用。
- **媒体**：默认保留；`secure purge` 在没有 live 会话时立即执行，否则下次启动执行；只要有一个剩余会话无法读取，就保留媒体并报告。
- **多进程**：cache tombstone 只在本进程；共享 sessions root 的多进程部署需要额外协调，启动孤儿清理只能兜底。
- **Windows**：`rename` 可能因打开句柄失败，回退到先 teardown 再原地删除；删除重试由 `fs.rm` 处理。

## 故障排查

| 症状                              | 处理                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| 标题栏/菜单没有删除入口           | 确认 bundle 已启用并刷新页面；检查 `dsh.client` 与 slot 注册。                                   |
| 提示“当前 DSH 版本缺少热删除能力” | 使用冷会话删除，或重启 DSH 后重试；不要伪造事件。                                                |
| 删除后仍看到会话行                | 刷新会话/工作区列表；热会话注册清理失败时，重启 DSH 让 journal 收尾。                            |
| 删除当前会话后仍停留在旧内容      | 确认 Client bundle 已更新并刷新/重启；若对话框提示“自动打开其他会话失败”，从侧边栏手动选择。     |
| 附件仍在                          | 默认 safe 保留附件；勾选 secure purge 时无 live 会话会立即清理，否则下次启动；共享附件不会删除。 |
| 提示仍有活动任务                  | 先停止运行中的 turn/job/提醒；删除不会强行绕过无法停止的工作。                                   |
| provider 仍保留内容               | 本地删除无法撤回；README/对话框已明确说明。                                                      |

## 版本契约

- 插件版本：`0.1.3`；行为、接口或删除范围变化时提升版本。
- 目标 DSH：`0.2.2-rc.5`；`peerDependencies` 使用 `~0.2.2-rc.3`，允许同一 minor 的 rc/patch 升级，跨 minor 升级仍需重新核对私有面。升级后先运行 `npm run verify`，并检查 `/session-deleater/api/health` 的能力探针。
- 私有面缺失时：插件仍可加载；冷删除尽量可用；热删除返回 `delete-unsupported`，不静默降级。
- 本插件的删除语义是“本机安全删除”，不是“provider/备份级彻底删除”。

## 命名与文件

包名 `@local/dsh-session-deleater`，Loader entry id `dsh-session-deleater`。Host 入口 `index.js`，Client 入口 `client.js`，删除核心在 `lib/`。`REF-IMPLEMENTATION.md` 是参考实现调查记录；`FEASIBILITY@0.2.2-rc.3.md` 是实施契约；`FEASIBILITY@0.2.2-rc.5.md` 是当前版本的兼容性复核记录；`TRACE.md` 是会话存储追踪与安全判断。

---

## 许可证

MIT License，详见 [LICENSE](./LICENSE)。
