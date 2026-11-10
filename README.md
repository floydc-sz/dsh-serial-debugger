# dsh-serial-debugger

DeepSeek Harness 串口调试插件。在 DSH 界面内提供一个完整的串口监视/调试面板：**串口参数设置**、**实时接收并显示数据**、**发送数据**。

A serial-port debugger plugin for DeepSeek Harness: port parameter setup, live receive display, and data transmission — inside the DSH UI.

- npm 包：`dsh-serial-debugger`
- 仓库：<https://github.com/floydc-sz/dsh-serial-debugger>
- 平台：**仅 Windows**

---

## 界面

界面只有一处：**Harness 主界面的右侧边栏**，以原生标签页的形式存在。

1. 点标题栏的「打开侧边栏」打开右侧边栏；
2. 右侧边栏的引导页（空状态）列出可打开的标签类型，其中一行是 **「串口调试」**；
3. 点这一行，串口调试界面就在右栏内打开（标签上显示「串口调试」）。

面板自上而下分三段：参数区、接收区、发送区。

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

| 区域 | 能力 |
| --- | --- |
| 参数区 | 「串口选择」下拉显示 `COM3:USB-SERIAL CH340` 形式的**设备描述**，可「刷新」重新枚举；无可枚举串口时自动降级为手输框。「波特率」「停止位」「数据位」「校验位」下拉；「串口操作」打开/关闭串口，连接后参数锁定 |
| 操作与开关 | 「保存窗口」把接收区导出为 .txt；「清除接收」；「16进制显示」「DTR」「RTS」「自动滚动」「时间戳」 |
| 接收区 | 占满剩余高度，实时追加显示，文本或十六进制视图、可选时间戳、自动滚动（手动上滚时自动暂停）；发送内容以 `→` 前缀弱化显示；底部状态行显示连接指示、当前参数、收发字节数与条数 |
| 发送区 | 「单条发送」/「帮助」标签页；发送输入框（`Ctrl+Enter` 发送）与「发送」「清除发送」 |
| 发送选项 | 「定时发送」＋「周期」毫秒；「打开文件」「发送文件」「停止发送」（1 KB 分块、显示进度百分比）；「16进制发送」（`AA 55 01`、`0xAA,0x55` 均可）；「发送新行」（追加 CRLF） |

颜色与字体取自 DSH 主题 token，明暗主题都跟随宿主。

## 安装

```powershell
dsh plugin --profile desktop add dsh-serial-debugger
```

也可从本地目录安装（`<本包路径>` 换成本仓库解压后的目录）：

```powershell
dsh plugin --profile desktop add <本包路径>
```

装好后重启 DSH 或让 HMR 生效，再按上面「界面」一节打开面板。

### 系统要求

- **Windows**。串口桥使用 .NET 的 `System.IO.Ports`，由系统自带的 Windows PowerShell 提供（5.1 与 PowerShell 7 均可），无需额外安装。
- **DSH `^0.2.0-rc.1`**（见 `package.json` 的 `dsh.engines.dsh`）。
- 默认使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`；可用环境变量 `DSH_SERIAL_POWERSHELL` 指向 `pwsh.exe` 覆盖。
- 零 npm 依赖、无原生编译、无构建步骤。

## 已知限制

- **仅 Windows**。
- **发送侧不做转义**：十六进制模式按字节直发，文本模式按 UTF-8 发送。
- **接收显示按到达分块**，不按行聚合——与多数串口助手一致；需要「按行」视图得在上层再加缓冲。
- **串口真实读写未在硬件上验证**：开发机没有可用串口，`System.IO.Ports` 的 `Read`/`Write` 行为依赖具体驱动。首次接入真实设备时，建议先短接 TX/RX 做一次回环确认。
- 插件的 HTTP 路由在 loopback 上**不鉴权**：只监听本机，但本机上的其它进程同样可以调用它读写串口。
- 面板仅在打开时轮询；关闭面板期间到达的数据仍保留在宿主的有界日志里（回到面板会补上尾部 500 条）。

## 开发

仓库里的 `tools/` 是无硬件依赖的测试与安装脚本：

```powershell
powershell -ExecutionPolicy Bypass -File tools\run-tests.ps1
```

四套共 131 项：串口桥协议、宿主 HTTP 路由、客户端 bundle、完整收发回环。`tools/` 不参与运行时；`package.json` 的 `files` 只发布 `lib/`、`cordis.patch.yml`、`README.md` 与 `LICENSE`。

## 许可

MIT，见 [LICENSE](LICENSE)。
