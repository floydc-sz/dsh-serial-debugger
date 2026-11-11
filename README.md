# dsh-serial-debugger

**中文** ｜ [English](README-EN.md)

DeepSeek Harness 串口调试插件。在 DSH 界面内提供一个完整的串口监视/调试面板：**串口参数设置**、**实时接收并显示数据**、**发送数据**。

- npm 包：`dsh-serial-debugger`
- 仓库：<https://github.com/floydc-sz/dsh-serial-debugger>
- 平台：**Windows / Linux**（Ubuntu 20.04 及以后）

---

## 界面

本插件界面位于**Harness 主界面的右侧边栏**，以原生标签页的形式存在。

1. 点标题栏的「打开侧边栏」打开右侧边栏；
2. 右侧边栏的引导页（空状态）列出可打开的标签类型，其中一行是 **「串口调试」**；
3. 点这一行，串口调试界面就在右栏内打开（标签上显示「串口调试」）。

| 界面    | 能力                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------- |
| 参数区   | 「串口选择」下拉显示 `COM3:USB-SERIAL CH340`（Linux 上形如 `/dev/ttyUSB0:FTDI`）的**设备描述**，可「刷新」重新枚举；无可枚举串口时自动降级为手输框。「波特率」「停止位」「数据位」「校验位」下拉；「串口操作」打开/关闭串口，连接后参数锁定 |
| 操作与开关 | 「保存窗口」把接收区导出为 .txt；「清除接收」；「16进制显示」「DTR」「RTS」「自动滚动」「时间戳」                                                               |
| 接收区   | 占满剩余高度，实时追加显示，文本或十六进制视图、可选时间戳、自动滚动（手动上滚时自动暂停）；发送内容以 `→` 前缀弱化显示；底部状态行显示连接指示、当前参数、收发字节数与条数                              |
| 发送区   | 「单条发送」/「帮助」标签页；发送输入框（`Ctrl+Enter` 发送）与「发送」「清除发送」                                                                      |
| 发送选项  | 「定时发送」＋「周期」毫秒；「打开文件」「发送文件」「停止发送」（1 KB 分块、显示进度百分比）；「16进制发送」（`AA 55 01`、`0xAA,0x55` 均可）；「发送新行」（追加 CRLF）                 |
| 语言切换  | 与「串口选择」**同一行**（参数区首行右端）的下拉，可在**中文**与**English**之间切换整套界面文案；选择会被记住，未选择时跟随 DSH 自身语言 |

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

- **Windows**：串口桥使用 .NET 的 `System.IO.Ports`，由 Windows 自带的 **Windows PowerShell 5.1** 提供，无需额外安装（已在 5.1 上验证）。
- **Linux（Ubuntu 20.04+）**：系统没有 `System.IO.Ports`，串口桥改用 [`serialport`](https://www.npmjs.com/package/serialport) 原生绑定，已列为 `optionalDependencies`，安装插件时自动装上。
- **国内环境提示**：`serialport` 自带预编译二进制；若某个平台没有预编译包，安装时会尝试本地编译，需要 `build-essential` 与 `python3`。
- **串口权限**：普通用户默认无权打开 `/dev/ttyUSB*`、`/dev/ttyACM*`。把用户加入串口组后**重新登录**：

  ```bash
  sudo usermod -aG dialout $USER    # Ubuntu / Debian / Fedora
  sudo usermod -aG uucp    $USER    # Arch
  ```

  未加入时打开会得到明确提示（而不是一个裸 `EACCES`）。
- **DSH `^0.2.0-rc.1`**（见 `package.json` 的 `dsh.engines.dsh`）。
- 无构建步骤：客户端半边是预构建产物，两个后端脚本随包发布。

## 版本更新

### 1.1.0 · 2026-11-11
- **新增 Linux 支持**（Ubuntu 20.04 及以后）：Linux 没有 `System.IO.Ports`，新增 Node 后端 `lib/serial-helper.mjs`，改用 `serialport` 原生绑定；**Windows 仍走原来的 PowerShell 后端，行为不变**
- 后端按平台选择：`DSH_SERIAL_HELPER` 指向 `.mjs`/`.js` 时用当前 Node 运行，否则 Windows 交给 PowerShell——后端因此可替换，测试替身也不必是 PowerShell
- Linux 专项处理：`/dev/ttyS*` 主板串口自动过滤、`EACCES` 给出加入 `dialout`/`uucp` 组的可执行提示、`1.5` 停止位明确拒绝（termios 不支持）
- `os` 字段不再限制 Windows；`serialport` 列为 `optionalDependencies`，缺失时给出安装指引而不是崩溃
- 测试运行器改为 `tools/run-tests.mjs`（跨平台），`run-tests.ps1` / `run-tests.sh` 为薄封装

### 1.0.4 · 2026-11-10
- 语言切换从界面顶部单独一行移入参数区首行，与「串口选择」**同一行**（右端），省掉一整行高度

### 1.0.3 · 2026-11-10
- 界面右上角新增**语言切换**：可在中文与 English 之间切换整套界面文案，选择会被记住；未做选择时跟随 DSH 自身的语言
- 标签页标题与右侧边栏引导页的条目随之切换
- 面板内全部文案（参数、按钮、复选框、占位符、状态行、帮助页、错误提示）统一走同一份词典

### 1.0.2 · 2026-11-10
- 新增 [README-EN.md](README-EN.md) 英文说明；两份 README 顶部加入语言切换链接
- `README-EN.md` 加入 `files`，随 npm 包一起发布

### 1.0.1 · 2026-11-10
- 修正系统要求：串口桥由 Windows 自带的 **Windows PowerShell 5.1** 提供（此前误称同时支持 PowerShell 7）
- README 精简为使用者所需的内容
- 测试中硬编码的版本号改为 semver 形状校验，发版不再需要改测试

### 1.0.0 · 2026-11-10
- 首个版本：串口参数设置、文本/十六进制实时接收显示、数据发送（含定时发送与文件发送）

## 许可

MIT，见 [LICENSE](LICENSE)。
