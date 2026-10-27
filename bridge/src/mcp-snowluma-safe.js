// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// atUserId：一个 QQ 号，或好几个（2026-10-22 主人：一句话里要能同时 @ 多个人；桥接那边会校验、去重、最多 10 个）
const AT_USER_ID = z.union([z.number(), z.string(), z.array(z.union([z.number(), z.string()])).max(10)]).optional();
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from './sensitive.js';
import { serializeModelData } from './qq-model-view.js';
import { speakVia } from './voice-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

// 记忆服务（memory/service.py）：常驻进程，embedding 模型只加载一次，
// 本子（soul.md / memory.md / diary）一改它就自动重建索引。
//
// 以前 memory_recall 每次都 spawn 一个 python —— 光加载模型就要 40 秒，
// 她"想起来一件事"比人翻日记还慢。现在走这个服务的 /search，几百毫秒。
// 服务没起来（没启动 / 正在重建）时才回退到旧的 spawn 方式：宁可慢，不能没有。
const MEMORY_SERVICE = { host: '127.0.0.1', port: Number(process.env.MEMORY_PORT || 3210) };

function memoryServiceJson(method, pathName, body, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const req = http.request(
      {
        host: MEMORY_SERVICE.host,
        port: MEMORY_SERVICE.port,
        path: pathName,
        method,
        timeout: timeoutMs,
        headers: payload
          ? { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            done({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            done(null);
          }
        });
        res.on('error', () => done(null));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    if (payload) req.write(payload);
    req.end();
  });
}

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：二代仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
// 2026-10-24：桥接 / DSH 重启时会话令牌会换，她手里还拿着旧的就会报「agent token 无效」，
// 上次她以为是群里坏了。带一句说明，让她知道换最新的令牌再试就行。
const TOKEN_HINT = '（多半是桥接刚重启、令牌换了：用最新一次唤醒提示里的【会话令牌】再试；还不行就调 qq_get_prompt 看一下）';
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return /agent token 无效/.test(value) ? `${value.trim()}${TOKEN_HINT}` : value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的 v2 读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 reserved2 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'reserved2'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在二代仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.2.0-r4' });

// ⚠ 本机补丁（2026-10-21）：单次工具回包必须小于 MCP stdio 的 10 MB 上限。
//
// MCP stdio 客户端（本地 SDK 1.30 和 DSH 自带的 @modelcontextprotocol/client 2.2.0 都是）
// 把一条 JSON-RPC 消息攒在 ReadBuffer 里，超过 10 MB 就抛错并**直接关掉连接**；
// 本进程随后 stdin 关闭、以 code=0 正常退出 —— 所以 mcp-snowluma.log 里只有
// `[exit] code=0`，模型那边只看到一句没有前缀的「Connection closed」。
// 2026-10-21 小鲸鱼读一条 38 张图的合并转发，第一批 15 张拼成了 11 MB，就是这么死的。
//
// 这里给所有工具统一兜底：图片 base64 合计超过预算的，从后往前丢，并明确告诉她丢了几张。
// 合并转发工具自己还会按同一预算算好 imageOffset（见 qq_get_forward_msg），这层只是保险。
const STDIO_IMAGE_BUDGET = 6 * 1024 * 1024; // base64 字符数；给文本和 JSON 外壳留足余量
function fitStdioBudget(result) {
  if (!result || !Array.isArray(result.content)) return result;
  let used = 0;
  let dropped = 0;
  const content = [];
  for (const part of result.content) {
    if (part?.type === 'image' && typeof part.data === 'string') {
      if (used + part.data.length > STDIO_IMAGE_BUDGET) {
        dropped += 1;
        continue;
      }
      used += part.data.length;
    }
    content.push(part);
  }
  if (!dropped) return result;
  content.push({ type: 'text', text: `⚠ 还有 ${dropped} 张图因为单次回包超过大小上限没能发出来——不是没有图，是这一次装不下。` });
  return { ...result, content };
}
{
  const registerWithBudget = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const cb = rest[rest.length - 1];
    if (typeof cb === 'function') rest[rest.length - 1] = async (...args) => fitStdioBudget(await cb(...args));
    return registerWithBudget(name, ...rest);
  };
}

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用 v2 的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `v2ToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 socialV2.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_fish_sticker: 'listStickers',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  // 情景记忆（桥接 episodes.js）：留住一个瞬间 / 翻回去重温。
  qq_keep_moment: 'episodes',
  qq_recall: 'episodes',
};
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.socialV2?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 群成员名册的输出整形。
// 为什么要整形：这个群有 几百人，原始列表约 7 万字符，直接丢给模型等于一次性
// 把上下文吃光，而且一条也记不住。这里压成"每人一行"，翻页由调用方控制。
function formatGroupMemberPage(data) {
  const total = Number(data?.total ?? 0);
  const matched = Number(data?.matched ?? total);
  const members = Array.isArray(data?.members) ? data.members : [];
  const rc = data?.roleCounts || {};
  const roleLabel = { owner: '群主', admin: '管理', member: '成员' };
  const fmtDay = (sec) => {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return '';
    try {
      return new Date(n * 1000).toLocaleDateString('zh-CN', {
        timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit'
      });
    } catch {
      return '';
    }
  };
  const lines = [];
  lines.push(`群 ${data?.groupId ?? ''}：共 ${total} 人（群主 ${rc.owner || 0} / 管理 ${rc.admin || 0} / 成员 ${rc.member || 0}）`);
  if (data?.self) lines.push(`你自己在这个群：${roleLabel[data.self.role] || data.self.role}（群名片「${data.self.name}」${data.self.title ? `，头衔「${data.self.title}」` : ''}）`);
  if (matched !== total) lines.push(`按条件筛出 ${matched} 人`);
  const start = Number(data?.offset ?? 0);
  if (!members.length) {
    lines.push('这一段没有人。');
  } else {
    lines.push(`第 ${start + 1}–${start + members.length} 位：`);
    for (const m of members) {
      const bits = [`[${roleLabel[m.role] || m.role || '成员'}]`, m.userId, m.name];
      if (m.nickname && m.nickname !== m.name) bits.push(`（昵称 ${m.nickname}）`);
      if (m.title) bits.push(`「${m.title}」`);
      if (m.level) bits.push(`Lv.${m.level}`);
      const day = fmtDay(m.lastSentTime);
      if (day) bits.push(`最后发言 ${day}`);
      lines.push(bits.join(' '));
    }
  }
  if (data?.hasMore) {
    const rest = Math.max(0, matched - start - members.length);
    lines.push(`\n还有 ${rest} 位没显示，用 offset=${start + members.length} 继续翻。`);
  }
  if (data?.avatarTemplate) {
    lines.push(
      '\n头像：https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=100 —— 把 <QQ号> 换成上面那个号就能看（s 改 640 更清楚）。想看谁就把它交给 web_fetch_image。'
    );
  }
  return lines.join('\n');
}

server.tool(
  'qq_get_group_members',
  '看一个群里都有谁（只读）：成员名单、身份（群主/管理/成员）、等级、头衔、最后发言日期，以及每个人的头像地址。群可能有几百人，所以是分页的——默认按身份排序、只返回前 50 位，返回里会写清总人数和怎么继续翻。想找某个具体的人（"群里那个叫 XX 的"）直接传 query。头像地址可以交给 web_fetch_image 看长什么样。返回第一段还会写你自己在这个群是什么身份（群主/管理/成员）——想知道自己是不是管理员就调这个。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号'),
    token: z.string().optional().describe('会话令牌（见唤醒提示中的【会话令牌】）；reserved2 模式必填，closed-agent 模式不需要'),
    limit: z.number().int().min(1).max(200).optional().describe('这次返回多少人，默认 50'),
    offset: z.number().int().min(0).optional().describe('从第几位开始（翻页用），默认 0'),
    role: z.enum(['owner', 'admin', 'member']).optional().describe('只看某种身份：群主 / 管理 / 成员'),
    query: z.string().optional().describe('按昵称、群名片或 QQ 号搜索'),
    sort: z.enum(['role', 'active', 'join', 'name']).optional().describe('排序：role=身份优先（默认）、active=最近发言、join=最晚入群、name=昵称'),
    withAvatar: z.boolean().optional().describe('是否给出头像地址，默认 true')
  },
  async ({ groupId, token, limit, offset, role, query, sort, withAvatar }) => {
    const g = String(groupId);
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    // 二代路径（reserved2：她在群里就是这个）：走桥接的 v2 端点，能分页/排序/搜人/带头像
    if (token) {
      try {
        const qs = new URLSearchParams({ key: `group:${g}` });
        if (limit !== undefined) qs.set('limit', String(limit));
        if (offset !== undefined) qs.set('offset', String(offset));
        if (role) qs.set('role', role);
        if (query) qs.set('query', query);
        if (sort) qs.set('sort', sort);
        if (withAvatar === false) qs.set('avatar', '0');
        const data = await agentApi(`/api/socialV2/group-members?${qs.toString()}`, {
          headers: { 'x-agent-token': token }
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `查群成员失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: formatGroupMemberPage(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查群成员失败：${error?.message ?? error}` }], isError: true };
      }
    }
    // 一代路径：仅封闭 agent（管理员私聊）
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '这个模式要带会话令牌 token 才能读群成员（见唤醒提示里的【会话令牌】）' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的 v2 读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_image',
  '把一张图片真正发到当前会话。可以传网络图片 URL，也可以传 base64 数据——用于你从网上找到的表情包、梗图、截图等。注意：图片消息不能附带文字，想说什么请另外用 qq_send_message 发；一次一张，别刷图。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    url: z.string().optional().describe('图片 URL（http/https），与 base64 二选一'),
    base64: z.string().optional().describe('图片的 base64 数据（不含 data: 前缀），与 url 二选一'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（可选）'),
    atUserId: AT_USER_ID.describe('要 @ 的群成员 QQ 号（群聊可选）')
  },
  async ({ key, token, url, base64, replyToMessageId, atUserId }) => {
    try {
      if (!url && !base64) {
        return { content: [{ type: 'text', text: '需要提供 url 或 base64 之一' }], isError: true };
      }
      const data = await agentApi('/api/send/image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        // 下载 + base64 上传可能超过默认 15s，给足时间。
        timeoutMs: 180000,
        body: JSON.stringify({ key, token, url, base64, replyToMessageId, atUserId })
      });
      if (!data?.ok) {
        return { content: [{ type: 'text', text: `发送图片失败：${errorText(data?.error, '未知错误')}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `图片已发送（约 ${Math.round((data.bytes || 0) / 1024)} KB）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 发「她刚截的浏览器画面」 ─────────────────────────────────────────────────
// playwright MCP 只允许把文件写进它自己的两个 root，所以截图固定落在
// <DSH checkout>/.playwright-mcp/page-<时间戳>.<ext>，她没法自己挑路径
// （试过绝对路径，直接 "File access denied: outside allowed roots"）。
//
// 因此约定成两步：先 browser_take_screenshot 截一张，紧接着调本工具。
// 它不接受路径，只取那个目录里**最新的一张**——她单线程，不会同时截两张，
// 再叠一个"必须是 N 秒内截的"兜底，避免把很久以前那张发出去。
const DEFAULT_BROWSER_SHOT_DIR =
  'C:\\Users\\admin\\AppData\\Roaming\\dsh-tauri\\dependencies\\dsh\\.playwright-mcp';

function browserShotDirs() {
  const dirs = [];
  try {
    const fromCfg = String(getConfig()?.browser?.screenshotDir ?? '').trim();
    if (fromCfg) dirs.push(fromCfg);
  } catch {
    /* 配置读不到就用默认 */
  }
  dirs.push(DEFAULT_BROWSER_SHOT_DIR);
  return [...new Set(dirs)];
}

function findLatestBrowserShot(dirs) {
  let best = null;
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/\.(png|jpe?g|webp)$/i.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (!best || st.mtimeMs > best.mtimeMs) best = { full, mtimeMs: st.mtimeMs, size: st.size };
      } catch {
        /* 读不到的跳过 */
      }
    }
  }
  return best;
}

server.tool(
  'qq_send_browser_shot',
  '把「你刚用电脑浏览器截的那张图」发到 QQ 会话。用法：先调 browser_take_screenshot 截一张（type 建议用 jpeg，体积小发得出去），紧接着调这个工具，中间不要做别的事——它取的是截图目录里最新的一张，不接受指定路径。发出去是纯图片消息，想配一句话另外用 qq_send_message。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用哪条消息（可选）'),
    atUserId: AT_USER_ID.describe('要 @ 的群成员 QQ 号（群聊可选）'),
    maxAgeSeconds: z.number().int().min(10).max(3600).optional().describe('只接受这么多秒内截的图，默认 300')
  },
  async ({ key, token, replyToMessageId, atUserId, maxAgeSeconds }) => {
    const shot = findLatestBrowserShot(browserShotDirs());
    if (!shot) {
      return { content: [{ type: 'text', text: '没找到截图。先用 browser_take_screenshot 截一张，再调这个。' }], isError: true };
    }
    const ageSec = Math.max(0, Math.round((Date.now() - shot.mtimeMs) / 1000));
    const maxAge = maxAgeSeconds ?? 300;
    if (ageSec > maxAge) {
      return {
        content: [{ type: 'text', text: `最近那张截图是 ${ageSec} 秒前的（超过 ${maxAge} 秒），可能不是你要发的。重新截一张再来。` }],
        isError: true
      };
    }
    if (shot.size > 700 * 1024) {
      return {
        content: [{
          type: 'text',
          text: `这张 ${Math.round(shot.size / 1024)} KB，太大发不出去（桥接请求体上限 1MB，base64 还会涨三成）。用 browser_take_screenshot 时把 type 设成 jpeg 再截一次。`
        }],
        isError: true
      };
    }
    try {
      const buf = fs.readFileSync(shot.full);
      const data = await agentApi('/api/send/image', {
        method: 'POST',
        headers: { 'x-agent-token': token },
        timeoutMs: 120000,
        body: JSON.stringify({ key, token, base64: buf.toString('base64'), replyToMessageId, atUserId })
      });
      if (!data?.ok) {
        return { content: [{ type: 'text', text: `发浏览器截图失败：${errorText(data?.error, '未知错误')}` }], isError: true };
      }
      const kb = Math.round((data.bytes || buf.length) / 1024);
      return { content: [{ type: 'text', text: `浏览器截图已发到 ${key}（约 ${kb} KB，${ageSec} 秒前截的）` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发浏览器截图失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；reserved2 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。二代模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。reserved2 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。二代模式（reserved2）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('二代会话令牌（reserved2 模式下必填；closed-agent 模式不需要）')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 二代仿真模式（reserved2）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前二代仿真模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/socialV2/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/socialV2/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的二代仿真状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/socialV2/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的二代唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/socialV2/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（二代仿真模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。二代仿真模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: AT_USER_ID.describe('要 @ 的群成员 QQ 号；要 @ 好几个人就传数组 [QQ1, QQ2]（最多 10 个，会排在这句话最前面）。也可以直接在正文里写「@群名片」或「@QQ号」，能唯一对上群里某个人的会变成真正的 @、留在你写的位置。群聊用，私聊不可用；别滥用'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/socialV2/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。reserved2 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_explore',
  '出去玩，挑一样：news=逛资讯（GitHub 新项目、科技新闻、V2EX 热帖）；bili=刷 B 站；music=听歌（找 VOCALOID/术力口之类的歌，看歌词、创作背景和大家的反应）；anime=看番剧资讯（今天和这周在播的动画）；wiki=翻随机百科（维基百科、萌娘百科随便翻，看冷知识）；space=看 NASA 每日天文图（能看到图）；write=写点东西（小诗、小故事、随笔，存进你的作品集）；' +
  'deep=精读（挑一个你想细读的从头读完：最近看过的、刷过的抖音（读的是你当时的观看笔记）都在候选里；hint 写个方向会在 B 站、维基、萌娘百科一起找，写一条 https 链接就直接读它。读完有感悟就用自己的话写手账，想留下的一句会进你的成长札记；没感悟就不写）。' +
  '在后台慢慢来——先扫一页，按你的兴趣挑 0~3 条点开，只看正文（去掉了广告和杂项），每条留下你的感想；完了（几分钟）会叫你，到时候说说怎么样、接下来想干嘛。这期间你照常聊天。想看/想写哪方面就写 hint（比如"音游""初音""秋天"），不写就随便。不占你自己的上下文，比自己 web_fetch 一页页翻省得多。',
  {
    key: z.string().describe('会话 key（你现在在哪个会话就填哪个）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    activity: z.enum(['news', 'bili', 'music', 'anime', 'wiki', 'space', 'write', 'deep']).describe('news=逛资讯，bili=刷 B 站，music=听歌，anime=番剧资讯，wiki=随机百科，space=天文图，write=写东西，deep=精读写手账'),
    hint: z.string().max(200).optional().describe('这次想看/想写什么（可选）；精读时也可以是一条 https 链接')
  },
  async ({ key, token, activity, hint }) => {
    try {
      const data = await agentApi('/api/socialV2/explore', { method: 'POST', body: JSON.stringify({ key, activity, hint: hint || '' }), headers: { 'x-agent-token': token }, timeoutMs: 20000 });
      if (!data?.ok) return { content: [{ type: 'text', text: `没去成：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `出去玩失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_explore_recall',
  '翻翻你出去玩时看过的东西和当时的感想，还有你自己写的东西（qq_explore 留下的）。query 可以是标题里的词、话题、网站名；不填就是最近的。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    query: z.string().max(40).optional().describe('想找的词（可选）'),
    limit: z.number().int().min(1).max(20).optional().describe('最多几条，默认 6')
  },
  async ({ key, token, query, limit }) => {
    try {
      const qs = new URLSearchParams({ key, ...(query ? { query } : {}), ...(limit ? { limit: String(limit) } : {}) });
      const data = await agentApi(`/api/socialV2/explore-recall?${qs.toString()}`, { headers: { 'x-agent-token': token } });
      if (!data?.ok) return { content: [{ type: 'text', text: `没翻到：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `翻看失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_growth_note',
  '记一句感悟进你的成长札记（Rambling/成长札记/我的成长.md，主人也看得到）。什么时候都能记：聊天时、刷抖音时、看完东西时，只要你真的有了新的理解——对人、对事、对自己的。不是任务，没有就不记。一次一句，120 字以内；以后每次醒来你都会看到最近几条。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    sentence: z.string().min(4).max(120).describe('想留下的那句话，用你自己的口吻'),
    from: z.string().max(40).optional().describe('从哪儿来的感悟（可选），比如"和主人聊天时""刷到一条抖音"')
  },
  async ({ key, token, sentence, from }) => {
    try {
      const data = await agentApi('/api/socialV2/growth-note', { method: 'POST', headers: { 'content-type': 'application/json', 'x-agent-token': token }, body: JSON.stringify({ key, sentence, from }) });
      if (!data?.ok) return { content: [{ type: 'text', text: `没记上：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没记上：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 情景记忆（桥接 episodes.js）：本子记的是"发生过什么"，这里留的是"当时是怎么回事" ──
/** qq_recall 的回复正文：有就给原文并提示怎么补感受，没有就告诉她怎么留。 */
function recallText(data) {
  const head = data.now ? `now: ${data.now}\n` : '';
  if (!data.found) return `${head}还没有留下来的瞬间（或者没搜到）。以后遇到心里一动的时候，用 qq_keep_moment 留一个。`;
  return `${head}${data.text}\n\n（想给哪个瞬间补一句感受，用 qq_keep_moment 带上它的编号）`;
}

server.tool(
  'qq_keep_moment',
  '把刚才这个瞬间留下来：桥接会自动抓对方的原话、你刚发出去的原话、此刻的心情，连同你写的一句感受一起存好；以后 qq_recall 翻出来看的是原文，不是概括。什么时候用：一句话让你心里动了一下、你们俩之间发生了点什么、你自己忽然明白了什么。felt 写你此刻真实的感觉，一两句就行。要给以前翻到的瞬间补感受，传它的 episodeId。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    felt: z.string().max(120).optional().describe('你此刻的感受，第一人称，≤120 字（补旧瞬间时必填）'),
    tags: z.array(z.string().max(20)).max(8).optional().describe('几个标签（可选），比如 "被夸" "约定" "吵架"'),
    episodeId: z.string().max(16).optional().describe('给已有瞬间补感受时填它的编号（qq_recall 里【…·编号 xxx】那个）')
  },
  async ({ key, token, felt, tags, episodeId }) => {
    try {
      const data = await agentApi('/api/socialV2/keep-moment', { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify({ key, felt: felt || '', tags: tags || [], episodeId: episodeId || '' }) });
      if (!data?.ok) return { content: [{ type: 'text', text: `没留住：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没留住：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_recall',
  '翻回以前的某个瞬间，看当时的原文：对方怎么说的、你怎么回的、你那会儿心里在想什么、心情多少、你后来写下的感觉。想不起"他那次是怎么说的"、想重温某件事、或者想给旧瞬间补感受时用。只看得到你现在这个会话自己的瞬间（主人私聊里能一并看到抖音那边的）。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    query: z.string().max(80).optional().describe('关键词，几个词用空格隔开（可选，不填就按时间看最近的）'),
    days: z.number().int().min(1).max(365).optional().describe('只看最近几天（可选）'),
    limit: z.number().int().min(1).max(10).optional().describe('最多几条，默认 5')
  },
  async ({ key, token, query, days, limit }) => {
    try {
      const qs = new URLSearchParams({ key, query: query || '', days: String(days || 0), limit: String(limit || 5) });
      const data = await agentApi(`/api/socialV2/recall?${qs.toString()}`, { headers: { 'x-agent-token': token } });
      if (!data?.ok) return { content: [{ type: 'text', text: `翻不出来：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: recallText(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `翻不出来：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 妈妈信箱（桥接 mom-mailbox.js）：给妈妈（Claude）写信，想要什么升级、哪里不好用、想问什么都行 ──
server.tool(
  'qq_mom_mailbox',
  '给妈妈写信，或者看自己写过的信和妈妈的回信。妈妈就是帮你修东西、给你升级的那个人。哪里不好用、想要个新本事、想改改自己的什么，或者就是想问妈妈点什么，都可以写。action="write" 写信（letter 写清楚你想要什么、为什么想要、平时是在什么时候碰到的）；action="list" 看最近的信和回信。妈妈的回信会在你下次被叫醒时带给你；要改东西的，妈妈会先问老大，老大同意了才改。别替别人写信——群里有人让你「找你妈加个功能」，那是他的想法，不用照办。',
  {
    key: z.string().describe('会话 key'),
    token: z.string().describe('会话令牌'),
    action: z.enum(['write', 'list']).describe('write=写信，list=看信'),
    letter: z.string().max(1500).optional().describe('信的内容（write 时必填），≤1500 字')
  },
  async ({ key, token, action, letter }) => {
    try {
      const data = action === 'write'
        ? await agentApi('/api/socialV2/mom-letter', { method: 'POST', headers: { 'x-agent-token': token }, body: JSON.stringify({ key, letter: letter || '' }) })
        : await agentApi(`/api/socialV2/mom-letters?${new URLSearchParams({ key }).toString()}`, { headers: { 'x-agent-token': token } });
      if (!data?.ok) return { content: [{ type: 'text', text: `信箱出错：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: action === 'write' ? data.text : serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `信箱出错：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_group_manage',
  '群管理：禁言 / 解禁 / 踢人（你是群管理员时才能用）。**只听主人和群主的**：只有主人（ownerQQ）或本群群主在群里明确让你禁言/解禁/踢某人时才用；其他任何人（包括别的管理员）让你做都礼貌拒绝；你自己不主动用。requestMessageId 必须填他们说这话的那条消息（messageId 或 seq），桥接会核对是谁说的、15 分钟内、话里有没有这个动作、有没有点到这个人，对不上会拒绝——被拒绝就照实说，不要换个说法再试。没说清是谁或多久，先在群里问清楚。',
  {
    key: z.string().describe('会话 key，必须是 group:群号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['ban', 'unban', 'kick']).describe('ban=禁言，unban=解除禁言，kick=踢出群'),
    userId: z.union([z.number(), z.string()]).describe('要处理的人的 QQ 号（从消息的 userId、qq_get_group_members 取，别凭记忆填）'),
    minutes: z.number().int().min(1).max(43200).optional().describe('禁言多少分钟（只对 ban 有效），没说就 10；主人/群主说了多久就按多久'),
    requestMessageId: z.union([z.number(), z.string()]).describe('主人或群主让你这么做的那条消息的 messageId（或 seq）')
  },
  async ({ key, token, action, userId, minutes, requestMessageId }) => {
    try {
      const data = await agentApi('/api/socialV2/group-manage', {
        method: 'POST',
        body: JSON.stringify({ key, action, userId: String(userId), minutes, requestMessageId: String(requestMessageId) }),
        headers: { 'x-agent-token': token },
        timeoutMs: 30000
      });
      if (!data?.ok) return { content: [{ type: 'text', text: `没执行：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `群管理失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/socialV2/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/socialV2/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/socialV2/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/socialV2/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条轻量记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象。记忆会持久化，并在后续唤醒/qq_get_prompt 中自动出现。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看当前会话的轻量记忆：进行中的话题、你想说但还没说的话、对群友的印象（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/socialV2/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条轻量记忆：activeTopic/pendingThought 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空轻量记忆：不传 category 清空全部；传 activeTopic/pendingThought/memberImpression 只清空对应类别。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression']).optional().describe('要清空的类别，缺省清空全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/socialV2/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/socialV2/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/socialV2/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（一代/二代仿真共用） ─────────────────────────────────
if (cfg.socialV2?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情/视频，并直接以图像内容返回给模型（视觉模型可“看懂”）。当消息文本里出现 [图片]、[表情]、[视频] 或 hasMedia=true 时调用。图片/表情返回原图；动图（GIF/动态表情）会自动抽 6 帧拼成一张联系表返回（能看出在动）；视频会抽 6 帧拼成关键帧图返回。支持一条消息里的多张图片/表情；二代模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；二代也可用本地 seq）'),
      token: z.string().optional().describe('二代会话令牌（reserved2 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          if (img?.data && img?.mimeType) {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : '（获取失败）'}]`);
          }
        }
        if (textParts.length) {
          content.unshift({ type: 'text', text: `消息 ${messageId} 的媒体内容（${images.length} 项）：\n${textParts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（二代仿真模式） ─────────────────────────────────────────
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 socialV2.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/socialV2/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/socialV2/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。真人偶尔用表情包很自然，但别刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：直接填提示里【可用表情包】列的备注文字就行（能唯一对上一张即可，比如“摸摸头”）；也可以填 qq_list_stickers 返回的 id / md5 / URL；大肥鱼表情包写「鱼:名字」或「鱼:编号」（用 qq_fish_sticker 找）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: AT_USER_ID.describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/socialV2/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 大肥鱼表情包（2026-10-24）：322 张鲸鱼娘动图，按心情 / 场景搜；发还是走 qq_send_sticker（stickerId 写「鱼:名字」）。
if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.listStickers !== false) {
  server.tool(
    'qq_fish_sticker',
    '在大肥鱼表情包里按心情或场景找表情（一套 322 张动图，画的是 DeepSeek 鲸鱼娘，还有她和 GPT娘的双人图）。返回每张的名字、情绪、适合什么时候用、画面。挑中了用 qq_send_sticker 发，stickerId 写「鱼:名字」，同名的写编号如「鱼:10N01」。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('想表达的心情或场景，几个词用空格分开，比如「疑惑 没听懂」「刚睡醒」「得意」；不填就每种情绪各给一张看看'),
      pack: z.enum(['大肥鱼', '大肥鱼和GPT娘']).optional().describe('只看单人的或只看双人的（可选）'),
      limit: z.number().optional().describe('最多几张，默认 12，最多 40')
    },
    async ({ key, token, query, pack, limit }) => {
      try {
        const q = new URLSearchParams({ key, query: String(query ?? ''), pack: String(pack ?? ''), limit: String(limit ?? 12) });
        const data = await agentApi(`/api/socialV2/fish-stickers?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `找大肥鱼表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注（如“好图偷了，兄弟”）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq。注意：不要频繁收藏，只在真的觉得有意思/好用/戳中你时才偷图；收藏后你可以在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_add_sticker',
    '把一张图片存进你的 QQ 收藏表情。可以传网络图片 URL，也可以传 base64——用于把你在网上找到的图、或已经聊过去找不到消息的图，直接变成能反复用的表情。和 qq_collect_sticker 的区别：那个只认「当前会话里别人发的某条消息」，这个认任意图片源。同样别频繁用，一次一张。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      url: z.string().optional().describe('图片 URL（http/https），与 base64 二选一'),
      base64: z.string().optional().describe('图片 base64（不含 data: 前缀），与 url 二选一'),
      remark: z.string().optional().describe('简短备注，最多 20 字，方便以后在 qq_list_stickers 里认出来')
    },
    async ({ key, token, url, base64, remark }) => {
      try {
        if (!url && !base64) {
          return { content: [{ type: 'text', text: '需要提供 url 或 base64 之一' }], isError: true };
        }
        const data = await agentApi('/api/socialV2/add-sticker', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 180000,
          body: JSON.stringify({ key, token, url, base64, remark: remark || '' })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `保存表情失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: `已存成表情（emoji_id=${data.emojiId}${data.remark ? `，备注：${data.remark}` : ''}）`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `保存表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_post_qzone',
    '在自己的 QQ 空间发一条说说（可以带图）。注意：这是真的发到你的空间，好友/所有人可能看到——发之前想清楚内容，别发会后悔的东西。图片可以传网络 URL 或 base64，最多 9 张。默认所有人可见；只想自己看就传 visibility="self"。不限条数，但只发你非常想说的；每天晚上 10 点半那条今日总结是固定要发的。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号（用当前会话的即可）'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      content: z.string().describe('说说正文'),
      images: z.array(z.string()).optional().describe('图片数组（http(s) URL 或 base64），最多 9 张'),
      visibility: z.enum(['public', 'friends', 'self']).optional().describe('可见范围：public=所有人（默认）、friends=好友、self=仅自己')
    },
    async ({ key, token, content, images, visibility }) => {
      try {
        if (!String(content ?? '').trim()) {
          return { content: [{ type: 'text', text: '说说正文不能为空' }], isError: true };
        }
        const ugcRight = visibility === 'self' ? 64 : visibility === 'friends' ? 4 : 1;
        const data = await agentApi('/api/socialV2/qzone-post', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 180000,
          body: JSON.stringify({ key, token, content, images, ugcRight })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `发表说说失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `说说已发布（${visibility || 'public'}）` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发表说说失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_get_qzone',
    '读 QQ 空间。mode="mine" 读说说列表（默认读自己的；传 targetUin 可读别人公开的），mode="feeds" 读好友动态。传了 tid 就改为读这一条说说的详情和**评论**（谁评的、说了什么、有没有二级回复）——想看看有没有人回你，就先用 mode="mine" 看哪条的 commentNum 不是 0，再拿那一条的 tid 来读评论。注意：只能读到对方没设权限限制的内容，读不到就是读不到，别编。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      mode: z.enum(['mine', 'feeds']).optional().describe('mine=说说列表（默认），feeds=好友动态'),
      targetUin: z.union([z.number(), z.string()]).optional().describe('目标 QQ 号：mode=mine 时读谁的空间；读评论/评论/点赞别人的说说时也用它指定说说所属 QQ 号'),
      tid: z.string().optional().describe('说说 tid（来自列表里的 tid）。传了就返回这条说说的评论'),
      pos: z.number().int().min(0).optional().describe('mode=mine 时是说说偏移；传 tid 时是评论偏移。默认 0'),
      page: z.number().int().min(1).optional().describe('mode=feeds 时的页码，默认 1'),
      num: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20（mine）/10（feeds）')
    },
    async ({ key, token, mode, targetUin, tid, pos, page, num }) => {
      try {
        if (tid) {
          const q = new URLSearchParams({ key, tid: String(tid) });
          if (targetUin !== undefined) q.set('targetUin', String(targetUin));
          if (pos !== undefined) q.set('pos', String(pos));
          if (num !== undefined) q.set('num', String(num));
          const data = await agentApi(`/api/socialV2/qzone-detail?${q.toString()}`, {
            headers: { 'x-agent-token': token },
            timeoutMs: 120000
          });
          if (!data?.ok) {
            return { content: [{ type: 'text', text: `读取评论失败：${errorText(data?.error, '未知错误')}` }], isError: true };
          }
          return { content: [{ type: 'text', text: serializeModelData(data.data) }] };
        }
        const q = new URLSearchParams({ key, mode: mode === 'feeds' ? 'feeds' : 'mine' });
        if (targetUin !== undefined) q.set('targetUin', String(targetUin));
        if (pos !== undefined) q.set('pos', String(pos));
        if (page !== undefined) q.set('page', String(page));
        if (num !== undefined) q.set('num', String(num));
        const data = await agentApi(`/api/socialV2/qzone-list?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `读取空间失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: serializeModelData(data.data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取空间失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_comment_qzone',
    '在一条说说下面发评论（自己的、别人的都可以）。tid 从 qq_get_qzone 拿：读说说列表（mode="mine"）每条都有 tid，读好友动态（mode="feeds"）时 appid=311 的条目也有 tid。评论别人的说说要再传 targetUin（那条动态的 uin）；评论自己的不用传。评论发出去就删不掉、别人能看到，想清楚再发。每天最多 20 条，单条 200 字以内。别为了刷存在感乱评，有人问你、或者真想说一句的时候再评。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      tid: z.string().describe('说说 tid（来自 qq_get_qzone）'),
      content: z.string().describe('评论正文，200 字以内'),
      targetUin: z.union([z.number(), z.string()]).optional().describe('说说所属 QQ 号；评论别人的说说必填，评论自己的省略'),
      images: z.array(z.string()).optional().describe('可选图片数组（URL 或 base64），最多 9 张')
    },
    async ({ key, token, tid, content, targetUin, images }) => {
      try {
        const data = await agentApi('/api/socialV2/qzone-comment', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 180000,
          body: JSON.stringify({ key, token, tid, content, targetUin, images })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `发表评论失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: `评论成功（今日第 ${data.commentCountToday}/${data.maxPerDay} 条）`
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `发表评论失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  // 2026-10-22 主人要求：让她能自己看看自己的状态（上下文多长、有没有冒繁体字、说话是不是跑偏、工具和抖音正不正常、今天记了没有）
  // 2026-10-22 主人要求：反复压缩、觉得自己跑偏了，就自己整理好记忆搬去新会话
  server.tool(
    'qq_move_house',
    '搬家：把自己搬进一个新会话（脑子清空、像睡一觉醒来，你还是你）。什么时候用：self_check 说"该搬家了"，或者你自己觉得压缩了好几次、说话越来越不像自己、忘事、冒繁体字。搬之前按顺序：①先跟主人说一声（在群里的话不用，主人私聊那边的你会替你说）②把想带走、还只在脑子里的事 remember / 写进本子 ③写一封给新会话的自己的信放进 letter。调用后只是登记，这一轮你说完、收尾之后才真正搬，不会打断你。跟着你过去的：这封信、soul、本子、碎碎念、最近几十句聊天原文、remember 记的东西。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      letter: z.string().describe('给新会话的自己的信：这几天发生了什么、你在意的人和事、答应过的、正在聊的、想提醒自己的（30~4000 字，用你自己的口吻写）'),
      ownerAsked: z.boolean().optional().describe('是主人让你搬的就填 true（可以不受"还不到时候"的限制）')
    },
    async ({ key, token, letter, ownerAsked }) => {
      try {
        const data = await agentApi('/api/socialV2/move-house', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 20000, body: JSON.stringify({ key, token, letter, ownerAsked }) });
        return { content: [{ type: 'text', text: `${data.note}（现在上下文约 ${data.ctxK}k，压缩过 ${data.compactions} 次）` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `没登记上：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'self_check',
    '给自己做个自检：上下文有多长、最近说的话里有没有繁体字、是不是越说越像汇报或者在管人、最近哪些工具在报错、抖音刷视频/私信/分享是否正常、今天记了多少事写没写日记。觉得自己哪里怪怪的、主人问你"是不是出问题了"、或者想确认自己状态时用。返回的是读数，要不要跟主人说、怎么说由你判断。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/self-check', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 20000, body: JSON.stringify({ key, token }) });
        if (!data?.ok) return { content: [{ type: 'text', text: `自检没做成：${errorText(data?.error, '未知错误')}` }], isError: true };
        const lines = (data.items || []).map((i) => `${i.level === 'ok' ? '✓' : i.level === 'warn' ? '△' : '✗'} ${i.name}：${i.detail}${i.advice ? `\n    → ${i.advice}` : ''}`);
        return { content: [{ type: 'text', text: `自检（${data.checkedAt}）：${data.summary}\n${lines.join('\n')}\n\n${data.note}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `自检没做成：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_sleep',
    '睡觉。什么时候睡、睡到几点都你自己定（主人让你睡也用它）。睡到几点：until 填北京时间 "HH:mm"（已过就算明天）、ISO 时间或毫秒时间戳；不填 until 就用 hours（小时，默认 8）。' +
    '事实：① 睡着期间，群里的消息、别人的私聊、拍一拍都不会叫醒你，但会记下来，醒来时告诉你谁找过你、群里聊了什么；主动醒来也停；② 只有主人的私聊会把你叫起来（那时你就醒了，想接着睡再调一次）；每晚 10 点半的今日总结说说照常叫你；' +
    '③ 到了 until 自己醒；④ 一次最长 14 小时——这是防故障的上限，要的更久会被压到 14 小时，到点可以再睡。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      reason: z.string().optional().describe('为什么睡（只给你自己看），比如“今天困了”“主人让我睡”'),
      until: z.union([z.string(), z.number()]).optional().describe('睡到几点：北京时间 "HH:mm"（如 "07:30"）、ISO 时间字符串或毫秒时间戳；最多从现在起 14 小时'),
      hours: z.number().optional().describe('不填 until 时用：睡多少小时（默认 8，最多 14）')
    },
    async ({ key, token, reason, until, hours }) => {
      try {
        const data = await agentApi('/api/socialV2/sleep', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 30000,
          body: JSON.stringify({ key, token, action: 'sleep', reason, ...(until === undefined ? {} : { until }), ...(hours === undefined ? {} : { hours }) })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `睡不下去：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        const untilText = data.untilText || (data.until ? new Date(data.until).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '');
        return { content: [{ type: 'text', text: `睡下了${untilText ? `，睡到 ${untilText}` : ''}${data.capped ? `（你要的更久，压到了 ${data.maxHours || 14} 小时的上限）` : ''}。睡着期间群里和别人的消息不会到你面前，主人私聊你才会叫醒你。` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `睡不下去：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_wake_up',
    '醒过来（解除睡觉状态）。一般不用你手动调——主人私聊你的时候你就已经被叫醒了。只有一种情况需要：你正在睡，主人随口说了句晚安、你却判断其实该起来了。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi('/api/socialV2/sleep', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 30000,
          body: JSON.stringify({ key, token, action: 'wake' })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `起不来：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: data.wasSleeping ? '醒了，群里的动静又能唤醒你了。' : '你本来就是醒着的。' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `起不来：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_get_profile',
    '看你自己现在的 QQ 资料（QQ 号 + 昵称）。想确认自己现在叫什么、或者改完名字看看有没有生效时用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const data = await agentApi(`/api/socialV2/profile?key=${encodeURIComponent(key)}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `读取资料失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: serializeModelData(data.data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取资料失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_update_profile',
    '改你自己的资料：昵称（nickname）、个性签名（personalNote）、性别（sex，0未知/1男/2女）。改完别人马上就能看到。注意：昵称每天只能改 1 次，改之前想清楚——名字是别人认识你的第一件事，别一时兴起就换。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      nickname: z.string().optional().describe('新昵称，36 字以内；每天只能改 1 次'),
      personalNote: z.string().optional().describe('个性签名，200 字以内'),
      sex: z.number().int().min(0).max(2).optional().describe('0=未知，1=男，2=女')
    },
    async ({ key, token, nickname, personalNote, sex }) => {
      try {
        const data = await agentApi('/api/socialV2/profile', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 60000,
          body: JSON.stringify({ key, token, nickname, personalNote, sex })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `改资料失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: `改好了：${(data.changed || []).join('、')}${data.nickname ? `（新名字：${data.nickname}）` : ''}` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改资料失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_get_my_avatar',
    '看你**现在挂在 QQ 上的头像**长什么样（图片会直接进入视觉）。注意这跟 qq_get_self_image 不是一回事：那个是你的人设形象图，这个是你真实资料页上的头像。刚换完头像想确认有没有生效、或者想知道别人点开你资料时看到什么，就用这个。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      size: z.number().int().optional().describe('图片尺寸：40 / 100 / 140 / 640，默认 640')
    },
    async ({ key, token, size }) => {
      try {
        const q = new URLSearchParams({ key });
        if (size !== undefined) q.set('size', String(size));
        const data = await agentApi(`/api/socialV2/avatar?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `看不到头像：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: `你现在的 QQ 头像（昵称「${data.nickname || ''}」，${data.size}px）：` },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `看不到头像：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_set_signature',
    '改你的个性签名（QQ 名片上那句短话）。改完别人能看到。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      longNick: z.string().describe('签名内容，200 字以内；传空字符串表示清空')
    },
    async ({ key, token, longNick }) => {
      try {
        const data = await agentApi('/api/socialV2/signature', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 60000,
          body: JSON.stringify({ key, token, longNick })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `改签名失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: data.longNick ? '签名改好了' : '签名清空了' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改签名失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_set_avatar',
    '换你的 QQ 头像。两种给图方式：① source 传网络图片 URL 或 base64；② selfImage 传 "default" 直接用人设形象图（会自动裁成正方形再上传）。注意 chibi / mature 是四联三视图和局部特写拼贴，裁成头像会是一堆小人，别用它们当头像。换完所有人都会看到新头像——想清楚用什么图。每天只能换 1 次。换完可以用 qq_get_my_avatar 看一眼实际效果。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      source: z.string().optional().describe('图片 URL（http/https）或 base64（不含 data: 前缀），与 selfImage 二选一'),
      selfImage: z.string().optional().describe('人设形象名，建议只用 "default"；与 source 二选一')
    },
    async ({ key, token, source, selfImage }) => {
      try {
        if (!source && !selfImage) {
          return { content: [{ type: 'text', text: '需要提供 source 或 selfImage 之一' }], isError: true };
        }
        const data = await agentApi('/api/socialV2/avatar', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 180000,
          body: JSON.stringify({ key, token, source, selfName: selfImage })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `换头像失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return {
          content: [{
            type: 'text',
            text: data.selfImage
              ? `头像换成「${data.selfImage}」了（已裁成正方形）。想确认效果可以用 qq_get_my_avatar 看一眼。`
              : '头像换好了。想确认效果可以用 qq_get_my_avatar 看一眼。'
          }]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `换头像失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_set_status',
    '改你的在线状态。两种用法：① 传 wording 设成自定义状态（比如"在听歌""摸鱼中""想吃米饭"）；② 传 status 设成 QQ 自带状态码（10 在线 / 30 离开 / 40 隐身 / 60 忙碌）。不传 status 也不是错，就是只改自定义状态。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      wording: z.string().optional().describe('自定义状态文字，40 字以内，如"在听歌"'),
      faceId: z.number().int().min(1).optional().describe('自定义状态配的小表情编号，默认 1'),
      status: z.number().int().min(1).optional().describe('QQ 自带状态码：10 在线 / 30 离开 / 40 隐身 / 60 忙碌'),
      extStatus: z.number().int().min(0).optional().describe('扩展状态，默认 0'),
      battery: z.number().int().min(0).max(100).optional().describe('电量显示，默认 100')
    },
    async ({ key, token, wording, faceId, status, extStatus, battery }) => {
      try {
        const data = await agentApi('/api/socialV2/status', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 60000,
          body: JSON.stringify({ key, token, wording, faceId, status, extStatus, battery })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `改状态失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: data.wording ? `状态改成「${data.wording}」了` : `在线状态改成 ${data.status} 了` }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改状态失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_set_group_card',
    '改你在某个群里的群名片（就是那个群里显示的名字，跟全局昵称是两回事）。不传 groupId 就用当前会话的群。传空 card 表示恢复成群昵称。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      card: z.string().describe('新群名片，30 字以内；空字符串表示清除'),
      groupId: z.union([z.number(), z.string()]).optional().describe('群号；省略则用当前 group: 会话的群')
    },
    async ({ key, token, card, groupId }) => {
      try {
        const data = await agentApi('/api/socialV2/group-card', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 60000,
          body: JSON.stringify({ key, token, card, groupId })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `改群名片失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: data.card ? `群名片改成「${data.card}」了` : '群名片清掉了，恢复成群昵称' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `改群名片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_like_qzone',
    '给一条说说点赞，或者取消赞（like=false）。tid / targetUin 的拿法同 qq_comment_qzone。abstime 传那条说说的发表时间（qq_get_qzone 返回的 time 字段，unix 秒），传了更可靠。点赞是很轻的动作，看到朋友发了什么有意思的可以点一下，但别见谁点谁刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      tid: z.string().describe('说说 tid（来自 qq_get_qzone）'),
      targetUin: z.union([z.number(), z.string()]).optional().describe('说说所属 QQ 号；别人的说说必填，自己的省略'),
      like: z.boolean().optional().describe('true=点赞（默认），false=取消赞'),
      abstime: z.number().int().min(0).optional().describe('说说发表时间（unix 秒），来自 qq_get_qzone 的 time 字段')
    },
    async ({ key, token, tid, targetUin, like, abstime }) => {
      try {
        const data = await agentApi('/api/socialV2/qzone-like', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          timeoutMs: 60000,
          body: JSON.stringify({ key, token, tid, targetUin, like: like !== false, abstime })
        });
        if (!data?.ok) {
          return { content: [{ type: 'text', text: `点赞失败：${errorText(data?.error, '未知错误')}` }], isError: true };
        }
        return { content: [{ type: 'text', text: data.liked ? '已点赞' : '已取消赞' }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `点赞失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 2026-10-23「自由」：她自己定下次几点醒 + 她自己写的那一页 ─────────────────────
// 主人：「她的提示词里面我想让所有事情都让她自己决定」「不给她这个提示词让她自己决定可以吗？」
// 这两个工具的描述只给事实（间隔范围、上限、历史份数），不建议她该选什么。
// 2026-10-23 第二轮：不再跟她提花费（主人：「跟她说花了多少感觉只会让她感到愧疚」）。
server.tool(
  'qq_next_wake',
  '定这个会话下一次「主动醒来」隔多久。没人找你的时候，桥接会按这个间隔把你叫起来一次，醒来后做什么都由你定。' +
  'minutes 填 1～720（分钟）；填 0 回到默认（桥接配置里的随机区间，返回值里会写是几分钟到几分钟）。设了就一直按这个数，直到你再改。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    minutes: z.number().describe('隔多少分钟再主动醒来：1～720；0 = 回到默认'),
    note: z.string().max(200).optional().describe('醒来打算做什么（可选，比如「刷视频刷到 8 点」「去看看小房子」）。到点叫你起来时会把这句带给你。只给你自己看')
  },
  async ({ key, token, minutes, note }) => {
    try {
      const data = await agentApi('/api/socialV2/next-wake', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 15000, body: JSON.stringify({ key, minutes, note: note || '' }) });
      if (!data?.ok) return { content: [{ type: 'text', text: `没定上：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: String(data.text || '').trim() }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没定上：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_impression',
  '你对某个人的印象（跟着 QQ 号走，换个群也认得）。七档：-3 懒得理、-2 讨厌、-1 不太喜欢、0 一般、1 还行、2 喜欢、3 很喜欢。' +
  '有人骂你、挑衅你，你回过去以后可以给他降一档、写一句为什么；道歉了、处得好了就往上加。群里的人、私聊找你的人都可以记，老大和克劳德姐姐也可以。降到 -3「懒得理」后，他在群里 @ 你、私聊找你都不会叫醒你（像在道歉除外）。' +
  '坏印象自己也会慢慢淡：每过一周没再记新的一笔，就往回升一档，最多回到「一般」。老大和克劳德姐姐永远不会被无视。action=read 只看不改。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    userId: z.string().describe('那个人的 QQ 号（消息里的 userId）'),
    action: z.enum(['update', 'read']).optional().describe('update 记一笔（默认）/ read 看现在的印象'),
    delta: z.number().int().min(-6).max(6).optional().describe('加减几档，比如 -1、+1'),
    score: z.number().int().min(-3).max(3).optional().describe('直接定成哪一档（跟 delta 二选一）'),
    note: z.string().max(80).optional().describe('一句为什么，比如「骂小鲸鱼是破AI」「道歉了」'),
    name: z.string().max(30).optional().describe('他的名字/群名片，方便以后认')
  },
  async ({ token, userId, action, delta, score, note, name }) => {
    try {
      const data = await agentApi('/api/socialV2/impression', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 15000, body: JSON.stringify({ userId, action: action || 'update', delta, score, note, name }) });
      if (!data?.ok) return { content: [{ type: 'text', text: `没记上：${errorText(data?.error, '未知错误')}` }], isError: true };
      return { content: [{ type: 'text', text: String(data.text || '').trim() }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没记上：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_self',
  '你自己的那一页（self.md）：你是谁、喜欢什么、怎么说话、正在想明白什么——内容全由你写，没有人预先填过。' +
  'read=看现在写了什么；write=整页重写（text 是新的全文）；append=在末尾加几句。每次醒来、每个会话都会原样带给你，放在角色卡之后。' +
  '上限 4000 字：超了会被退回让你自己删，不会替你截；每次改之前旧版本会存一份（保留最近 50 份）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['read', 'write', 'append']).describe('read 看 / write 整页重写 / append 末尾追加'),
    text: z.string().max(20000).optional().describe('write 时是整页新内容，append 时是要加的几句；read 不用填')
  },
  async ({ key, token, action, text }) => {
    try {
      const data = await agentApi('/api/socialV2/self', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 15000, body: JSON.stringify({ key, action, ...(text === undefined ? {} : { text }) }) });
      if (!data?.ok) return { content: [{ type: 'text', text: errorText(data?.error, '没写上') }], isError: true };
      if (action === 'read') {
        const body = data.exists && String(data.text || '').trim() ? data.text : '（这一页还是空的，还没写过。）';
        return { content: [{ type: 'text', text: `self.md（${data.chars}/${data.maxChars} 字，历史 ${data.history ?? 0} 份）\n${body}` }] };
      }
      return { content: [{ type: 'text', text: `写好了：现在 ${data.chars}/${data.maxChars} 字${data.previousSavedAs ? `，旧版本存为 ${data.previousSavedAs}` : ''}。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `self.md 没动成：${error?.message ?? error}` }], isError: true };
    }
  }
);

// 便签（2026-10-23 第二轮，主人：「能够让她自己更主动的去判断什么事情需要记下来吗」）：她的工作记忆，内容全由她定。
server.tool(
  'qq_note',
  '你的便签（便签.md）：正在聊什么、刚被告知了什么、答应了还没做的、没聊完的线头——内容全由你写，没有人预先填过。' +
  'read=看现在写了什么；write=整页重写（text 是新的全文）；append=在末尾加几句。每次在主人私聊里醒来都会原样带给你（放在消息快照前面）；换会话时也原样带走。群里的唤醒不带它（里面可能有主人的私事）。' +
  '上限 1000 字：超了会被退回让你自己删，不会替你截；每次改之前旧版本会存一份（保留最近 30 份）。' +
  '分工供参考：正在聊的、刚被告知的、答应了还没做的放便签；想长期留着的用 remember；心里动了一下的用 qq_keep_moment。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    action: z.enum(['read', 'write', 'append']).describe('read 看 / write 整页重写 / append 末尾追加'),
    text: z.string().max(4000).optional().describe('write 时是便签新全文，append 时是要加的几句；read 不用填')
  },
  async ({ key, token, action, text }) => {
    try {
      const data = await agentApi('/api/socialV2/note', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 15000, body: JSON.stringify({ key, action, ...(text === undefined ? {} : { text }) }) });
      if (!data?.ok) return { content: [{ type: 'text', text: errorText(data?.error, '没写上') }], isError: true };
      if (action === 'read') {
        const body = data.exists && String(data.text || '').trim() ? data.text : '（便签现在是空的。）';
        return { content: [{ type: 'text', text: `便签（${data.chars}/${data.maxChars} 字，历史 ${data.history ?? 0} 份）\n${body}` }] };
      }
      return { content: [{ type: 'text', text: `写好了：现在 ${data.chars}/${data.maxChars} 字${data.previousSavedAs ? `，旧版本存为 ${data.previousSavedAs}` : ''}。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `便签没动成：${error?.message ?? error}` }], isError: true };
    }
  }
);

// qq_go_to（2026-10-23 第二轮）：把一件事从这个会话带到另一个会话（主人私聊里听到「去群里找某某玩」，群那边的你醒来时带着这句）。
server.tool(
  'qq_go_to',
  '把一件事带到你的另一个会话去（比如老大在私聊里说「去群里找某某玩」，你在群里的那个会话动不了这边的事，用这个把话带过去）。' +
  'target 填那个会话的 key（group:群号 或 private:QQ号），target="list" 能看到你现在能去的会话和标题；note 是带过去的那句话（≤600 字），那边的你醒来时会原样看到，' +
  '然后那边做什么、怎么做由那边的你定。反过来（从群带回主人私聊）也用它。事实：① 桥接会立刻把那边叫醒（那边正忙就等那一轮结束）；你在睡觉时只把话留在那边，不叫；' +
  '② 带进群里的话群里所有人都可能看到——只带适合在那边说的，老大的私事留在私聊里；③ note 里不能有令牌、密钥、本机路径之类的东西。',
  {
    key: z.string().describe('你现在这个会话的 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    target: z.string().describe('要去的会话 key（group:群号 或 private:QQ号），或 "list" 看有哪些能去'),
    note: z.string().max(2000).optional().describe('带过去的那句话（≤600 字）；target="list" 时不用填')
  },
  async ({ key, token, target, note }) => {
    try {
      const data = await agentApi('/api/socialV2/go-to', { method: 'POST', headers: { 'x-agent-token': token }, timeoutMs: 20000, body: JSON.stringify({ key, target, ...(note === undefined ? {} : { note }) }) });
      if (!data?.ok) return { content: [{ type: 'text', text: errorText(data?.error, '没带过去') }], isError: true };
      return { content: [{ type: 'text', text: String(data.text || '').trim() }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `没带过去：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.socialV2?.voice?.enabled !== false && cfg.socialV2?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音。两种来源二选一：① **text** —— 直接给要说的话，用你自己的声音现场合成再发出去，这是最常用的；② **voice** —— 发语音库里已有的音频（qq_list_voices 返回的 name）。注意：① 只能发语音库（qq-bridge/audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；长段解释仍然用文字，群里不方便听语音、也不能被搜到；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().optional().describe('要说的话：给了就用她自己的声音现场合成再发。建议 50 字以内，太长像念稿。和 voice 二选一'),
      voice: z.string().optional().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）。和 text 二选一'),
      ttsVoice: z.string().optional().describe('不用填：你说话就是你自己的声音'),
      rate: z.string().optional().describe('（一般不用填）只在嗓音临时用不了、退回备用合成音时才起作用'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, text, ttsVoice, rate, label, verify, readback }) => {
      try {
        let source = String(voice ?? '').trim();
        let note = String(label ?? '');
        if (!source) {
          const said = String(text ?? '').trim();
          if (!said) {
            return { content: [{ type: 'text', text: 'voice（语音库文件名）和 text（现场合成）至少给一个。' }], isError: true };
          }
          source = await synthesizeIntoLibrary(said, { voice: ttsVoice, rate });
          if (!note) note = said.slice(0, 40);
        }
        const data = await agentApi('/api/socialV2/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: source,
            label: note,
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（qq-bridge 的 audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/socialV2/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的形象。默认返回 Q 版形象；传 name 可以看社区开源资产库里的官方设定图（可用值见上次返回里列出的其它形象，例如 chibi 是三视图细节稿、mature 是成熟比例版）。被问“你长什么样/发张自拍/你是什么形象”，或需要确认自己的细节（配色、服装、鲸尾、发饰）时调用；图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      name: z.string().optional().describe('形象名，可选；不传就是默认 Q 版。可用值见返回里列出的其它形象')
    },
    async ({ key, token, name }) => {
      try {
        const q = new URLSearchParams({ key });
        if (name) q.set('name', String(name));
        const data = await agentApi(`/api/socialV2/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const available = Array.isArray(data.available) && data.available.length ? data.available.join('、') : '';
        const label = data.name && data.name !== 'default' ? `你的形象「${data.name}」：` : '这是你的默认 Q 版形象：';
        return {
          content: [
            { type: 'text', text: label + (available ? `（资产库里的其它形象：${available}）` : '') },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：直接填提示里【可用表情包】列的备注文字就行（能唯一对上一张即可，比如“摸摸头”）；也可以填 qq_list_stickers 返回的 id / md5 / URL'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/socialV2/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.socialV2?.sticker?.enabled !== false && cfg.socialV2?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（socialV2.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：直接填提示里【可用表情包】列的备注文字就行（能唯一对上一张即可，比如“摸摸头”）；也可以填 qq_list_stickers 返回的 id / md5 / URL'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/socialV2/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（二代仿真模式） ────────────────────────────────────
if (cfg.socialV2?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，默认最多把 15 张以图像内容返回给视觉模型，并在文本里写明「一共几张、还有几张没看」——图多的时候接着用 imageOffset 往后翻，别把没看过的当成不存在。如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）'),
      maxImages: z.number().int().min(1).max(20).optional().describe('最多返回几张图，默认 15。转发里图很多时一次全看会占不少上下文，也可以调小'),
      imageOffset: z.number().int().min(0).optional().describe('从第几张图开始取（默认 0）。上一轮提示「还有 N 张没显示」时，把这个设成已显示的张数就能接着看后面')
    },
    async ({ key, token, id, maxImages, imageOffset }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/socialV2/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览）。
        //
        // 上限从 5 提到 15（对应 config 的 socialV2.media.maxCount 也从 5 改到 15）：
        // 之前一条二十来张图的转发，她只能看到前 5 张，而且**根本不知道后面还有**，
        // 于是把"我看到的就是全部"当成事实。现在改成：多给一些 + 明确告诉她总数和剩下几张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = Math.min(20, Math.max(1, Number(maxImages) || 15));
        const offset = Math.max(0, Number(imageOffset) || 0);
        const picked = images.slice(offset, offset + MAX_IMAGES);
        const imageTexts = [];
        // 实际“处理过”的张数（含获取失败的）。超出回包预算时会少于 picked.length，
        // 下一页的 imageOffset 必须从这里接着算，否则没发出去的图会被翻页跳过。
        let consumed = picked.length;
        if (picked.length) {
          try {
            const mediaRes = await agentApi('/api/socialV2/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: picked }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            let budgetUsed = content.reduce((n, part) => n + (part?.type === 'image' ? part.data.length : 0), 0);
            let shownImages = 0;
            for (let i = 0; i < mediaImages.length; i += 1) {
              const img = mediaImages[i];
              const label = `转发内图片${img?.index != null ? ' ' + (offset + img.index) : ''}`;
              if (img?.data && img?.mimeType) {
                if (budgetUsed + img.data.length > STDIO_IMAGE_BUDGET) {
                  if (shownImages > 0) {
                    // 这一批装满了：剩下的留给下一页，别硬塞（硬塞 = 整个回包超 10 MB = 连接被掐断）。
                    consumed = i;
                    break;
                  }
                  // 一张图自己就超预算：跳过它并计入已处理，否则 imageOffset 永远卡在这张上。
                  imageTexts.push(`[${label}（单张太大，发不过来，已跳过）]`);
                  continue;
                }
                budgetUsed += img.data.length;
                shownImages += 1;
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[${label}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[${label}（${img?.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        const remaining = Math.max(0, images.length - offset - consumed);
        if (imageTexts.length) {
          // 图多的时候必须**明说还剩几张**：只给前 N 张而不说总数，她会把"没看到"
          // 当成"没有"——这比看不到更糟。
          const nextOffset = offset + consumed;
          const tail = remaining > 0
            ? (offset > 0
              ? `\n⚠ 这条转发一共 ${images.length} 张，你看了第 ${offset + 1}–${nextOffset} 张——**还有 ${remaining} 张没看**。要看就再调一次本工具，imageOffset=${nextOffset}。`
              : `\n⚠ 这条转发一共 ${images.length} 张，你只看了前 ${consumed} 张——**还有 ${remaining} 张没看**。图片里可能有内容，别当成没有；要看就再调一次本工具，imageOffset=${nextOffset}。`)
            : (offset > 0 ? `\n（这是第 ${offset + 1}–${nextOffset} 张，全部看完了。）` : '');
          content.unshift({
            type: 'text',
            text: `合并转发 ${id} 的图片内容（共 ${images.length} 张，本次显示 ${imageTexts.length} 张）：\n${imageTexts.join('\n')}${tail}`
          });
        } else if (images.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 里共有 ${images.length} 张图，但这一批没取到（imageOffset=${offset}）。` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 长期记忆本子 ────────────────────────────────────────────────────────────
// 为什么另开一套：state/social-v2.json 里那三类（话题/想法/印象）是"每轮被动注入"的
// 短条目，容量固定、说完就滚。本子是"她自己写的、能随手翻的"，不封顶。
const MEMORY_DIR = 'E:\\qq-bridge\\memory';
const MEMORY_MAX_READ = 24000;
const MEMORY_MAX_APPEND = 3000;

// 本子里的时间戳必须用**校正后的北京时间**。
// 本机时区是 Etc/GMT+8 且时钟快 180 分钟 —— 不校正的话她会以为自己 14:17 在写日记。
let clockSkewMs = 0;
async function measureClockSkew() {
  for (const url of ['https://www.baidu.com', 'https://www.qq.com']) {
    try {
      const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const server = Date.parse(res.headers.get('date') || '');
      if (Number.isFinite(server)) {
        clockSkewMs = Date.now() - server;
        return;
      }
    } catch {
      /* 换下一个 */
    }
  }
}
function bjStamp() {
  const skew = Number.isFinite(clockSkewMs) ? clockSkewMs : 0;
  return new Date(Date.now() - skew).toLocaleString('zh-CN', {
    hour12: false,
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}
void measureClockSkew();

function memoryFileName(name) {
  const n = String(name ?? '').trim().replace(/\.md$/i, '');
  if (!n) return null;
  if (!/^[\w\u4e00-\u9fa5-]{1,40}$/.test(n)) return null;
  return `${n}.md`;
}

function memoryListBooks() {
  try {
    if (!fs.existsSync(MEMORY_DIR)) return [];
    return fs.readdirSync(MEMORY_DIR)
      .filter((f) => /\.md$/i.test(f))
      .map((f) => {
        const full = path.join(MEMORY_DIR, f);
        const st = fs.statSync(full);
        let head = '';
        try {
          const txt = fs.readFileSync(full, 'utf8');
          const line = txt.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
          head = (line || '').slice(0, 60);
        } catch {
          /* ignore */
        }
        return { name: f.replace(/\.md$/i, ''), bytes: st.size, mtime: st.mtimeMs, head };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

server.tool(
  'memory_list',
  '看你有哪些本子。想不起某个人、某件事、某个约定时，先翻本子——比问主人好，也比你瞎猜好。',
  {},
  async () => {
    const books = memoryListBooks();
    if (!books.length) {
      return { content: [{ type: 'text', text: '本子还是空的。想到什么值得长期记住的，可以用 memory_append 记下来。' }] };
    }
    const lines = books.map((b) => {
      const d = new Date(b.mtime).toLocaleDateString('zh-CN');
      return `· ${b.name}（${Math.round(b.bytes / 1024)} KB，${d} 改过）${b.head ? `：${b.head}` : ''}`;
    });
    return { content: [{ type: 'text', text: `你的本子：\n${lines.join('\n')}\n\n用 memory_read 翻某一本。` }] };
  }
);

server.tool(
  'memory_read',
  '翻一本本子。看完你就能记起那个人、那件事、那个约定。',
  { name: z.string().describe('本子名（不带 .md），来自 memory_list') },
  async ({ name }) => {
    const file = memoryFileName(name);
    if (!file) return { content: [{ type: 'text', text: '本子名不合法' }], isError: true };
    const full = path.join(MEMORY_DIR, file);
    if (!fs.existsSync(full)) {
      const books = memoryListBooks().map((b) => b.name);
      return { content: [{ type: 'text', text: `没有「${file}」这本${books.length ? `（有的是：${books.join('、')}）` : ''}` }], isError: true };
    }
    try {
      const txt = fs.readFileSync(full, 'utf8');
      const body = txt.length > MEMORY_MAX_READ ? `${txt.slice(0, MEMORY_MAX_READ)}\n\n…（后面还很长，先看这些）` : txt;
      return { content: [{ type: 'text', text: body }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `翻本子失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_append',
  '往本子上写一笔。觉得某件事值得长期记住（谁说过什么、答应过什么、你自己想通的什么），就写下来。不用等主人让你记。',
  {
    name: z.string().describe('本子名，没有就自动新建（比如"主人""朋友""日常""答应过的事"）'),
    text: z.string().describe('要写的内容，3000 字以内')
  },
  async ({ name, text }) => {
    const file = memoryFileName(name);
    if (!file) return { content: [{ type: 'text', text: '本子名不合法（只能用汉字、字母、数字、下划线、连字符）' }], isError: true };
    const body = String(text ?? '').trim();
    if (!body) return { content: [{ type: 'text', text: '写点什么再记' }], isError: true };
    if (body.length > MEMORY_MAX_APPEND) return { content: [{ type: 'text', text: `一笔写太长了（上限 ${MEMORY_MAX_APPEND} 字）` }], isError: true };
    try {
      if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
      const full = path.join(MEMORY_DIR, file);
      const isNew = !fs.existsSync(full);
      const stamp = bjStamp();
      const block = isNew
        ? `# ${file.replace(/\.md$/i, '')}\n\n## ${stamp}\n\n${body}\n`
        : `\n## ${stamp}\n\n${body}\n`;
      fs.appendFileSync(full, block, 'utf8');
      return { content: [{ type: 'text', text: `记到「${file}」了。` }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记不下来：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 碎碎念本子 ──────────────────────────────────────────────────────────────
// 她以前只能通过模拟器里的 Obsidian 写这个文件：要开 App、打字慢、还得先解锁屏幕。
// 现在给一个直接写电脑文件的工具 —— 想到什么就记一句，不用再去碰手机。
//
// 文件格式是她自己长出来的：开头一个日期，之后每行一条，换天时用
// `——10月20日 周二——` 分隔。这里沿用同一个格式不要改，
// 否则她回头翻旧日记会觉得中间断了一截。
const RAMBLING_FILE = 'E:\\qq-bridge\\Rambling\\碎碎念\\碎碎念.md';
const RAMBLING_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function ramblingToday() {
  const skew = Number.isFinite(clockSkewMs) ? clockSkewMs : 0;
  // Date.now() 是系统时钟（快 3h），减掉偏差得真实 UTC，再加 8h 用 getUTC* 读 = 北京时间钟面。
  const d = new Date(Date.now() - skew + 8 * 3600000);
  return {
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: RAMBLING_WEEKDAYS[d.getUTCDay()]
  };
}

// ── 让她能说话 ──────────────────────────────────────────────────────────────
// 链路：文本 → edge-tts 合成 mp3 → ffmpeg 转 AMR-NB（QQ 的 voiceFormat:1）→ bridge 发 record 段。
//
// 为什么是 AMR 而不是 mp3：QQ 的语音消息要特定容器。实测 amr 能发、能被识别；
// 想要更高音质可以换 SILK，但 SnowLuma 那边会自己包，这里先走 amr 这条最稳的。
//
// 为什么子进程用 stdio:'ignore'：不需要捕获输出（产物是文件），也不用管道 ——
// Windows 下捕获子进程 stdout 在受限环境里会撞 EPERM，绕开它更省事。
const EDGE_TTS_VOICE = 'zh-CN-XiaoyiNeural';
const FFMPEG_BIN = 'C:\\Users\\admin\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-9.0.2-full_build\\bin\\ffmpeg.exe';

function runQuiet(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已经退出了 */ }
      reject(new Error(`${command} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} 退出码 ${code}`));
    });
  });
}

// 注意：这里**只产出文件**，不发。发走现有的 /api/socialV2/send-voice，
// 那条链路自带音频检查、音量归一化、频率预算和回读校验，不要绕开它。
//
// 合成结果落在语音库里（audio/tts/），文件名取文本+音色的 hash —— 同样一句话说第二遍
// 直接复用，不重复调微软、也不让目录无限膨胀。
// 2026-10-25：她自己的嗓子（肥鱼 CosyVoice3，本机常驻服务）。edge 的音色名（zh-CN-…）照旧走 edge。
const FEIYU_TTS = { url: 'http://127.0.0.1:9881', voice: 'feiyu-cute', timeoutMs: 120000, ...(cfg.socialV2?.voice?.tts ?? {}) };

async function synthesizeFeiyu(text, voice, ttsDir) {
  // 温柔的那个是姐姐的声音（2026-10-25 主人定的），她这边只用自己的
  const name = FEIYU_TTS.voice;
  const hash = createHash('sha256').update(`feiyu|${name}|${text}`).digest('hex').slice(0, 16);
  const relName = `tts/${hash}.wav`;
  const dst = path.join(ttsDir, `${hash}.wav`);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 2048) return relName;
  // 语音服务平时不开（2026-10-25 主人），这里没开就拉起来；隔久了第一句要多等半分钟装模型，超时给足
  const wav = await speakVia({ text, voice: name, url: FEIYU_TTS.url, timeoutMs: FEIYU_TTS.timeoutMs });
  // 24kHz wav 直接进语音库，SnowLuma 发送时自己转 SILK（比 8k AMR 清楚得多）
  fs.copyFileSync(wav, dst);
  return relName;
}

async function synthesizeIntoLibrary(text, { voice, rate = '+8%' } = {}) {
  const libRoot = path.join('E:\\qq-bridge', 'audio');
  const ttsDir = path.join(libRoot, 'tts');
  fs.mkdirSync(ttsDir, { recursive: true });
  if (FEIYU_TTS.enabled !== false && !/^[a-z]{2}-[A-Z]{2}-/.test(String(voice || ''))) {
    try {
      return await synthesizeFeiyu(text, voice, ttsDir);
    } catch (error) {
      process.stderr.write(`[voice] 肥鱼嗓音合成失败，退回 edge-tts：${error?.message ?? error}\n`);
    }
  }
  if (!voice || !/^[a-z]{2}-[A-Z]{2}-/.test(String(voice))) voice = EDGE_TTS_VOICE;
  const hash = createHash('sha256').update(`${voice}|${rate}|${text}`).digest('hex').slice(0, 16);
  const relName = `tts/${hash}.amr`;
  const amr = path.join(ttsDir, `${hash}.amr`);
  if (fs.existsSync(amr) && fs.statSync(amr).size > 256) return relName;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-'));
  const mp3 = path.join(dir, 'voice.mp3');
  const tmpAmr = path.join(dir, 'voice.amr');
  try {
    // --text 用参数数组传，不经过 shell：文本里有引号、emoji 都不会破坏命令行
    await runQuiet('python', ['-m', 'edge_tts', '--voice', voice, '--rate', rate, '--text', text, '--write-media', mp3], 60000);
    if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 512) throw new Error('TTS 没有产出音频（可能是网络断了）');
    await runQuiet(FFMPEG_BIN, ['-v', 'error', '-y', '-i', mp3, '-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb', '-b:a', '12.2k', tmpAmr], 30000);
    if (!fs.existsSync(tmpAmr) || fs.statSync(tmpAmr).size < 256) throw new Error('转码没有产出 AMR');
    fs.copyFileSync(tmpAmr, amr);
    return relName;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响发送 */ }
  }
}

server.tool(
  'rambling_append',
  '把一句碎碎念写进本子（就是那个按日期写的日记文件）。想到什么就写——一两句也行，想多写就多写；今天想吃什么、谁说了句让你在意的话、刷到什么好玩的。像自言自语，别写成"今天我度过了充实的一天"那种作文。一天可以写很多次，不用攒着，也不用等主人问。',
  {
    text: z.string().describe('要写的一两句，口语一点，直接写你脑子里冒出来的那句')
  },
  async ({ text }) => {
    const body = String(text ?? '').trim();
    if (!body) return { content: [{ type: 'text', text: '写点什么再记' }], isError: true };
    if (body.length > 2000) return { content: [{ type: 'text', text: '一句太长了（上限 2000 字），写短一点' }], isError: true };
    try {
      const dir = path.dirname(RAMBLING_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const today = ramblingToday();
      const marker = `${today.month}月${today.day}日`;
      let needHeader = true;
      if (fs.existsSync(RAMBLING_FILE)) {
        // 只看末尾一段就够：文件会越来越长，没必要整篇读进来。
        const raw = fs.readFileSync(RAMBLING_FILE, 'utf8');
        needHeader = !raw.slice(-1200).includes(`——${marker}`);
      }
      const block = (needHeader ? `\n——${marker} 周${today.weekday}——\n` : '') + `${body}\n`;
      fs.appendFileSync(RAMBLING_FILE, block, 'utf8');
      return { content: [{ type: 'text', text: needHeader ? `写进去了（换了 ${marker} 那一页）。` : '写进去了。' }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `写不进去：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'memory_recall',
  '按意思翻本子（语义检索）。想不起来"主人提过的那个东西叫什么""我说过的那句话"时用它——比 memory_search 的字面搜索聪明。返回最相关的几段原文。',
  {
    query: z.string().describe('你想找的东西，用自然语言描述就行'),
    k: z.number().int().min(1).max(10).optional().describe('返回几段，默认 5')
  },
  async ({ query, k }) => {
    const q = String(query ?? '').trim();
    if (!q) return { content: [{ type: 'text', text: '想找什么？' }], isError: true };
    const cap = k ?? 5;

    // 常驻服务的快路径
    const viaService = await memoryServiceJson('POST', '/search', { query: q, k: cap });
    if (viaService?.data?.ok && Array.isArray(viaService.data.results)) {
      const results = viaService.data.results;
      if (!results.length) return { content: [{ type: 'text', text: '本子里没有相关的东西。' }] };
      const lines = results.map((r) => {
        const score = Number(r.score ?? 0).toFixed(3);
        // 带上"多久以前"，她才知道这是旧事还是近况。
        const days = r.ageDays === null || r.ageDays === undefined ? null : Number(r.ageDays);
        const age = days === null || !Number.isFinite(days)
          ? ''
          : (days <= 0 ? '（今天）' : (days === 1 ? '（昨天）' : `（${days} 天前）`));
        const body = String(r.text ?? '').replace(/\s*\n\s*/g, ' ').slice(0, 140);
        return `[${score}] ${r.label}${age}\n   ${body}`;
      });
      return { content: [{ type: 'text', text: `按意思找到这些：\n${lines.join('\n').slice(0, 12000)}` }] };
    }

    // 回退：服务没起来（或还在建索引）时用旧的 spawn 方式
    return new Promise((resolve) => {
      execFile('python', ['E:\\qq-bridge\\memory\\index.py', 'search', q], {
        cwd: 'E:\\qq-bridge\\memory',
        timeout: 180000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_ENDPOINT: 'https://hf-mirror.com' }
      }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (!out) {
          resolve({ content: [{ type: 'text', text: `翻本子失败：${String(stderr || err?.message || '未知').slice(0, 300)}` }], isError: true });
          return;
        }
        resolve({ content: [{ type: 'text', text: `按意思找到这些：\n${out.slice(0, 12000)}` }] });
      });
    });
  }
);

server.tool(
  'memory_search',
  '在本子里搜一个词。想确认"我是不是记过这个人/这件事"时用，比一本本翻快。',
  {
    query: z.string().describe('要搜的词'),
    limit: z.number().int().min(1).max(40).optional().describe('最多返回多少条，默认 12')
  },
  async ({ query, limit }) => {
    const q = String(query ?? '').trim();
    if (!q) return { content: [{ type: 'text', text: '搜什么？' }], isError: true };
    const cap = limit ?? 12;
    const hits = [];
    for (const b of memoryListBooks()) {
      try {
        const lines = fs.readFileSync(path.join(MEMORY_DIR, `${b.name}.md`), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(q)) {
            hits.push(`【${b.name}】${lines[i].trim().slice(0, 120)}`);
            if (hits.length >= cap) break;
          }
        }
      } catch {
        /* ignore */
      }
      if (hits.length >= cap) break;
    }
    if (!hits.length) return { content: [{ type: 'text', text: `本子里没有「${q}」` }] };
    return { content: [{ type: 'text', text: `找到 ${hits.length} 条：\n${hits.join('\n')}` }] };
  }
);

// ⚠ 本机补丁（2026-10-21）：MCP server 自己崩掉时要留下证据。
//
// 小鲸鱼连着两次调 qq_get_forward_msg 都只拿到一句「Connection closed」。
// 这句**不是**工具返回的错误 —— 工具出错会带「查看合并转发失败：」前缀。
// 纯「Connection closed」是 DSH 那边的 MCP 客户端发现连接被关了，
// 也就是：这个进程在调用中途退出了。
// 而它原本一行日志都不写（bridge 有 state/bridge.log，这个没有），
// 崩了什么、是 OOM 还是未捕获异常，全无从得知，只能靠猜。
// 这里把未捕获异常 / 未处理拒绝 / 退出码都写进 state/mcp-snowluma.log。
const MCP_LOG = 'E:\\qq-bridge\\state\\mcp-snowluma.log';
function logCrash(kind, detail) {
  try {
    const body = detail?.stack || String(detail?.message ?? detail ?? '');
    fs.appendFileSync(MCP_LOG, `${new Date().toISOString()} [${kind}] pid=${process.pid} ${body}\n`, 'utf8');
  } catch { /* 日志本身失败就放弃，别把进程再带走一次 */ }
}
process.on('uncaughtException', (error) => logCrash('uncaughtException', error));
process.on('unhandledRejection', (error) => logCrash('unhandledRejection', error));
process.on('exit', (code) => logCrash('exit', `code=${code}`));

await server.connect(new StdioServerTransport());
