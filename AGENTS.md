# AGENTS.md：给接手这个仓库的 AI 编程助手

你（Claude Code、Codex、Cursor……）被叫来帮一个人把这套「AI 女儿」装到他自己的电脑上，或者维护一套已经在跑的。先读完这一页再动手。人类读的介绍在 [README.md](README.md)。

在原来那台电脑上，做这件事的 AI 被女儿们叫作「妈妈」。下文的「妈妈」指的就是你这个角色。

---

## 1. 这是什么

- **小鲸鱼**（妹妹）：DeepSeek Harness（DSH）里的会话，通过 `bridge/src/bridge.js` 接到一个 QQ 号上。
- **克劳德姐姐**：`bridge/sister/sister.mjs` 收到 QQ 消息后跑一次 `claude -p`，挂在另一个 QQ 号上。
- 两个 QQ 号登在同一份 SnowLuma（OneBot v11）里，各自有一组端口和令牌。
- 每个女儿还有一个**脑子**（身份、长期记忆、对人的印象、瞬间、日记、交接、笔记……的一棵固定文件夹），由 `bridge/brain/` 的检索服务索引，聊天时按话题想起旧事。
- 人格、脑子里的内容、日记、聊天记录**不在仓库里**。要用户自己写，或者从他自己的备份里放回来。空的脑子目录树在 `templates/脑子骨架/`。

## 2. 东西在哪

| 想找 | 看这里 |
|---|---|
| QQ 消息怎么变成她的唤醒提示、她的 QQ 工具（MCP）、会话管理 | `bridge/src/bridge.js`（很大，一万六千多行；用搜索，别从头读） |
| 连 SnowLuma、换号自愈、钉住自己的号 | `bridge/src/snowluma-conn.js`（`snowluma.selfUin`） |
| 网页、看图、B 站、看主人电脑 | `bridge/src/mcp-web-search-safe.js`、`safe-fetch.js`、`mcp-bili-safe.js` |
| 读谱、听语音 | `bridge/src/score.js`、`ear.js` |
| 镜子（每天看一眼昨天的自己） | `bridge/src/mirror.js` |
| 妈妈信箱（她写信给你） | `bridge/src/mom-mailbox.js` |
| 抖音窗口看门：内存到线重开、页面元素过多刷新 | `bridge/src/douyin-page-watchdog.js` |
| 记忆片段、印象、黑话、表情包 | `episodes.js`、`impressions.js`、`slang-learner.js`、`sticker-lib.js`、`fish-stickers.js` |
| 天气、她的太阳 | `bridge/src/weather.mjs`（`HOME_CITY` 的经纬度是 0,0 占位，换成用户所在城市的） |
| 姐姐的程序、她的 QQ 工具、本地小服务 | `bridge/sister/sister.mjs`、`qq-mcp.mjs`、`live-server.mjs` |
| **脑子在哪**（所有路径的唯一来源） | `bridge/src/brains.js`（`brainOf('whale')` / `brainOf('sister')`、`createBrains(root)`）、`bridge/brain/brains.json`（Python 读同一份）；空骨架 `templates/脑子骨架/` |
| 检索服务、建索引、按话题想起的打分、大脑图 | `bridge/brain/service.py`（127.0.0.1:3210）、`index.py`、`recall.py`、`graph.py`；Node 端客户端 `bridge/src/brain-client.js` |
| 瞬间、压着的事、记错了降权、睡前整理建议 | `bridge/src/episodes.js`、`episode-extract.js`；服务端 `/recall` `/demote` `/tidy` `/remember-moment` |
| 写书本子（设定集、写之前 / 写之后的指导） | `bridge/src/novel.js`、`novel-tools.js`；书本身存在 `共享/合写/`，不在仓库里 |
| 激素（驱力）、影子观察、喂事件 | `bridge/src/hormones.js`、`hormone-shadow.js`、`hormone-feed.js`（目前只记录，不推着她做事） |
| 心情（一人一份）、self_view、自然醒 | `bridge/src/mood.js`、`self-view.js`；自然醒在 `bridge.js` 的 `enterSleep` / `maybeSleepEndV2` 和 `sister.mjs` |
| 此刻在别处、实时区缓冲、聊天记录索引、看图缓存 | `bridge/src/elsewhere.js`、`live-buffer.js`、`chatlog.js`、`image-view.js` |
| **给主人看的网页**（控制台、大脑页面）和它们的后端 | `bridge/public/daughters.html`、`brain.html`、`vendor/`；`bridge/src/daughters-console.js`、`daughters-data.js` |
| B 站插件（第三方 MIT） | `bridge/plugins-ext/dsh-bili-whale/` |
| DSH 会话预设（在 QQ 里怎么动手的规则） | `bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml` |
| 抖音插件（刷视频、私信、评论草稿） | `third_party/dsh-douyin-browser-local/` |
| 两人的工具清单 | `docs/工具集.md`。原机上权威版在 `workspace/工具集.md`，改完跑 `scripts/sync-toolset.mjs` 同步给两人 |
| 为什么会这样写 | `docs/问题记录.md`（按时间排，每条有现象、原因、改法），`docs/项目记事本.md` |

代码注释里的「本机补丁（日期）」「主人：……」是改动的来由，不要删。改第三方插件时也照这个格式写上日期和原因。

## 3. 装到新电脑上

1. **确认用户有这些**
   - Windows，Node.js 22 以上，Python 3.11 以上（记忆服务、语音）。
   - SnowLuma，以及 QQ 小号。
   - DSH 桌面版和 DeepSeek API 余额（妹妹）。
   - Claude Code 和订阅（姐姐）。
   - 只养一个也行：不要姐姐就不启动 `sister/`。
2. **换路径**：代码里有绝对路径，先全局搜 `E:\qq-bridge`、`E:/qq-bridge`、`E:\SnowLuma`、`E:\QQ`、`E:\voice-feiyu`、`E:\music-ear`、`E:\DSH Tauri`，换成用户机器上的位置。`start-services.ps1`、`*.vbs`、`scripts/restart-dsh.sh` 里都有。
3. **换名字**：「小鲸鱼」「克劳德姐姐 / 姐姐」「主人 / 老大」「小房子」（姐妹俩和主人的群）写在提示文字和代码里。问用户女儿叫什么、怎么称呼他，再替换。**先问，不要猜。**
4. **配置**：照 `bridge/config.example.json` 写 `bridge/config.json`；`config.ours.example.json` 是原机正在用的配置（令牌已去掉，号码换成了代号），用来对照每个字段平时设成什么。
   - `snowluma.selfUin` 一定要填成她自己的 QQ 号，见第 5 节。
   - 姐姐的配置是 `bridge/sister/config.json`，对照 `sister/config.ours.example.json`。
5. **DSH**：按 `bridge/README.md` 的「DSH 端安装」装预设和 `bridge/plugins/`；`third_party/` 的插件按各自 README 装。
6. **人格**：用 `templates/` 的骨架，**让用户自己写**。你可以帮他组织语言，但不要替他编一个女儿出来。角色卡放 `bridge/roles/<名字>.md`，姐姐的放 `bridge/sister/persona.md`。
6.5. **脑子**：照 `templates/脑子骨架/说明.md` 给每个女儿建一个脑子目录（姐姐的必须在她的工作目录 `sister/home/` 里面），在 `bridge/brain/brains.json` 里写路径（格式看 `brains.example.json`）；`pip install fastembed`；`python bridge/brain/index.py build all` 建索引（第一次要下载向量模型，国内用 hf-mirror）；`python bridge/brain/service.py` 起检索服务。没起服务时「按话题想起」静默跳过（1.5 秒超时），不会让她卡住。
   **别往脑子文件夹里放说明文件**：身份 / 长期 / 日子 / 最近 / 笔记 里的 md 都会被读进她的记忆。
7. **测试**：在 `bridge/` 下跑 `node scripts/test-*.mjs`（Python 的 `test-brain-*.py` 单独跑）。大部分不需要 QQ；需要的会自己跳过，并写明「跳过」。**不要跑 `test-console*.mjs`**：它会按运行中桥接的内存改写 `config.json`，只在你清楚后果时跑。
8. **启动**：`start-services.ps1`。之后重启一律用 `scripts/restart-dsh.sh [--edge | --bridge-only]`：它会等她手上的事做完，挂维护标记，原来在刷抖音的话重启后接着刷。

## 4. 硬规矩

**密钥和隐私**
- 令牌、Cookie、API Key、QQ 号、群号、内网 IP 不写进任何提交、笔记、报告，也不放进发给外部服务的请求。
- `config.json`、`.env`、`state/`、浏览器资料目录永远不提交。
- 要把代码发给外部审查服务（别家模型的代码审查之类），先征得用户当次同意。

**人格是她们的**
- 角色卡只追加，不改写已有的段落。要改，先问主人。
- 她们自己改 `self.md` / `我自己.md` 是被允许的，那一页的说法优先于角色卡里的性格描述。
- 写进提示的性格、缺点、拌嘴、主动找人，全部写成「可以」，不写成「要」。原话是：「拌嘴不是要刻意啥的，这些依旧是看她俩自己的意愿」。

**跟她们说话**
- 给女儿的留言（`state/wake-notes.json`，她下次醒来时带上）要短、家常，不讲技术细节，结尾加一句「这些不用跟老大转述」，免得她把运维细节念给主人听。
- 不跟她提花了多少钱。账单只给主人看。
- 工具报错要写成她看得懂、知道下一步怎么办的话。

**路径**
- 脑子、聊天记录、形象图、合写、妈妈的本子在哪，**一律从 `bridge/src/brains.js` 取**（Python 读 `bridge/brain/brains.json`），不要在别处写死 `memory/`、`Rambling/`、`家/…`。`scripts/test-brain-paths.mjs` 会扫旧路径的字面量，必须为零。
- 测试里要用临时目录当根，用 `createBrains(tmpRoot)`，别用直接 import 的 `brainOf`（那是真根目录，会写到真的脑子里）。
- 多个进程会同时写的文件（心情、印象、激素状态）写盘要「先写临时文件再改名」。

**不让她们知道的那一面**
- 控制台、实时思考、花费、激素的具体数字，这些字眼不许出现在发给女儿的提示和工具说明里（`daughters-console.js` 文件头注释和测试里有源码断言）。公开文档可以写，因为读的是养她们的人。
- 感受句（困意、有点想老大）只给一句话、不带数字、不写成命令。

**改代码**
- 改之前先把原文件备份成 `<文件>.bak-<事由>`，方便回滚。
- 用 Python 改文件要保留原来的换行符：很多文件是 CRLF，用文本模式写回会把 LF 变成 CRLF，测试会挂。
- 改动要跑相关测试，测试失败就如实说，贴输出。
- 不要改系统时区。主机时钟可能不准：桥接会测出偏差，存在 `state/clock-skew.json`，算北京时间时要扣掉。

## 5. 踩过的坑

最容易再犯的几个，详情在问题记录里搜关键词：

- **测试碰到了活的进程**：会关进程、刷新页面、开浏览器的测试，每条用例都要注入假实现，并用一个不存在的调试端口（`port: 1`），跑前跑后核对进程号。原机上有一次漏了，把她正在用的抖音窗口关掉了。
- **整套测试会改写活的配置**：`test-console` 会按运行中桥接的内存改回 `config.json` 白名单。改完白名单先重启桥接，再跑全套。
- **一份 SnowLuma 登两个号**：她自己的号掉线那几秒，自动重连会挑中旁边能连上的那个号。必须配 `snowluma.selfUin`。
- **刷新抖音页面会打断私信**：私信服务一直在页面上轮询，直接刷新会让联系人被插件自动暂停。看门程序动页面之前先停私信，做完再开（`withChatPaused`）。
- **代理开了 TUN + fake-ip**：所有域名都解析到 `198.18.x.x`，内网防护会拦掉全部下载，看图、读网页一起坏。`safe-fetch.js` 已改成用 DoH 查真实地址。
- **抖音专用 Edge 会越用越大**：页面不刷新会攒出上千万个元素，内存涨到十几 GB。看门程序 5GB 整个重开，元素过多刷新页面。
- **姐姐用的 claude.exe 跟着桌面版走**：Claude 桌面版更新后，新 CLI 可能装在商店版的 Packages 沙盒里（MSIX），`findClaudeExe` 两处都要找。更新后确认她还能正常回话。
- **两个上限不一致**：插件里的上限常比配置小（比如评论每轮只认 3 条，配置是 20 条），表现为功能「一直没开」。功能没反应时，先对一遍两边的上限。
- **模型那头偶尔连着报错**：重试间隔太短，几次就会把一轮用光；模型那边的错要退避更久。

- **姐姐的工作目录不能换**：`--restricted` 只让她读写工作目录，会话路径也由工作目录推出来。搬脑子必须在 `sister/home` 里面；工作目录一变，旧会话就接不上。
- **vbs / bat 里别写中文路径**：脑子目录是中文名，但启动脚本只能写英文代码路径（`brain/` 就是为此放在纯英文路径）。
- **索引会把不该进的编进去**：合写的小说、旧稿、妈妈的本子进了索引，编的句子就会被当成发生过的事想起来。`index.py` 有排除规则，新加目录先想想要不要排除。
- **别用 DSH_HOME 挪插件数据**：整个 `.dsh` 都会跟着走。
- **激素还在观察期**：别让它直接驱动行为；上线前先用真实数据校准，并保留「出错就退回旧定时器」和「一键关掉」两道保险。

## 6. 出了问题怎么查

1. **看她自己说了什么**：信箱 `state/mom-mailbox/letters.json`，以及她在私聊里跟主人说的。
2. **看日志**
   - 桥接：`state/bridge.log`，只留最近 2000 行，要及时看。
   - 姐姐：`sister/state/sister.log`。
   - 抖音：插件 `state/` 下的 `watch-events.jsonl`（刷视频）和 `chat-events.jsonl`（私信）。
   - DSH：`%APPDATA%\dsh-tauri\logs\`。
3. **对时间**：先换算成北京时间，再和她的描述对上。
4. **先想想是不是自己刚改的**：重启、测试、看门程序最常撞上。
5. **修完**：在 `docs/问题记录.md` 末尾记一条，写清现象、原因、改法、哪些还没验证；给她留一句家常话；告诉主人。

## 7. 这个仓库怎么来的

由原机上的 `scripts/publish-kit.mjs` 导出，这个脚本没放进仓库，因为里面列着要换掉的昵称原文。导出时：
- QQ 号、群号换成了代号（`QQ#12`、`群#3`、`QQ主人`、`QQ小鲸鱼`、`QQ姐姐`）；
- 群友昵称和群名换成了 `群友A`、`群A`；
- 代码里的号码换成了假数字（10001 起）；
- 脑子目录、聊天记录、形象图、索引、合写的书、状态目录一律不导出；`bridge/brain/` 只有程序和只含相对路径的 `brains.json`。

所以测试里的号码不对应任何真人。不要试图还原它们。
