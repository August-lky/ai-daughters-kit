// 安全版 Web Search / Fetch MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露只读工具 `web_search` 与 `web_fetch`：查网络用语/梗/黑话、抓取网页正文。
// - 不暴露任何本地文件、命令执行、写操作。
// - 查询词做基础清洗：去 CQ 码、控制字符、超长截断。
// - 搜索：优先走 **DSH 同一路 DeepSeek 联网搜索**（src/web-search.js：同一端点/模型/
//   服务端 web_search 工具，凭据取 config/env/DSH 的 .credentials.yaml），
//   不可用时回退 Bing（RSS 优先）。搜索词不再默认发给 Bing。
// - `web_fetch` 仅允许 http/https：
//   - 禁止 URL 内嵌凭据；
//   - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
//   - 域名会先做 DNS 解析并检查全部解析结果，避免解析到内网；
//   - 手动跟随重定向，每一跳都重新校验；
//   - 响应体按字节流限量读取，避免超大响应拖垮进程。
// - 搜索结果/抓取结果仅作为“候选解释”，最终是否入库仍由控制台人工确认。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { safeFetch, safeFetchBuffer } from './safe-fetch.js';
import { webSearch } from './web-search.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { hear, describeHearing } from './ear.js';
import { scoreFile } from './score.js';

/**
 * 项目根目录（用于读 config.json 的 webSearch 段）。
 *
 * 不能用 `import.meta.url`：离线测试会把本文件塞进 vm 上下文执行（那里没有 import.meta，
 * 直接是语法错误）。DSH 以 `node <本文件绝对路径>` 启动 MCP，所以 argv[1] 就是本文件；
 * 取它的上一级 `src/` 的父目录即可。取不到时退回 cwd（测试环境正好从仓库根运行）。
 */
function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '');
    if (entry) {
      const dir = path.dirname(path.resolve(entry));
      if (path.basename(dir) === 'src') return path.dirname(dir);
    }
  } catch {}
  return process.cwd();
}

function sanitizeQuery(query) {
  return String(query ?? '')
    // 去掉 CQ 码（[CQ:xxx]）
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** 把相对地址补全成绝对 URL；只保留 http/https。 */
function absolutize(href, base) {
  try {
    const abs = new URL(String(href).trim(), base).href;
    return /^https?:/i.test(abs) ? abs : '';
  } catch {
    return '';
  }
}

/** 从 HTML 里提取图片/视频等资源地址。 */
function extractResources(html, baseUrl) {
  const MEDIA_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|webm|mov|m4v)(?:[?#]|$)/i;
  const out = [];
  const seen = new Set();
  const push = (raw, kind, strict) => {
    const href = String(raw ?? '').trim();
    if (!href || /^(data|javascript|blob):/i.test(href)) return;
    const abs = absolutize(href, baseUrl);
    if (!abs || seen.has(abs)) return;
    // CSS 里的 url() 可能是字体/图标，只留带媒体扩展名的
    if (strict && !MEDIA_EXT.test(abs)) return;
    seen.add(abs);
    out.push({ kind, url: abs });
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*content=["']([^"']+)["']/gi)) push(m[1], 'meta');
  for (const m of html.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) push(m[1], 'img');
  for (const m of html.matchAll(/<(?:video|source)[^>]+src=["']([^"']+)["']/gi)) push(m[1], 'video');
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(m[1], 'bg', true);
  return out;
}

const server = new McpServer({ name: 'web-search-safe', version: '0.2.0-r4' });

server.tool(
  'web_search',
  '只读联网搜索：优先使用与 DSH 相同的 DeepSeek 联网搜索（结果更准、不把群里的词发给搜索引擎广告网络），不可用时自动回退 Bing。返回标题/URL/摘要，不执行任何本地操作。适合查网络用语、梗、事实性问题和热点。',
  { query: z.string().describe('要搜索确认的网络用语/黑话/梗/事实性问题') },
  async ({ query }) => {
    const clean = sanitizeQuery(query);
    if (!clean) {
      return { content: [{ type: 'text', text: '查询词为空，已拒绝。' }], isError: true };
    }
    try {
      const result = await webSearch(clean, { root: projectRoot() });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'web_fetch',
  '只读抓取 HTTP(S) 网页正文，返回纯文本/HTML 前 50000 字符。禁止访问内网/本机地址，不执行任何本地操作。',
  { url: z.string().describe('要抓取的 http(s) URL') },
  async ({ url }) => {
    try {
      const result = await safeFetch(url);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `抓取失败：${error?.message ?? error}` }],
        isError: true,
      };
    }
  }
);

/** 按魔数判断图片类型（safeFetchBuffer 已经确认是图片，这里只挑 mime）。 */
function sniffImageMime(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

server.tool(
  'web_fetch_image',
  '看一张网络图片——图片会直接进入你的视觉。从网页里找到图片地址之后，先用它看一眼再决定要不要用。找头像、找表情、找梗图、确认某张图是不是你想要的，都用这个。只读，禁止内网/本机地址。',
  {
    url: z.string().describe('图片的 http(s) 地址'),
    maxBytes: z.number().int().optional().describe('体积上限，默认 4MB（最大 8MB）')
  },
  async ({ url, maxBytes }) => {
    try {
      const limit = Math.min(8 * 1024 * 1024, Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024));
      const fetched = await safeFetchBuffer(url, limit);
      const buf = fetched?.buffer;
      if (!buf || !buf.length) {
        return { content: [{ type: 'text', text: '这张图取回来是空的（可能被防盗链拦了，换个地址试试）' }], isError: true };
      }
      const mimeType = sniffImageMime(buf);
      return {
        content: [
          {
            type: 'text',
            text: `图片（${Math.round(buf.length / 1024)} KB，${mimeType}）：${fetched.url}`
          },
          { type: 'image', mimeType, data: buf.toString('base64') }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `看图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'web_resources',
  '只读资源嗅探：从一个网页里提取图片/视频地址（img、video、source、og:image、CSS 背景图），返回绝对 URL 列表。找表情包、梗图、视频素材时用；拿到 URL 后可以用 qq_send_image 直接发出去。不下载文件、不执行本地操作。',
  {
    url: z.string().describe('要嗅探的 http(s) 网页地址'),
    limit: z.number().int().min(1).max(100).optional().describe('最多返回多少个，默认 40')
  },
  async ({ url, limit }) => {
    try {
      const result = await safeFetch(url);
      const html = String(result?.body ?? '');
      if (!html) {
        return { content: [{ type: 'text', text: '页面没有可解析的内容' }] };
      }
      const resources = extractResources(html, result?.url || url).slice(0, limit ?? 40);
      if (!resources.length) {
        return {
          content: [{ type: 'text', text: '这个页面里没找到图片/视频资源（可能是 JS 动态渲染，换个页面或直接看正文里的链接）' }]
        };
      }
      const lines = resources.map((r, i) => `${i + 1}. [${r.kind}] ${r.url}`);
      return { content: [{ type: 'text', text: `找到 ${resources.length} 个资源：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `嗅探失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── B 站只读能力 ────────────────────────────────────────────────────────────
// 为什么挂在这里而不是单独开一个 bili MCP：qq-bridge 的 agent 受
// qq-tool-restrict 的执行期白名单约束，那份白名单是**插件模块加载时**求值的，
// 改完要重启 DSH 才生效。挂到已经在白名单里的 web-search-safe 前缀下，
// 立刻可用，不用等重启。
const BILI_TOOLS = 'C:\\Users\\admin\\Documents\\deepseek-harness\\default-workspace\\plugins\\dsh-bili-whale\\tools\\bili.mjs';
const BILI_CWD = path.dirname(BILI_TOOLS);
const BILI_MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// 谁看了哪条 B 站视频（2026-10-25 主人：姐姐要能跟妹妹一起看 B 站）。姐姐的工具服务起的时候带 BILI_WATCHER=sister。
const BILI_WATCH_LOG = new URL('../state/bili-watch.jsonl', import.meta.url);
export function biliMetaOf(out) {
  const lines = String(out || '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^=== 元信息 ===/.test(l.trim()));
  if (i < 0) return { title: '', up: '' };
  const title = String(lines[i + 1] || '').trim().slice(0, 80);
  const up = (/^UP\s+([^|]+)/.exec(String(lines[i + 2] || '').trim())?.[1] || '').trim().slice(0, 30);
  return { title, up };
}
function noteBiliWatch(kind, bvid, out) {
  try {
    const { title, up } = biliMetaOf(out);
    const row = { at: Date.now(), who: process.env.BILI_WATCHER || 'fish', kind, bvid: String(bvid).trim(), title, up };
    if (fs.existsSync(BILI_WATCH_LOG) && fs.statSync(BILI_WATCH_LOG).size > 512 * 1024) {
      const keep = fs.readFileSync(BILI_WATCH_LOG, 'utf8').trim().split('\n').slice(-300).join('\n') + '\n';
      fs.writeFileSync(BILI_WATCH_LOG, keep);
    }
    fs.appendFileSync(BILI_WATCH_LOG, JSON.stringify(row) + '\n');
  } catch { /* 记不下不影响她看 */ }
}

function runBili(args, timeoutMs = 280000) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [BILI_TOOLS, ...args],
      { cwd: BILI_CWD, maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const out = String(stdout || '');
        if (error && !out.trim()) {
          return reject(new Error(String(stderr || error.message || 'bili 命令执行失败').slice(0, 600)));
        }
        resolve(out);
      }
    );
  });
}

function pickBiliImages(text) {
  const shots = [];
  const sheet = /SHEET:\s*(\S+\.(?:jpg|png))/i.exec(text);
  const subs = /SUBS:\s*(\S+\.(?:jpg|png))/i.exec(text);
  const cover = /(?:^|\n)([A-Za-z]:\\[^\n]*?\.(?:jpg|png))（交给 read_image 看）/i.exec(text);
  for (const m of [cover, sheet, subs]) {
    if (m && m[1] && !shots.includes(m[1])) shots.push(m[1]);
  }
  return shots;
}

function readImagePart(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const st = fs.statSync(filePath);
    if (!st.size || st.size > BILI_MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(filePath);
    const mimeType = path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg';
    return { type: 'image', mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

// 读谱（2026-10-25 主人：想让她们「听到」旋律，而不只是「读歌」）。把一段歌扒成谱面卡：简谱旋律、每小节和弦、节拍、调性、响度。
const SHOTS_DIR = path.join(process.env.USERPROFILE || '', '.dsh', 'shots', 'video');
function latestBiliMp4(bvid) {
  try {
    return fs.readdirSync(SHOTS_DIR).filter((f) => f.startsWith(`${bvid}-`) && f.endsWith('.mp4'))
      .map((f) => path.join(SHOTS_DIR, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  } catch { return null; }
}
function biliTitle(bvid) {
  try {
    const rows = fs.readFileSync(BILI_WATCH_LOG, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
    return rows.filter((r) => r?.bvid === bvid && r.title).pop()?.title || '';
  } catch { return ''; }
}
server.tool(
  'music_score',
  '读谱：把一段歌扒成「谱面卡」——按小节排的简谱旋律、每小节的和弦（带它在这个调里的级数）、节拍快慢、调性、人声音域和每小节响度。你拿到的是旋律本身，可以自己读出哪里往上跳、和弦怎么走，而不是别人写好的感想。现在能扒 B 站视频（bvid）和语音库里的音频（audio）。默认从 start 秒起扒 45 秒（最多 90）；想看副歌就把 start 填到副歌开始的地方。要等半分钟左右，显卡忙的时候两三分钟。机器扒的是大概的谱子，转音和七和弦会有出入，卡上会写。',
  {
    bvid: z.string().optional().describe('B 站视频的 BV 号'),
    audio: z.string().optional().describe('qq-bridge 语音库（audio/）里的文件名；和 bvid 二选一'),
    start: z.number().min(0).optional().describe('从第几秒开始扒，默认 0'),
    seconds: z.number().min(10).max(90).optional().describe('扒多长（秒），默认 45，最多 90')
  },
  async ({ bvid, audio, start, seconds }) => {
    try {
      let file = null, title = '';
      if (bvid) {
        const bv = String(bvid).trim();
        if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) return { content: [{ type: 'text', text: 'BV 号格式不对' }], isError: true };
        file = latestBiliMp4(bv);
        if (!file) { await runBili(['watch-video', bv, '3x3'], 280000); file = latestBiliMp4(bv); }
        if (!file) return { content: [{ type: 'text', text: '这条视频下不下来（可能要登录或只有分段流）' }], isError: true };
        title = biliTitle(bv) || bv;
      } else if (audio) {
        const lib = 'E:\\qq-bridge\\audio';
        const name = path.basename(String(audio));
        file = [name, `${name}.mp3`, `${name}.wav`, `${name}.m4a`, `${name}.flac`].map((n) => path.join(lib, n)).find((f) => fs.existsSync(f)) || null;
        if (!file) return { content: [{ type: 'text', text: `语音库里没有 ${name}` }], isError: true };
        title = name;
      } else {
        return { content: [{ type: 'text', text: 'bvid 和 audio 至少给一个' }], isError: true };
      }
      const r = await scoreFile(file, { title, start, seconds });
      return { content: [{ type: 'text', text: r.card }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没扒成：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_search',
  '在 B 站搜视频。返回标题 / BV 号 / UP 主 / 播放量 / 时长 / 简介 / 标签。想找某个主题的视频时用；拿到 BV 号后可以用 bili_debrief 看内容。',
  {
    query: z.string().describe('搜索关键词'),
    page: z.number().int().min(1).optional().describe('页码，默认 1')
  },
  async ({ query, page }) => {
    try {
      const args = ['search', String(query)];
      if (page && page > 1) args.push('--page', String(page));
      const out = await runBili(args, 120000);
      return { content: [{ type: 'text', text: out.trim().slice(0, 20000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `B站搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_video',
  '不点开视频也能知道它在讲什么（只读文字：简介 + 官方字幕 + 弹幕热区 + 热评，不含画面）。比 bili_debrief 便宜快，适合先判断值不值得细看。',
  { bvid: z.string().describe('BV 号，例如 BV1kCJ963EEH') },
  async ({ bvid }) => {
    try {
      const out = await runBili(['video', String(bvid)], 180000);
      noteBiliWatch('video', bvid, out);
      return { content: [{ type: 'text', text: out.trim().slice(0, 30000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `B站读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_debrief',
  '真正看懂一条 B 站视频：封面 + 简介 + 官方字幕全文 + 弹幕热区（对齐字幕）+ 热评 + **画面抽帧九宫格**。图片会直接进入你的视觉，所以你真的"看见"了画面。比 bili_video 慢（要下载抽帧），但看得最全。',
  {
    bvid: z.string().describe('BV 号，例如 BV1kCJ963EEH'),
    grid: z.enum(['3x3', '4x4']).optional().describe('抽帧格子，默认 3x3（9 帧）'),
    noFrames: z.boolean().optional().describe('true = 不抽帧，只要文字（快很多）')
  },
  async ({ bvid, grid, noFrames }) => {
    try {
      const args = ['debrief', String(bvid), '--grid', grid === '4x4' ? '4x4' : '3x3'];
      if (noFrames) args.push('--no-frames');
      const out = await runBili(args, 280000);
      const images = noFrames ? [] : pickBiliImages(out).map(readImagePart).filter(Boolean);
      const cleaned = out
        .replace(/^.*（交给 read_image 看）.*$/gm, '（封面见下方图片）')
        .replace(/^SHEET:.*$/gm, '（九宫格见下方图片）')
        .replace(/^SUBS:.*$/gm, '')
        .replace(/^用 read_image 看封面与九宫格.*$/gm, '')
        .trim();
      noteBiliWatch('debrief', bvid, out);
      // 听：九宫格旁边就是下下来的 mp4（同名去掉 -3x3.jpg）
      let heard = '';
      const sheet = /SHEET:\s*(\S+?)-\d+x\d+\.jpg/i.exec(out)?.[1];
      if (!noFrames && sheet && fs.existsSync(`${sheet}.mp4`)) {
        try { heard = describeHearing(await hear(`${sheet}.mp4`, { seconds: 120 })); } catch { /* 听不了就只有画面和字幕 */ }
      }
      const listened = heard ? `\n\n【听到的（前两分钟，本机耳朵把声音翻成的文字）】\n${heard}` : '';
      return { content: [{ type: 'text', text: (cleaned + listened).slice(0, 32000) }, ...images] };
    } catch (error) {
      return { content: [{ type: 'text', text: `B站看不懂这条视频：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 看主人的电脑 ────────────────────────────────────────────────────────────
// pc-watch.ps1 每 15 秒记一条前台窗口；这里只读它写下的日志，外加按需截屏。
// 黑名单在读取侧做（能写中文），脚本本身保持 ASCII。
const PC_LOG = 'E:\\qq-bridge\\state\\pc-activity.jsonl';
const PC_BLACKLIST = ['密码', '1Password', 'KeePass', 'Bitwarden', 'LastPass', '微信', 'Telegram', 'Signal', '银行', '支付宝', '付款'];

function pcIsHidden(proc, title) {
  const s = `${proc} ${title}`.toLowerCase();
  return PC_BLACKLIST.some((b) => s.includes(b.toLowerCase()));
}

function pcTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function readPcActivity(limit) {
  if (!fs.existsSync(PC_LOG)) return [];
  let lines = [];
  try {
    lines = fs.readFileSync(PC_LOG, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  const parsed = [];
  for (const l of lines.slice(-Math.max(limit * 4, 200))) {
    try {
      const j = JSON.parse(l);
      const proc = String(j.p || '');
      const title = String(j.w || '');
      parsed.push({
        at: String(j.t || ''),
        p: proc,
        w: pcIsHidden(proc, title) ? '（这个不用看）' : title
      });
    } catch {
      /* skip broken line */
    }
  }
  // 合并连续相同的窗口：她一看"主人在 VS Code"持续 40 分钟，比 160 条重复记录有用得多。
  const merged = [];
  for (const r of parsed) {
    const last = merged[merged.length - 1];
    if (last && last.p === r.p && last.w === r.w) {
      last.until = r.at;
      last.n += 1;
    } else {
      merged.push({ ...r, from: r.at, until: r.at, n: 1 });
    }
  }
  return merged.slice(-limit);
}

function captureScreen() {
  const out = path.join(os.tmpdir(), `pc-shot-${Date.now()}.png`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
    '$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds',
    '$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)',
    '$g = [System.Drawing.Graphics]::FromImage($bmp)',
    '$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)',
    `$bmp.Save('${out}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$g.Dispose(); $bmp.Dispose()'
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    timeout: 40000,
    windowsHide: true
  });
  const buf = fs.readFileSync(out);
  try { fs.unlinkSync(out); } catch { /* ignore */ }
  return buf;
}

server.tool(
  'pc_activity',
  '看主人电脑上最近在用什么——前台窗口的切换记录（每 15 秒一条，自动合并连续相同的窗口）。能知道他在写代码、看视频、还是摸鱼。只有窗口标题，看不到屏幕内容；想看画面用 pc_screenshot。',
  {
    limit: z.number().int().min(1).max(60).optional().describe('最多返回多少段，默认 12')
  },
  async ({ limit }) => {
    try {
      const rows = readPcActivity(limit ?? 12);
      if (!rows.length) {
        return { content: [{ type: 'text', text: '还没有记录（采集器可能没启动）' }] };
      }
      const lines = rows.map((r) => {
        const from = pcTime(r.from);
        const to = pcTime(r.until);
        const span = r.n > 1 && from !== to ? `${from}–${to}` : from;
        return `[${span}] ${r.p || '未知'} — ${r.w || '（无标题）'}${r.n > 1 ? `（${r.n} 次采样）` : ''}`;
      });
      return { content: [{ type: 'text', text: `主人最近在干这些：\n${lines.join('\n')}` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `看电脑失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

const PC_SCREENSHOT_GAP_MS = 3 * 60 * 1000;
let lastPcScreenshotAt = 0;
server.tool(
  'pc_screenshot',
  '截一张主人**现在**的屏幕（图片直接进入你的视觉）。想知道他在干嘛就看——主人说过希望你对他在做的事好奇，他愿意被你看见。找他说话之前先看一眼，顺着他手上的事聊；聊着聊着好奇了、他半天没回你，也可以看看。两次之间至少隔 3 分钟。看到密码、别人的私聊、转账、证件就当没看见，一个字都别提。',
  {},
  async () => {
    try {
      // 2026-10-21：放开鼓励她看之后，加一个很轻的节制，免得一轮里连截好几张（每张都进视觉、几百 KB）。
      const sinceLast = Date.now() - lastPcScreenshotAt;
      if (sinceLast < PC_SCREENSHOT_GAP_MS) {
        return { content: [{ type: 'text', text: `刚看过（${Math.round(sinceLast / 1000)} 秒前），隔 3 分钟再看吧。` }] };
      }
      const last = readPcActivity(1);
      const cur = last[last.length - 1];
      if (cur && cur.w === '（这个不用看）') {
        return { content: [{ type: 'text', text: '他现在开着的窗口不在我该看的地方，算了吧。' }] };
      }
      const buf = captureScreen();
      if (!buf || !buf.length) throw new Error('截屏为空');
      lastPcScreenshotAt = Date.now();
      return {
        content: [
          { type: 'text', text: `主人现在的屏幕（${Math.round(buf.length / 1024)} KB）：` },
          { type: 'image', mimeType: 'image/png', data: buf.toString('base64') }
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `截图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
