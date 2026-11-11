# dsh-serial-debugger

**中文** ｜ [English](README-EN.md)

DeepSeek Harness 串口调试插件，在 DeepSeek Harness 界面内提供一个完整的串口监视/调试面板：**串口参数设置**、**实时接收并显示数据**、**发送数据**。

- npm 包：`dsh-serial-debugger`
- 仓库：<https://github.com/floydc-sz/dsh-serial-debugger>
- 平台：**Windows / Linux**（Ubuntu 20.04 及以后）

---

## 界面

本插件位于**DeepSeek Harness 主界面的右侧边栏**，以原生标签页的形式存在。

1. 点标题栏的「打开侧边栏」打开右侧边栏；
2. 右侧边栏的引导页（空状态）列出可打开的标签类型，其中一行是 **「串口调试」**；
3. 点这一行，串口调试界面就在右栏内打开（标签上显示「串口调试」）。

| 界面区域   | 功能                                                                                                                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 参数区·首行 | 「串口选择」下拉显示设备描述（Windows 系统中如 `COM3:USB-SERIAL CH340`，Linux 系统中如 `/dev/ttyUSB0:FTDI`），可「刷新」重新枚举，无可枚举串口时降级为手输框；同一行右侧依次是「语言」与「帮助」 |
| 参数区·参数 | 「波特率」「停止位」「数据位」「校验位」                                                                                                          |
| 参数区·操作 | 「串口操作」打开/关闭串口，连接后参数锁定；「保存窗口」把接收区导出为 .txt；「清除接收」清空接收区                                                                          |
| 参数区·开关 | 「16进制显示」「DTR」「RTS」「自动滚动」「时间戳」                                                                                                 |
| 接收区    | 换行只由数据里的换行符决定；底部状态行显示连接状态、当前参数、收发字节数与行数                                                                                       |
| 发送区·输入 | `Ctrl+Enter` 发送，右侧是「发送」「清除发送」                                                                                                  |
| 发送区·开关 | 输入框**上方**一行：「16进制发送」（`AA 55 01`、`0xAA,0x55` 均可）「发送新行」「定时发送」＋「周期」毫秒                                                            |
| 发送区·文件 | 「打开文件」「发送文件」「停止发送」，右侧是传输进度条与百分比                                                                                               |
| 帮助     | 点击弹出功能说明；点「关闭」关掉说明                                                                                                            |
| 语言     | 「语言」下拉，可选择本插件的中文界面或 English 界面；未选择时界面跟随 DeepSeek Harness 自身语言                                                                 |

颜色与字体取自 DeepSeek Harness 主题 token，明暗主题都跟随宿主。

## 安装

```powershell
dsh plugin --profile desktop add dsh-serial-debugger
```

也可从本地目录安装（`<本包路径>` 换成本仓库解压后的目录）：

```powershell
dsh plugin --profile desktop add <本包路径>
```

装好后重启 DeepSeek Harness 或让 Hot Module Replacement 生效，再按上面「界面」一节打开面板。

### 系统要求

- **Windows**：串口桥使用 .NET 的 `System.IO.Ports`，由 Windows 自带的 **Windows PowerShell 5.1** 提供，无需额外安装。

- **Linux（Ubuntu 20.04+）**：系统没有 `System.IO.Ports`，串口桥改用 [`serialport`](https://www.npmjs.com/package/serialport) 原生绑定。需要单独装一次：

  ```bash
  dsh plugin --profile <你的 profile> add serialport
  ```

  若 pnpm 报 `ERR_PNPM_IGNORED_BUILDS`，放行 `@serialport/bindings-cpp` 的构建脚本后重装（DeepSeek Harness 的提示条上就有「放行并重新安装」）。

- **预编译与本地编译**：`serialport` 自带预编译二进制；若目标平台没有，会自动尝试本地编译，需要 `build-essential` 与 `python3`。

- **自定义绑定**：环境变量 `DSH_SERIAL_MODULE` 可指向另一个实现（同一套 `SerialPort` 接口），便于离线部署或替换。

- **串口权限**：普通用户默认无权打开 `/dev/ttyUSB*`、`/dev/ttyACM*`。把用户加入串口组后**重新登录**：

  ```bash
  sudo usermod -aG dialout $USER    # Ubuntu / Debian / Fedora
  sudo usermod -aG uucp    $USER    # Arch
  ```

  未加入时打开会得到明确提示。

- **DeepSeek Harness `^0.2.0-rc.1`**（见 `package.json` 的 `dsh.engines.dsh`）。

## 版本更新

### 1.1.3 · 2026-11-11

- 文档更新：界面区域表按当前界面重写，帮助、语言、发送区与系统要求的说明都与实现保持一致
- 文档更新：不再使用缩写，DSH 写作 DeepSeek Harness，HMR 写作 Hot Module Replacement

### 1.1.2 · 2026-11-11

- 修复接收区把一次报文拆成好几行显示的问题，跨块的中文也不再乱码
- 打开时间戳后，每一行都带自己的到达时间
- 接收框与发送框更好读：字号更大、边框更清楚、发送框加高
- 发送区重排：发送方式开关移到输入框上方，文件按钮与进度条同行
- 参数区重排：语言选择与串口选择同行，帮助移到首行右侧，控件宽度统一
- 帮助改为弹层表格，一控件一条说明，按界面顺序排列

### 1.1.1 · 2026-11-11

- 修复 Windows 上无法更新本插件的问题（新增的原生模块依赖被安装器拦截）
- Linux 用户改为按需单独安装串口库，见「系统要求」

### 1.1.0 · 2026-11-11

- 新增 Linux 支持（Ubuntu 20.04 及以后），Windows 用法与行为不变

### 1.0.4 · 2026-11-10

- 语言选择并入串口选择所在行，面板更紧凑

### 1.0.3 · 2026-11-10

- 新增界面语言切换（中文 / English），选择会被记住

### 1.0.2 · 2026-11-10

- 新增英文说明 `README-EN.md`

### 1.0.1 · 2026-11-10

- 修正系统要求：串口桥由 Windows 自带的 Windows PowerShell 5.1 提供

### 1.0.0 · 2026-11-10

- 首个版本：串口参数设置、实时接收显示、数据发送

## 许可

MIT，见 [LICENSE](LICENSE)。
