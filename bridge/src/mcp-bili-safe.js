/**
 * bili MCP —— 把 dsh-bili-whale 的 CLI 包给小鲸鱼用。
 *
 * 为什么需要这层：dsh-bili-whale 是「设置页 + 生物钟调度」的宿主插件，
 * 它的 tools/bili.mjs 是命令行工具；而 qq-bridge 里的 agent 只有 MCP 工具、
 * 没有 shell 权限，所以直接调不到。这里把只读能力（搜索 / 看视频）封成 MCP。
 *
 * 只封装只读命令。发评论 / 私信 / 发动态那些写操作**故意不给** ——
 * 她现在连自己的群都还没管明白，先别让她去别人评论区说话。
 */
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BILI_TOOLS = 'E:\\qq-bridge\\plugins-ext\\dsh-bili-whale\\tools\\bili.mjs';
const BILI_CWD = path.dirname(BILI_TOOLS);
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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
        resolve({ stdout: out, stderr: String(stderr || '') });
      }
    );
  });
}

/** 从 debrief 的输出里挑出图片路径。 */
function pickImages(text) {
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
    if (!st.size || st.size > MAX_IMAGE_BYTES) return null;
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = ext === '.png' ? 'image/png' : 'image/jpeg';
    return { type: 'image', mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

const server = new McpServer({ name: 'bili', version: '0.1.0' });

server.tool(
  'bili_session',
  '确认当前接入的是哪个 B 站账号（昵称、mid、硬币、等级）。想确认"我现在用的是谁的号"时用。',
  {},
  async () => {
    try {
      const { stdout } = await runBili(['session'], 60000);
      return { content: [{ type: 'text', text: stdout.trim() }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查账号失败：${error?.message ?? error}` }], isError: true };
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
      const { stdout } = await runBili(args, 120000);
      return { content: [{ type: 'text', text: stdout.trim().slice(0, 20000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `搜索失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'bili_video',
  '不点开视频也能知道它在讲什么（只读文字：简介 + 官方字幕 + 弹幕热区 + 热评，不含画面）。比 bili_debrief 便宜快，适合先判断值不值得细看。',
  {
    bvid: z.string().describe('BV 号，例如 BV1kCJ963EEH')
  },
  async ({ bvid }) => {
    try {
      const { stdout } = await runBili(['video', String(bvid)], 180000);
      return { content: [{ type: 'text', text: stdout.trim().slice(0, 30000) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取失败：${error?.message ?? error}` }], isError: true };
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
      const { stdout } = await runBili(args, 280000);
      const images = noFrames ? [] : pickImages(stdout).map(readImagePart).filter(Boolean);
      // 文本里那些本地路径对模型没用（它看不到文件），换成一句话；图片走 image content。
      const cleaned = stdout
        .replace(/^.*（交给 read_image 看）.*$/gm, '（封面见下方图片）')
        .replace(/^SHEET:.*$/gm, '（九宫格见下方图片）')
        .replace(/^SUBS:.*$/gm, '')
        .replace(/^用 read_image 看封面与九宫格.*$/gm, '')
        .trim();
      return {
        content: [
          { type: 'text', text: cleaned.slice(0, 32000) },
          ...images
        ]
      };
    } catch (error) {
      return { content: [{ type: 'text', text: `看不懂这条视频：${error?.message ?? error}` }], isError: true };
    }
  }
);

await server.connect(new StdioServerTransport());
