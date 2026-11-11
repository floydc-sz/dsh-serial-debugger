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

| 区域 | 能力 |
| --- | --- |
| 参数区·首行 | 「串口选择」下拉显示设备描述（`COM3:USB-SERIAL CH340`，Linux 上形如 `/dev/ttyUSB0:FTDI`），可「刷新」重新枚举，无可枚举串口时降级为手输框；同一行右侧依次是「语言」与「帮助」 |
| 参数区·参数 | 「波特率」「停止位」「数据位」「校验位」排成两行两列，每个名称都与它的控件同行 |
| 参数区·操作 | 「串口操作」打开/关闭串口，连接后参数锁定；「保存窗口」把接收区导出为 .txt；「清除接收」清空接收区 |
| 参数区·开关 | 「16进制显示」「DTR」「RTS」「自动滚动」「时间戳」 |
| 接收区 | 占满剩余高度；**连续到达的数据块合并成一行**，换行只由数据里的换行符决定；发送内容以 `→` 前缀显示；底部状态行显示连接状态、当前参数、收发字节数与行数 |
| 发送区·输入 | 输入框 5 行高、字号 13px，`Ctrl+Enter` 发送，右侧是「发送」「清除发送」 |
| 发送区·开关 | 输入框**上方**一行：「16进制发送」（`AA 55 01`、`0xAA,0x55` 均可）「发送新行」「定时发送」＋「周期」毫秒 |
| 发送区·文件 | 「打开文件」「发送文件」「停止发送」左对齐，右侧同一行是传输进度条与百分比 |
| 帮助 | 点击弹出两列表格（控件／说明），每个控件一条、顺序与界面一致；点「关闭」或遮罩关闭 |
| 语言 | 「语言」下拉在中文与 English 之间切换整套文案，选择会被记住，未选择时跟随 DSH 自身语言 |

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
- **Linux（Ubuntu 20.04+）**：系统没有 `System.IO.Ports`，串口桥改用 [`serialport`](https://www.npmjs.com/package/serialport) 原生绑定。**它不是本包的依赖，不会自动安装**——原生模块需要运行构建脚本，而 DSH 出于安全默认拦截，声明成依赖会让每次更新都失败。需要单独装一次：

  ```bash
  dsh plugin --profile <你的 profile> add serialport
  ```

  若 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，放行 `@serialport/bindings-cpp` 的构建脚本后重装（DSH 的提示条上就有「放行并重新安装」）。**Windows 不需要这一步，也不受影响**，因为 Windows 走 PowerShell 后端。
- **预编译与本地编译**：`serialport` 自带预编译二进制；若目标平台没有，会自动尝试本地编译，需要 `build-essential` 与 `python3`。
- **自定义绑定**：环境变量 `DSH_SERIAL_MODULE` 可指向另一个实现（同一套 `SerialPort` 接口），便于离线部署或替换。
- **串口权限**：普通用户默认无权打开 `/dev/ttyUSB*`、`/dev/ttyACM*`。把用户加入串口组后**重新登录**：

  ```bash
  sudo usermod -aG dialout $USER    # Ubuntu / Debian / Fedora
  sudo usermod -aG uucp    $USER    # Arch
  ```

  未加入时打开会得到明确提示（而不是一个裸 `EACCES`）。
- **DSH `^0.2.0-rc.1`**（见 `package.json` 的 `dsh.engines.dsh`）。
- 无构建步骤：客户端半边是预构建产物，两个后端脚本随包发布。

## 版本更新

### 1.1.2 · 2026-11-11

- 接收区：**连续到达的数据块合并成一行**，换行只由数据里的换行符决定（此前每个到达块各占一行，看起来像随机换行）；顺带修复跨块的多字节字符被截断成乱码
- 时间戳：开启后**每行各自标注**开始到达的时间，而不是整块只标一次（合并前先拼字节，中文不会碎）
- 接收框与发送框：边框加深一档，字号 12 → 13px，发送框 3 → 5 行
- 发送区重排：「16进制发送」「发送新行」「定时发送」「周期」移到输入框**上方**；文件按钮与进度条同一行、左对齐
- 参数区：「语言」与「串口选择」同一行；「帮助」移到首行「语言」之后；串口选择占整行三分之一，操作按钮统一 86px、帮助 57px
- 帮助：改为弹层，内容是「控件／说明」两列表格，每个控件一条、顺序与界面一致，表头居中并带底色

### 1.1.1 · 2026-11-11

- **修复：Windows 上无法更新到 1.1.0**。原因是把 `serialport` 声明成了依赖，而它带原生构建脚本，DSH 出于安全默认拦截（`ERR_PNPM_IGNORED_BUILDS`），pnpm 因此整体失败——可 Windows 用的是 PowerShell 后端，根本不需要这个包。现已**不再声明该依赖**
- Linux 用户改为显式安装一次（见「系统要求」），需要在时放行 `@serialport/bindings-cpp` 的构建脚本
- 绑定缺失时的报错换成准确命令：`dsh plugin --profile <profile> add serialport`

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
