# 第三方来源与许可证

这个仓库里有不少代码不是我们写的。下面列出每一份的原作者、来源和许可证。它们的 LICENSE 文件都原样保留在各自目录里。

## 仓库里带着的代码

| 目录 | 原项目 | 作者 | 许可证 | 本机改动 |
|---|---|---|---|---|
| `bridge/` | [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) | Derpyu520 and qq-bridge / QSH contributors | MIT（`bridge/LICENSE.upstream`） | 大量：姐姐、二代仿真、看图、读谱、信箱、镜子、抖音看门程序…… |
| `third_party/dsh-douyin-browser-local/` | [LockyBee/dsh-douyin-agent](https://github.com/LockyBee/dsh-douyin-agent) | LockyBee and contributors | MIT | 有：独立窗口、评论草稿、看图、重试与退避……（注释里标着「本机补丁」） |
| `third_party/dsh-fish-memory/` | [Yuuyuko-uu/dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) | Yuuyuko | MIT | 有：各会话记忆互通 |
| `third_party/dsh-feiyu-mood/` | [Yuuyuko-uu/dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood) | Yuuyuko-uu | MIT | 无 |
| `third_party/dsh-whale-widget/` | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | MeteorNOX | MIT | 无 |
| `bridge/plugins-ext/dsh-bili-whale/` | [Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) | ALTERSSSS | MIT（`bridge/plugins-ext/dsh-bili-whale/LICENSE`） | 有：作息、通知、夜间。2026-10-29 起放在 `bridge/plugins-ext/`（代码里引用的就是这个位置，DSH 里用联接指过来） |
| `bridge/public/vendor/sigma.min.js` | [sigma.js](https://www.sigmajs.org) | Alexis Jacomy, Guillaume Plique, Benoît Simard | MIT（`bridge/public/vendor/sigma.LICENSE`） | 无（原样带着，给「大脑页面」画图用） |
| `bridge/public/vendor/graphology.umd.min.js` | [graphology](https://graphology.github.io) | Guillaume Plique (Yomguithereal) | MIT（`bridge/public/vendor/graphology.LICENSE`） | 无（原样带着，sigma.js 的图数据结构） |

各插件自己引用的第三方项目，见它们目录里的 `THIRD_PARTY_NOTICES.md`、`NOTICE.md`、`PROVENANCE.md`。抖音插件 `media/vendor/` 里另有三个社区项目的源码，原 MIT 许可证也一起保留了。

## 需要自己另外装的（仓库里没有）

| 东西 | 用途 | 说明 |
|---|---|---|
| [SnowLuma](https://github.com/SnowLuma/SnowLuma) | QQ 协议端（OneBot v11） | 非官方协议端，有封号风险 |
| DeepSeek Harness（DSH）桌面版 | 妹妹的运行环境 | DeepSeek 官方软件，按其条款使用 |
| DeepSeek API | 妹妹的模型 | 按量计费 |
| Claude Code | 姐姐的运行环境 | 需要 Claude 订阅，按 Anthropic 条款使用 |
| CosyVoice3 + FeiyuVoice-CosyVoice3 音色包 | 语音合成（`voice/feiyu_tts_server.py`） | 音色包原作者声明「自用，不可商用」；模型和样音不在这里 |
| CrispASR、htdemucs | 读谱：转写旋律、分离人声（`bridge/src/score.js`） | 程序和模型自己下 |
| fastembed（BAAI/bge-small-zh-v1.5） | 脑子的语义检索（`bridge/brain/`，一个服务、一个模型、每人一份索引） | `pip install fastembed`，第一次运行自动下载模型；模型本身是 BAAI 的，按其许可证使用 |
| Playwright、Microsoft Edge | 抖音、电脑浏览器 | |
| [Open-Meteo](https://open-meteo.com/) | 天气和日出日落 | 免密钥 |
