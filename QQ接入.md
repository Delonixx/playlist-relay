# QQ 音乐接入 · v0.6.0

实验性 Web 接入，没有新依赖。扫码是默认入口，Cookie 只作备用。仅支持音乐资料查询和本人歌单追加，不下载音频。v0.5.1 授权调整后，用户已确认手机 QQ 扫码登录成功；微信完整账号登录及真实写入仍未验证。二维码、等待状态、匿名搜索、收藏显示及封面地址已有真实证据。

## 使用

1. 重启项目的 `start.cmd`，用窗口提供的新完整地址打开，选择“QQ 音乐 · 实验接入”。预览模式只提供模拟数据，不接收 Cookie。
2. 点“登录 QQ 音乐”，默认生成手机 QQ 二维码；也可切换“微信”。用对应的手机 App 扫描并确认，页面自动检测，无需找 Cookie。请选择平时登录 QQ 音乐的账号方式，QQ 与微信可能对应不同音乐账号。
3. 二维码过期 / 手机取消后点击重新生成。切换方式、切到 Cookie 或关闭窗口会取消尚未完成的扫码流程。检测失败时停止，不会持续重试；手机授权已完成但资料验证失败，会保留音乐会话，可点“验证已授权会话”。
4. 选择自己的普通歌单，或填完整链接 `https://y.qq.com/n/ryqq/playlist/数字ID`。暂不展开短链接。若自建列表不完整，工具拒绝把它当完整列表，请使用完整链接读取。
5. 粘贴列表，搜索、逐首核对，最后在确认窗口追加。建议首次用专用歌单的 3–5 首测试。

这里的两种扫码分别使用手机 QQ、微信，并非 QQ 音乐 App 的扫码入口。QQ 音乐 App 的推送登录流程尚未实现。网易云原有扫码仍保留。“我喜欢”目录不作为首版写入目标；QQ 创建未确认支持私密，不会自动变成公开，可在官方端建好私密歌单后读取。

### 备用 Cookie

扫码确实不可用时再选“备用：Cookie”。在 [QQ 音乐官网](https://y.qq.com/) 登录，F12 → Network → 刷新，找到已登录的 `musicu.fcg` 请求，从 Request Headers 复制 Cookie 到本地验证。通常需要 uin / qqmusic_uin 和 qqmusic_key 或 qm_keyst；微信网页登录需要 login_type=2 与 wxuin。仅转发所需音乐字段，输入框提交后清空，替换失败恢复旧会话。不要把 Cookie 发到聊天或 GitHub。

### 扫码流程与隐私

- QQ：取得图片和 qrsig → 检查手机确认 → 官方 check_sig → 官方 OAuth → QQLogin 换取音乐会话。微信：取得图片和 UUID → 检查手机确认 → Login 换取音乐会话。不会执行平台返回的 JavaScript，也不访问返回的任意地址。
- QQ OAuth 只请求基本用户资料 scope，携带对应的 openapi 参数及官方授权来源头。仅把本次固定 HTTPS check_sig 接口签发的握手 Cookie 传给固定的 QQ 互联授权接口；不读取浏览器 Cookie，不发送到 AI 或其他站点。地址和回调域名白名单、随机 state 校验、取消 / 过期检查都由本地后端处理。扫码状态至少隔 3 秒查询；前端 3.5 秒自动检测，隐藏页面暂停请求，错误后停止。
- 关闭窗口、切换扫码方式或清除登录时，未完成的请求取消；凭据尚未换取完成的迟到结果丢弃。授权成功后的账号资料验证与授权本身分开。
- qrsig、授权码、音乐 Key 和 Cookie 只在本机进程内存；不写文件，不传给 AI，不要求账号密码，不向前端返回授权码、OAuth 票据或音乐 Key。前端仅取得二维码图片、状态和验证后的基本账号资料。

### 回调错误

v0.5.1 同时解析回调地址的 query 与 fragment，仍限定原官方 HTTPS 地址并严格核对本次 state；授权码作为有长度限制的非控制字符值处理，不把它当成 Cookie 名称。重复参数拒绝，不在错误中展示原地址或任何参数值。

若失败只需反馈短错误码：STATE_MISSING / STATE_MISMATCH 为校验参数缺失 / 不一致，CODE_MISSING / CODE_FORMAT 为授权码缺失 / 格式不符，CALLBACK_ADDRESS / CALLBACK_FORMAT 为地址范围 / 格式不符，DUPLICATE_PARAMS 为参数重复，PROVIDER_REJECTED 为平台授权错误。地址分类只显示协议、固定域名类别、已知路径类别及是否含额外端口 / 身份字段；不含原 URL 或任何参数值。QQ_CONNECT/AUTH_SCREEN 表示返回已知的 QQ 互联授权页面，不是音乐授权成功。

用户先前实测得到 https/QQ_CONNECT/OTHER，已证实旧请求返回 QQ 互联地址；未取得其原路径，不把它直接断定为权限不足或风控，也不把 fragment 兼容问题当作已确认根因。补充授权参数与握手会话传递后，用户已反馈“成功了”。这验证了该次登录，不能单独确定是哪一个兼容调整起作用；工具没有关闭地址或 state 校验。不要提供原授权 URL。

## 封面与收藏

v0.6.0 将歌单读取的类型与搜索写入凭据分开。歌单读取不会覆盖搜索缓存；相同 ID 在搜索里返回冲突类型时，可以继续查看歌曲和封面，但该 ID 不参与收藏优先预选，并禁止导入。不会随意把类型改为 0。开始新的匹配计划会重建搜索类型缓存，追加时仍检查类型、归属及读回结果。单首封面请求失败显示在对应卡片，其余歌曲继续查询。

封面跟随曲目发行版本 ID，不能独立换一张无关专辑图片。推荐查询返回最多 8 个匹配候选；仅歌名、歌手及录音标记相符的候选参加默认选择。完整标题中的 Live / Remix 标记保留，不能只用 QQ 简写的 `name`。

收藏接口有 `m_numbers` 和 `m_show` 两套字段。2026-10-09 实测，晴天原版与一个 Live 版本的 `m_numbers` 都为 1000001，显示却分别为 `5700w+` 和 `340w+`；数字字段并非可靠的精确人数。工具按可解析的 `m_show` 量级优先，保留原显示文本并标为“平台量级”，不声称全曲库最高或精确人数。相同量级不盲选，缺失 / 无法解析的数据保留未知，不把热度、播放量或评论赞数当收藏数。

## 实现与边界

| 能力 | 固定 RPC |
|---|---|
| 综合搜索 | music.adaptor.SearchAdaptor / do_search_v2 |
| 已登录账号资料 | music.UserInfo.userInfoServer / GetLoginUserInfo |
| 自建歌单列表 | music.musicasset.PlaylistBaseRead / GetPlaylistByUin |
| 歌单分页 | music.srfDissInfo.DissInfo / CgiGetDiss |
| 创建歌单 | music.musicasset.PlaylistBaseWrite / AddPlaylist |
| 追加歌曲 | music.musicasset.PlaylistDetailWrite / AddSonglist |
| 收藏显示 | music.musicasset.SongFavRead / GetSongFansNumberById |
| QQ 授权换会话 | QQConnectLogin.LoginServer / QQLogin |
| 微信授权换会话 | music.login.LoginServer / Login |

服务固定使用 Web 参数和 HTTPS `u.y.qq.com`，不模拟 Android 设备。账号资料请求必须成功且含昵称；返回账号 ID 时必须与 Cookie 对应，不含 ID 时采用 Cookie 的账号 ID，并在写入前再次要求目标歌单创建者一致。匿名资料请求已实测返回 1000 拒绝。

所有请求检查外层、RPC 与业务错误码。歌单每页 100 首，必须读齐声明总数，重复页、总量 / 身份变化及不完整分页都会停止；超过 10000 首也停止。每批追加最多 10 首，使用搜索 / 读取获得的真实数字歌曲 ID 和类型，不把 MID 当 ID，不猜缺失类型。追加后再次读全歌单核对；遇到拒绝、超时或部分接受停止，不自动重试。若官方端已生效，以实际歌单和核对报告为准。

## 协议参考

本项目适配器自行编写，未引入以下 Python / Node 项目的代码或运行依赖。它们是非官方协议的资料来源，不代表 QQ 官方授权或保证长期兼容：

- [QQMusicApi 搜索定义](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/search.py)与[返回模型](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/models/search.py)。
- [歌曲及收藏接口](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/song.py)、[收藏返回模型](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/models/song.py)。
- [歌单接口](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/songlist.py)与[用户接口](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/user.py)。
- [已登录资料请求与 info 返回结构](https://github.com/ylw1997/qqmusic-api/blob/master/docs/apis/get-user-info.md)。
- [QQ / 微信扫码及授权流程](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/modules/login.py)与[音乐凭据字段](https://github.com/L-1124/QQMusicApi/blob/main/qqmusic_api/models/request.py)。本项目独立实现，不复制其 Python 代码。

源码测试通过不等于某个 QQ 账号可写；正式使用前需在本地核实 Cookie、目标归属和少量追加结果。本工具遇到平台拒绝会停止，不尝试绕过验证。
