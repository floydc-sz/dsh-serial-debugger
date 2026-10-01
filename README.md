# dsh-serial-debugger

DeepSeek Harness 串口调试插件。在 DSH 界面内提供一个完整的串口监视/调试面板：**串口参数设置**、**实时接收并显示数据**、**发送数据**。

A serial-port debugger plugin for DeepSeek Harness: port parameter setup, live receive display, and data transmission — inside the DSH UI.

---

## 功能

界面按经典串口助手（参考 XCOM／正点原子串口调试助手）的布局组织，自上而下分三段：

```
┌─ 参数区 ──────────────────────────────────────────┐
│ 串口选择 [COM3:USB-SERIAL CH340] [刷新]              │
│ 波特率 [115200]      停止位 [1]                     │
│ 数据位 [8]           校验位 [None]                  │
│ 串口操作 [打开串口] [保存窗口] [清除接收]             │
│ □16进制显示 □DTR □RTS □自动滚动 □时间戳             │
├─ 接收区（占满剩余高度）────────────────────────────┤
│  …实时数据…                                        │
│  ● COM3·115200·8N1  接收 0 B  发送 0 B  0 条        │
├─ 发送区 ──────────────────────────────────────────┤
│ [单条发送][帮助]                                    │
│ ┌────────────────────┐ [ 发送 ]                    │
│ │   发送输入框        │ [清除发送]                  │
│ └────────────────────┘                             │
│ □定时发送 周期[1000]ms [打开文件][发送文件][停止发送] │
│ □16进制发送 □发送新行 [████░░░░] 0%                │
└───────────────────────────────────────────────────┘
```

四个串口参数排成**两行两列**——「波特率 + 停止位」一行，「数据位 + 校验位」一行。**每个名称都与其控件在同一行**（标签在左、控件在右）；两列等宽（`flex: 1 1 0`）且不换行，因此列变窄时两列一起收缩，不会拆行，两行的控件也始终对齐成一列网格。

| 区域 | 能力 |
| --- | --- |
| 上方·参数区 | 「串口选择」下拉（显示 `COM3:USB-SERIAL CH340` 形式的**设备描述**，可用「刷新」重新枚举，无可用串口时自动降级为手输框）、「波特率」「停止位」「数据位」「校验位」下拉、「串口操作」按钮（打开/关闭串口，连接后参数锁定） |
| 上方·操作与开关 | 「保存窗口」（把接收区导出为 .txt）、「清除接收」、「16进制显示」、「DTR」、「RTS」、「自动滚动」、「时间戳」 |
| 中间·接收区 | 占满剩余高度，实时追加显示，文本或十六进制视图、可选时间戳、自动滚动（手动上滚时自动暂停）；发送内容以 `→` 前缀弱化显示；底部状态行显示连接指示、当前参数、收发字节数与条数 |
| 下方·发送区 | 「单条发送」/「帮助」标签页；发送输入框（`Ctrl+Enter` 发送）与「发送」「清除发送」 |
| 下方·发送选项 | 「定时发送」＋「周期」毫秒、「打开文件」「发送文件」「停止发送」（1 KB 分块发送并显示进度百分比）、「16进制发送」（`AA 55 01`、`0xAA,0x55` 均可）、「发送新行」（追加 CRLF） |

各段内部自行换行，因此在狭窄的右侧边栏与宽面板中都不需要测量宽度即可自适应。颜色与字体取自 DSH 主题 token（`--dsw-alias-*`），因此明暗主题都跟随宿主；尺寸与排布则对齐上述参考界面的紧凑密度。

## 界面位置

插件的界面只有一处：**Harness 主界面的右侧边栏**，以原生标签页的形式存在。

1. 点标题栏的「打开侧边栏」打开右侧边栏；
2. 右侧边栏的引导页（空状态）列出可打开的标签类型，其中一行是 **「串口调试」**；
3. 点这一行，串口调试界面就在右栏内打开（标签上显示「串口调试」）。

注册的 slot 只有两个：`sidebar.right.pane.tab`（标签内容，渲染调试面板）与 `sidebar.right.pane.tab.title`（标签标题）。没有左侧栏入口，也没有设置页——同一件仪器放两处只会让人猜哪个才是真的。

实现上不是往某个 slot 塞一个按钮，而是注册一个**原生标签类型**：通过 `ctx.inject(['sidebarRightTabs'])` 拿到标签类型注册表，用 `register({ id, kind, title, guide })` 声明类型，`guide` 里的条目就是引导页上那一行；再按同一个 id 注册上面那两个 slot。

> **顺序陷阱**：原生座位会先声明 `sidebar.right.pane.tab` 槽、之后才提供 `sidebarRightTabs` 服务。因此若用 `ctx.slots.inject('sidebar.right.pane.tab', ...)` 触发注册，回调里读到的服务是 `undefined`，而且该声明永不塌缩 —— 结果是**永远静默地什么都不注册**。必须等**服务**（`ctx.inject(['sidebarRightTabs'], ...)`），这也是服务出现/被替换时会自动重跑的生命周期。

---

## 安装

插件是普通的 DSH 包：宿主半边为 ESM 模块，客户端半边是预构建的浏览器 bundle（本包手写于 module-system 的 lazy-CJS 工厂格式，**无需任何构建步骤**）。

### 方式一：安装为 bundle（推荐，与其它第三方插件一致）

```powershell
dsh plugin --profile desktop add <本包路径>
```

### 方式二：手动放置（无需 pnpm）

1. 把整个目录复制到 profile 的 `node_modules` 下：

   ```powershell
   Copy-Item -Recurse -Force "<本包路径>" "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-serial-debugger"
   ```

2. 在 profile 的用户补丁层 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加一行 insert：

   ```yaml
   - insert:
       - id: serial-debugger
         name: dsh-serial-debugger
   ```

3. 重载 DSH（或让 HMR 生效）。侧边栏会出现「串口调试」入口。

### 依赖要求

- **Windows**：串口桥使用 .NET 的 `System.IO.Ports`，在 Windows PowerShell 5.1 与 PowerShell 7 上均可用（随系统自带，无需安装）。
- 不依赖任何 npm 包，也不需要原生编译（不安装 `serialport` 之类的原生扩展）。
- 默认使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`；可用环境变量 `DSH_SERIAL_POWERSHELL` 指向 `pwsh.exe` 覆盖。
- 可用环境变量 `DSH_SERIAL_HELPER` 指向另一个串口桥脚本（同样的 NDJSON 协议），用于替换 `System.IO.Ports` 实现或注入测试替身。

---

## 架构

```
┌─ 浏览器（客户端半边 lib/client.js）────────────────────────────┐
│  main 面板 + sidebar.panellist 入口                            │
│  每 250ms GET /dsh-serial-debugger/state?since=<seq>           │
└───────────────────────────┬────────────────────────────────────┘
                            │ 同源 HTTP（JSON）
┌───────────────────────────▼────────────────────────────────────┐
│  宿主半边 lib/index.js（Node）                                  │
│  · 用 ctx.webServer.register 注册一个 prefix 路由               │
│  · 维护有界的收/发日志（单调 seq，支持增量读取）                 │
│  · 惰性拉起并管理串口桥子进程                                   │
└───────────────────────────┬────────────────────────────────────┘
                            │ stdin/stdout 上的 NDJSON
┌───────────────────────────▼────────────────────────────────────┐
│  lib/serial-helper.ps1（常驻 Windows PowerShell）               │
│  System.IO.Ports.SerialPort：开/关/写/读，单 runspace 轮询       │
└────────────────────────────────────────────────────────────────┘
```

### 为什么用 PowerShell 子进程而不是原生模块

Node 在 Windows 上无法在不使用原生扩展的情况下设置波特率、校验位等串口参数（`fs` 可以打开 `\\.\COM3`，但 `SetCommState` 必须走原生代码）。而 .NET 的 `System.IO.Ports` 随 Windows 自带，因此用一个常驻的 PowerShell 子进程持有串口，既拿到了完整的参数控制能力，又让插件保持**零 npm 依赖、零原生编译、零构建步骤**。

子进程**惰性启动**（首次访问时），因为 PowerShell 解释器启动约需 2 秒；未就绪时面板会给出提示。

### 宿主 HTTP 接口

路由前缀 `/dsh-serial-debugger`（`kind: 'prefix'`，由本插件拥有，因此不受 DSH `/api` 的令牌策略约束）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state?since=<seq>` | 状态 + 增量日志。`since=-1`（或不传）返回当前尾部 |
| GET | `/ports` | 枚举系统串口 |
| POST | `/open` | `{port,baudRate,dataBits,parity,stopBits,dtr,rts}`（另接受 `handshake`，面板未暴露，缺省 `None`） |
| POST | `/close` | 关闭串口 |
| POST | `/send` | `{base64,label}`（编码在客户端完成） |
| POST | `/clear` | 清空日志 |

响应统一为 JSON，`{ ok: true, ... }` 或 `{ ok: false, error }`；即使业务失败也返回 HTTP 200，便于面板直接展示错误文案。

### 串口桥协议（NDJSON）

- 命令：`{"op":"open"|"close"|"write"|"list"|"ping"|"shutdown", ...}`
- 事件：`{"type":"ready"|"ports"|"opened"|"closed"|"data"|"written"|"error"|"bye", ...}`

子进程在 stdin 关闭（宿主消失）时自动退出并释放串口。

---

## 验证

四套测试全部不依赖串口硬件：

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-tests.ps1
```

| 套件 | 覆盖 | 项数 |
| --- | --- | --- |
| `test-helper.mjs` | 串口桥 NDJSON 协议：ready/ports/ping/open 失败/write 失败/未知 op/坏 JSON 容错/shutdown 退出 | 9 |
| `test-host.mjs` | 宿主半边 + 真实 `node:http`：路由注册、state/ports/send/close/clear、参数边界与端口名校验、日志游标、404 | 18 |
| `test-client.mjs` | 客户端 bundle：module loader 协议、slot 注册、文本/HEX 编码器、渲染树、侧栏图标 | 35 |
| `test-loopback.mjs` | **完整数据通路**：用回环测试替身（`tools/fake-serial-bridge.ps1`）跑通 打开 → 接收 → 增量读取 → 发送 → TX 记录 → 回环接收 → 二进制往返 → 关闭 → 清空 | 17 |

合计 **79 项**。已在本机对运行中的 DSH 实例验证：宿主路由 `GET /dsh-serial-debugger/state` 返回 200 并成功拉起串口桥（返回真实 PID），客户端半边在两个 slot 中均为 `active: true`。

`tools/`（测试、安装脚本、`asar.js` 归档只读工具）与 `ref/` 均为开发期资料，不参与运行时；`package.json` 的 `files` 已把 `tools/`、`ref/` 排除在发布内容之外。

### 未覆盖的部分

本机没有可用的物理或虚拟串口（`GetPortNames()` 返回空），因此 `System.IO.Ports.SerialPort` 的真实读写**未在硬件上验证**：`Read`/`Write` 的具体行为依赖驱动，测试替身覆盖的是其上下游的全部自有代码。首次接入真实设备时建议先用回环（短接 TX/RX）确认。

---

## 发布到 dshmarket

dshmarket（DSH 内置的可视化插件市场）**不接收插件投稿**——它的列表来自精选目录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。所以「上架」= 往那个仓库提一个 PR，站点与市场会自动收录（通常一天内生效）。

### 一、先把仓库准备好（一次性）

| 要求 | 本包状态 |
| --- | --- |
| `package.json` 声明 **`dsh.bundle`** | ✅ `dsh.bundle.patch`（这是最常见的被拒原因：只声明 `dsh.client` 无法安装） |
| 有 `cordis.patch.yml` 且随包发布 | ✅ 在 `files` 里 |
| 真实可用的代码，非占位/纯 README | ✅ |
| 仓库创建满 **1 天**（CI 自动检查） | ⚠️ 取决于你的仓库 |
| 仓库加 **`dsh-plugin`** topic | ⚠️ 需要在 GitHub 仓库设置里添加（`keywords` 里的 `dsh-plugin` 不能代替） |
| 官方 `@deepseek-ai/*` 包用 `peerDependencies`，不用 `dependencies` | ✅ 运行时零 npm 依赖（宿主半边只用 Node 内建，客户端半边只用平台表里的 React） |
| 版本号 | ✅ `1.0.0` |

还需要你补两项（我不知道你的账号信息，没有替你编造）：

1. **`repository`** —— 必须指回被收录的那个仓库。发到 npm 时，市场靠它把 npm 包与目录条目关联起来；字段缺失或写错，两者不会关联（下载量等就取不到）。
   ```json
   "repository": { "type": "git", "url": "git+https://github.com/<owner>/<repo>.git" },
   "homepage": "https://github.com/<owner>/<repo>#readme",
   "bugs": { "url": "https://github.com/<owner>/<repo>/issues" }
   ```
2. **`LICENSE` 的版权行** —— 现在是占位符 `<YOUR NAME OR ORGANISATION>`，改成你的署名。

**DSH 版本要求**已经声明在 `dsh.engines.dsh` 里（市场从 `engines.dsh` 或 `dsh.engines.dsh` 读取，前者优先）：

```json
"engines": { "dsh": "^0.2.0-rc.1" }
```

这里刻意只写了我**实测过的那条发行线**（本机为 DSH 0.2.0-rc.2）。注意 node-semver 的预发布规则：范围里必须有一个比较符落在同 `major.minor.patch` 元组上并自带预发布标签，否则会**静默排除**所有预发布构建——`^0.2.0-rc.1` 满足，而 `>=0.0.1 <0.3.0` 之类不满足。若你也在 0.1.x 上验证过，可扩成 `^0.1.6 || ^0.2.0-rc.1` 形式。

### 二、提 PR 收录（一次性）

在 `awesome-dsh-plugin` 仓库里**新增一个文件** `data/plugins/<owner>__<repo>.yml`（一个插件一个文件，所以不会和别人冲突）：

```yaml
url: https://github.com/<owner>/<repo>
name: <owner>/<repo>
category: tools
description:
  en: Windows serial-port monitor for DeepSeek Harness — port parameters, live text/hex receive and data sending.
  zh: DeepSeek Harness 的 Windows 串口调试面板：串口参数设置、文本/十六进制实时接收显示与数据发送。
```

- `category` 取 `tools`（可用值：`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl` `browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev` `security` `remote` `market` `fun`）。分类选得不贴切不会被打回，维护者会直接改。
- 只有 `description.en` 必填；描述含 `: `（冒号加空格）时必须加引号。
- **描述必须属实**——评审会对着代码核对，夸大是被退回的主要原因。所以别写「支持多条发送／协议传输」这类本插件没有的能力。
- 一个 PR 最多 3 条。
- 仓库根放 `screenshots.json`（1–8 张图，相对路径）可让市场详情页按你的顺序展示截图；不写就从 README 里自动抽取。

### 三、发到 npm（推荐，非必需）

收录不依赖 npm，但发了 npm 之后：市场能显示并按下载量排序，预构建安装还能跳过 `allowBuilds` 构建授权。

```powershell
cd <本包目录>
npm publish            # package.json 已设 publishConfig.access = public
```

若不发 npm，也可以把预构建 tarball 挂到 GitHub Release，并在条目里加可选的 `tarball:` 字段指向它。

### 四、后续更新

**版本更新不需要再提 PR。** 市场逐个插件检测更新：npm 版本号，或锁定的 commit 与 HEAD 对比。所以发新版只要：

1. 改 `package.json` 的 `version`（例如 `1.1.0`）——npm 不允许重发同一版本号；
2. 推到 GitHub，需要的话 `npm publish`；
3. 用户端在市场的该插件行上就会出现「更新」。

只有 **条目本身**（描述、分类、仓库地址）要改时，才回去编辑你那一个 `data/plugins/<owner>__<repo>.yml` 再提 PR——**只改自己那一条**，不要手工编辑生成出来的两个 README。

> 参考：dshmarket 的 `README` 明确写了「这个仓库是市场应用本身，不是插件目录」，投稿请去 `awesome-dsh-plugin`；完整规则见该仓库的 [`contributing.md`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

---

## 已知限制

- **仅 Windows**。串口桥依赖 `System.IO.Ports` + PowerShell。
- **发送侧不做转义**：十六进制模式按字节直发，文本模式按 UTF-8 发送。
- **接收显示按到达分块**，不保证按行聚合——这与多数串口助手一致，但若需要「按行」视图需在上层再加缓冲。
- 插件的 HTTP 路由在 loopback 上**不鉴权**（DSH 的 webserver 本身没有全局鉴权层，各路由所有者自行把关）。它只监听本机，但本机上的其它进程可以调用它来读写串口。
- 面板仅在打开时轮询；关闭面板期间到达的数据仍保留在宿主的有界日志里（离开面板再回来会补上尾部 500 条）。
