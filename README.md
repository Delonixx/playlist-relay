# 歌单接力 · Playlist Relay

**v0.6.3 Alpha** · 本地运行 · 网易云音乐 / QQ 音乐

[![Tests](https://github.com/Delonixx/playlist-relay/actions/workflows/test.yml/badge.svg)](https://github.com/Delonixx/playlist-relay/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

把一系列歌曲带进自己的歌单，再用歌单画像与主动反馈发现新歌。

歌曲列表 → 搜索与版本核对 → 歌单分析 → 推荐与口味反馈 → 待选核对 → 确认追加

这是可试用的早期版本。网易云、QQ 音乐使用非官方接口；真实账号写入与推荐听感尚未完成全面验收，兼容情况可能变化。离线演示可以先体验全部界面，无需账号或 AI Key。

## 看看界面

以下截图均来自明确标注的离线演示，图表数值与选曲用于演示交互。

![音乐发现与跨批次待选](docs/assets/discover-desktop.jpg)

<details>
<summary>查看分析页与手机界面</summary>

![歌单画像与旧结果提示](docs/assets/analysis-desktop.jpg)

<img src="docs/assets/discover-mobile.jpg" alt="手机端推荐与待选" width="390">

</details>

## 能做什么

- **文字列表导入**：支持歌名与歌手、Markdown 编号、去重；搜索后逐首核对专辑和现场 / 混音等录音版本。
- **双平台连接**：网易云 App 扫码；QQ 默认手机 QQ / 微信扫码，Cookie 仅作备用。音乐凭据只保存在本机进程内存。
- **有依据的歌单画像**：分批分析最多 200 首，六维图、点评与参考歌曲；点击维度查看分数定义和单曲理由。
- **独立音乐发现**：贴近口味、向外延伸、尝试跨界；重新推荐复用画像，不必重新读取或打分。
- **主动口味反馈**：喜欢、少推荐、听过可以查看和撤销；在下次主动生成时提供给 AI。
- **选择不会随换批丢失**：跨批次待选保留录音版本，再进入现有匹配与确认流程。待选仅保留在当前页面，刷新会清空。
- **核对后追加**：只处理本人创建的歌单，跳过已有歌曲，每批最多 10 首，追加后读回核验；拒绝或超时不自动重试。

## 快速开始

需要 Node.js 22 或更新版本，推荐 Node.js 24。Windows 可使用项目内的 `.cmd`，其他系统使用终端命令。

### 先体验离线演示

```sh
git clone https://github.com/Delonixx/playlist-relay.git
cd playlist-relay
node server.mjs --demo
```

不需要安装音乐 API 依赖。也可在 Windows 双击 `预览新版.cmd`，使用端口 8772。

从终端打开“请打开”后的**完整本地地址**，包括 `#` 后的访问令牌。默认命令端口为 8765；只有本机可以连接。

### 正式连接音乐平台

在项目目录运行：

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm start
```

已有 pnpm 11.25.0 可跳过第一行。Windows 安装依赖后也可双击 `start.cmd`。默认端口 8765；停止服务按 Ctrl+C，音乐登录与 AI Key 随进程退出清除。

1. 选择平台，点“登录并选择歌单”，扫码并在手机确认。
2. 粘贴每行一首的 `歌名 — 歌手`，点搜索并匹配。
3. 核对曲库候选、专辑和录音版本，跳过不确定的歌曲。
4. 选择自己创建的目标歌单，确认后追加，查看读回核验结果。

```text
That's Enough for Me — Patti Austin
If I Ain't Got You — Alicia Keys
So Sick — Ne-Yo
```

### 使用 AI 分析与推荐

在“AI 设置”中选择智谱、硅基流动、通义百炼或 DeepSeek，填写该服务的 API Key。免费额度、模型可用性与价格以服务商控制台为准；本项目不提供共享 Key，也不保证永久免费。

读取已有歌单或添加歌曲后开始分析，再到“发现”修改方向、偏好、换一批或记录口味。不会自动重试模型请求。

**六维分数来自歌曲资料与模型知识估计，未分析音频；低分表示特征较少，不表示作品或个人品味差。**

详细安装、使用和故障说明见 [使用说明](docs/使用说明.md)与 [QQ 接入说明](QQ接入.md)。

## 数据放在哪里

| 数据 | 保存与传递 |
|---|---|
| 音乐 Cookie、扫码授权资料、AI Key | 本机进程内存；不写文件或浏览器存储，停止服务清除 |
| 主动口味记录 | 当前浏览器保存歌曲名、歌手和标记，最多 200 条；下次主动生成时发给所选 AI，可撤销 / 清除 |
| 待选歌曲与版本 | 当前页面内存；换批保留，刷新 / 关闭页面清空 |
| AI 分析内容 | 向所选服务发送歌曲资料与偏好；不发送音乐 Cookie、账号身份或歌单链接 |

应用绑定 `127.0.0.1`，使用每次启动生成的访问令牌。不要把完整本地地址、Cookie、Key 或扫码授权地址发到 Issue。

## 验证与已知限制

| 项目 | 当前证据 |
|---|---|
| 匹配、版本延续、分析与推荐状态、反馈、导入保护 | 92 项本机模拟测试通过；GitHub Actions 运行结果见上方 Tests |
| 桌面 / 手机排版 | 1280×900、390×844、320×740 实际浏览器检查 |
| 手机 QQ 扫码 | 已有一次实际账号成功反馈；本轮继续选择流程使用模拟测试 |
| 微信完整登录、真实账号创建 / 加歌 | 尚未完成全面实测 |
| AI 推荐质量、不同方向的真实听感差异 | 尚未完成真实听感评估 |

不下载音频、不提供账号密码登录、不保证接口长期有效。封面跟随实际曲库候选，未取得时使用原创几何占位。网易云缺少歌曲收藏人数数据；QQ 收藏显示是平台量级，不是全曲库精确排名。

报告问题时给出版本、平台、操作步骤和不含凭据的短错误提示。贡献说明见 [CONTRIBUTING](CONTRIBUTING.md)，隐私与安全边界见 [SECURITY](SECURITY.md)。

## 开发与许可

```sh
pnpm test
```

Node.js + 原生 HTML / CSS / JavaScript，无前端构建步骤。测试使用本地模拟适配器，不需要音乐账号或付费模型。CI 覆盖 Windows / Ubuntu 与 Node.js 22 / 24。

本项目代码采用 [MIT](LICENSE)。固定网易云依赖及素材来源见 [第三方说明](THIRD_PARTY_NOTICES.md)和 [素材来源](素材来源.md)；依赖自身许可证与实际封面权利保持独立。
