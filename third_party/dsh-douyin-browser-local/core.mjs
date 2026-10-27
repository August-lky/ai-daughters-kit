import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { bumpChatPriority } from './chat-priority.mjs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from './playwright-runtime.mjs';
import { MemoryStore } from './memory.mjs?v=2';
import { TOOL_DEFINITIONS, validateToolArguments } from './tool-definitions.mjs?v=10';
import { VideoLimits } from './video-limits.mjs';
import { resolveRuntimePaths, resolveNodeExecutable } from './runtime-paths.mjs?v=10';
import { PersonaMemory } from './persona-memory.mjs?v=10';
import { BrowserLauncher, connectDedicatedBrowser, newWindowPage } from './browser-launcher.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 遍历标签页读 window.name 时必须封顶：一个被风控/验证码占住的抖音页会让 evaluate
// 永久挂起，把 withPage 的队列整条堵死（2026-10-21 实测：转发后回退卡了五分钟以上）。
const quickPageName = (candidate, ms = 3000) => Promise.race([
  candidate.evaluate(() => window.name).catch(() => ''),
  new Promise((resolve) => setTimeout(() => resolve(''), ms)),
]);
const VIDEO_ACTIONS=new Set(['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen','douyin_score']);
// ⚠ 本机补丁（2026-10-23，audio）：让她"听见"。
// 1) 自主观看 / douyin_observe 抽帧的同时，顺带录这一窗口的实际音轨（最多 AUDIO_MAX_SECONDS 秒，
//    长停留只录窗口的前 30 秒），窗口结束后交给本机 Whisper 转写，结果挂在 observation.audio 上。
//    转写最多再等 AUDIO_TRANSCRIBE_TIMEOUT_MS；超时/失败一律不影响画面结果，也不拖住下一次决策。
// 2) 被动监听页面自己拉的 aweme/v1/web/(tab/feed|aweme/detail) JSON（不发任何额外请求、不碰 play_addr），
//    按作品 id 缓存 desc / music.title / music.author / 可能存在的字幕字段，合并进 state().video。
const AUDIO_MAX_SECONDS=30, AUDIO_TRANSCRIBE_TIMEOUT_MS=20_000, AUDIO_SEGMENTS_MAX=12, AUDIO_TEXT_MAX=1500;
const AWEME_RESPONSE=/\/aweme\/v1\/web\/(tab\/feed|aweme\/detail)\/?(?:[?#]|$)/;
const AWEME_CACHE_MAX=200;
const awemeListenerAttached=new WeakSet();
const cleanText=(value,max)=>typeof value==='string'?value.replace(/\s+/g,' ').trim().slice(0,max):'';
// 只认字符串或 {text} 数组形态的字幕类字段；没有就不带这个键。
function captionFields(item) {
  const out={};
  for(const holder of [item,item?.video]) {
    if(!holder||typeof holder!=='object') continue;
    for(const [key,value] of Object.entries(holder)) {
      if(!/subtitle|caption|lyric|asr|ocr_content|video_text/i.test(key)) continue;
      const text=typeof value==='string'?cleanText(value,600):Array.isArray(value)?cleanText(value.map(part=>typeof part==='string'?part:part?.text??part?.content??'').filter(Boolean).join(' '),600):'';
      if(text) out[key]=text;
    }
  }
  return Object.keys(out).length?out:null;
}
// 解析推荐流 / 作品详情 JSON；任何形态不对的条目直接跳过，绝不抛错到网络事件里。
export function parseAwemePayload(payload) {
  const items=Array.isArray(payload?.aweme_list)?payload.aweme_list:payload?.aweme_detail&&typeof payload.aweme_detail==='object'?[payload.aweme_detail]:[];
  const result=[];
  for(const item of items) {
    if(!item||typeof item!=='object') continue;
    const id=String(item.aweme_id??item.awemeId??'');
    if(!/^\d{10,30}$/.test(id)) continue;
    const desc=cleanText(item.desc,1000);
    const music=item.music&&typeof item.music==='object'?{title:cleanText(item.music.title,200)||null,author:cleanText(item.music.author||item.music.owner_nickname,200)||null}:null;
    const captions=captionFields(item);
    result.push({id,desc:desc||null,music:music&&(music.title||music.author)?music:null,...(captions?{captions}:{}),at:Date.now()});
  }
  return result;
}
export function rememberAweme(cache,entry,max=AWEME_CACHE_MAX) {
  if(!entry?.id) return;
  cache.delete(entry.id); cache.set(entry.id,entry);
  while(cache.size>max) cache.delete(cache.keys().next().value);
}
// id 读得出就按 id 取；读不出时退而按文案前缀对一下（best-effort，标 matchedBy:'title'）。
export function lookupAweme(cache,video) {
  if(!video||!cache?.size) return null;
  const id=video.id==null?'':String(video.id);
  if(id&&cache.has(id)) return {...cache.get(id),matchedBy:'id'};
  const title=cleanText(video.title,1000);
  if(title.length<6) return null;
  const head=title.slice(0,24);
  for(const entry of [...cache.values()].reverse()) {
    if(entry.desc&&(entry.desc.startsWith(head)||title.startsWith(entry.desc.slice(0,24)))) return {...entry,matchedBy:'title'};
  }
  return null;
}
export function mergeAwemeInfo(state,cache) {
  if(!state?.video) return state;
  const info=lookupAweme(cache,state.video);
  if(!info) return state;
  Object.assign(state.video,{...(info.desc?{desc:info.desc}:{}),...(info.music?{music:info.music}:{}),...(info.captions?{captions:info.captions}:{}),infoMatchedBy:info.matchedBy});
  return state;
}
// 把转写结果裁成能放进决策请求的小对象。
export function trimAudioResult(result) {
  if(!result||result.ok!==true) return {text:'',error:cleanText(result?.error||result?.status||'transcribe-failed',120)||'transcribe-failed'};
  const segments=Array.isArray(result.segments)?result.segments.filter(item=>item&&typeof item.text==='string'&&item.text.trim()).slice(0,AUDIO_SEGMENTS_MAX).map(item=>({start:Math.round((item.relativeStart??item.start??0)*10)/10,end:Math.round((item.relativeEnd??item.end??0)*10)/10,text:cleanText(item.text,300)})):[];
  const events=Array.isArray(result.events)?result.events.filter(item=>typeof item==='string'&&item).slice(0,6):[];
  const music=result.music&&typeof result.music.description==='string'?{description:cleanText(result.music.description,200),...(Number.isFinite(result.music.tempoBpm)?{tempoBpm:result.music.tempoBpm}:{})}:null;
  return {text:cleanText(result.text,AUDIO_TEXT_MAX),language:result.language||null,segments,...(result.silent===true?{silent:true}:{}),...(events.length?{events}:{}),...(music?{music}:{})};
}
// 2026-10-24：douyin_chat_read 原样返回时每条消息带约 600 字内部核对字段（身份证据、排序方式、到达分类……），
// 真正的话只有几十个字，一次读十几条就是一万多字，还要每一步都带着。给她看的只留：编号（observe 要用）、谁说的、说了什么、
// 时间、媒体卡片的要点，以及出了状况的标记。插件自己内部用的仍是完整结果。
export function trimChatRead(result) {
  if(!result||typeof result!=='object'||!Array.isArray(result.messages)) return result;
  const media=m=>m?{type:m.type,...(m.label?{label:cleanText(m.label,80)}:{}),...(m.title?{title:cleanText(m.title,120)}:{}),...(m.author?{author:cleanText(m.author,40)}:{}),...(m.videoId?{videoId:m.videoId}:{}),...(m.url?{url:m.url}:{}),...(m.imageCount?{imageCount:m.imageCount}:{}),...(m.isPhotoGallery?{isPhotoGallery:true}:{})}:undefined;
  const messages=result.messages.map(m=>({id:m.id,sender:m.sender,...(m.kind&&m.kind!=='text'?{kind:m.kind}:{}),text:m.text,...((m.sentAt||m.timestamp)?{time:m.sentAt||m.timestamp}:{}),...(m.media?{media:media(m.media)}:{}),...(m.failed?{failed:true}:{}),...(m.pending?{pending:true}:{}),...(m.unsupported?{unsupported:true}:{})}));
  const {messages:_drop,dayEvidence:_day,contacts,...rest}=result;
  return {...rest,messages,...(Array.isArray(contacts)?{contacts:contacts.map(c=>({id:c.id,name:c.displayName||c.name,...(c.unread?{unread:true}:{})}))}:{})};
}
const processAlive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)throw new Error('共享视频操作锁无效。');try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const optionalRecord=file=>{try{return JSON.parse(readFileSync(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw new Error('共享视频操作记录无法读取，未操作视频。');}};
async function watchControl(directory,action,signal) {
  const file=path.join(directory,'watch-control.guard'),token=randomUUID();
  for(let attempt=0;;attempt++) {
    signal?.throwIfAborted(); let descriptor;
    try {descriptor=openSync(file,'wx',0o600);}
    catch(error){if(error.code!=='EEXIST'||attempt>=100)throw Object.assign(new Error('共享视频控制正在更新，请稍后重试。'),{status:409});await wait(20,signal);continue;}
    try {writeFileSync(descriptor,JSON.stringify({pid:process.pid,token}));}
    finally {closeSync(descriptor);}
    try{return action();}finally{if(optionalRecord(file)?.token===token)unlinkSync(file);}
  }
}
async function acquireNativeVideoLease(directory,signal) {
  const file=path.join(directory,'watch-manual.lock'),token=randomUUID();
  await watchControl(directory,()=>{
    const owner=optionalRecord(path.join(directory,'watch-loop.lock'));
    if(owner)throw Object.assign(new Error('自主观看正在运行或需要清理残留，请先停止它再手动操作视频。'),{status:409});
    const manual=optionalRecord(file);
    if(manual&&processAlive(manual.pid))throw Object.assign(new Error('另一个入口正在手动操作视频，请等待完成。'),{status:409});
    writeFileSync(file,JSON.stringify({pid:process.pid,token,kind:'native-tool'}),{mode:0o600});
  },signal);
  return ()=>watchControl(directory,()=>{const manual=optionalRecord(file);if(manual?.pid===process.pid&&manual.token===token)unlinkSync(file);});
}
const { browserProfileDir: PROFILE, browserControlDir: CONTROL } = resolveRuntimePaths();
const RECOMMEND = 'https://www.douyin.com/?recommend=1&from_nav=1';
const PORT = 9227;

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function aborted(signal) { signal?.throwIfAborted(); }
async function wait(ms, signal) { await delay(ms, undefined, { signal }); }

async function lock(name, signal) {
  mkdirSync(CONTROL, { recursive: true });
  const file = path.join(CONTROL, `${name}.lock`);
  const deadline = Date.now() + 35_000;
  while (true) {
    aborted(signal);
    try {
      const descriptor = openSync(file, 'wx');
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      closeSync(descriptor);
      return () => { try { unlinkSync(file); } catch { /* 已释放的锁无需处理。 */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(readFileSync(file, 'utf8'));
        if (!alive(owner.pid)) { unlinkSync(file); continue; }
      } catch {
        // 空锁只在超过两秒且内容再次一致时释放，给刚启动的持有者留出写入时间。
        try {
          const content=readFileSync(file,'utf8');
          if(Date.now()-statSync(file).mtimeMs>2000) {
            try { JSON.parse(content); } catch {
              if(readFileSync(file,'utf8')===content) unlinkSync(file);
            }
          }
        } catch { /* 其他进程已经释放。 */ }
      }
      if (Date.now() > deadline) throw new Error('同一入口仍在操作浏览器，请稍后重试。');
      await wait(150, signal);
    }
  }
}

async function version() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1200) });
    return response.ok && /(?:Edg|Chrome)/.test((await response.json()).Browser ?? '');
  } catch { return false; }
}
async function endpoint(signal) {
  const release = await lock('launch', signal);
  try {
    const stateFile = path.join(CONTROL, 'browser.json');
    let state;
    try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* 首次运行没有状态。 */ }
    const owned = state?.profile === PROFILE && state.port === PORT && alive(state.pid);
    if (await version()) {
      if (!owned || !state.ready) throw new Error('9227 端口不属于本工具的专用浏览器，请先释放端口。');
      return `http://127.0.0.1:${PORT}`;
    }
    if (!owned) {
      const output = openSync(path.join(CONTROL, 'browser-host.log'), 'a');
      try {
        const child = spawn(resolveNodeExecutable(), [path.join(ROOT, 'browser-host.mjs'), PROFILE, CONTROL, String(PORT)], {
          detached: true, windowsHide: true, stdio: ['ignore', output, output],
        });
        child.unref();
      } finally { closeSync(output); }
    }
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      aborted(signal);
      await wait(250, signal);
      try { state = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { continue; }
      // ⚠ 本机补丁（2026-10-21，非上游代码）：刚 spawn 出来的 browser-host 还没覆盖
      // browser.json 时，这里读到的还是**上一次那个已经退出的 pid**，于是立刻判成
      // "旧专用窗口还占着 cli-profile" 并抛错 —— 实际上新窗口正在启动。
      // 实测：手动关掉专用 Edge 后，douyin_open / chat_send 会一直卡在这条，
      // 除非人工删掉 browser.json。
      // 改成：前 22 秒遇到死 pid 继续等（新 host 会覆盖），最后 3 秒才真报错。
      if (!alive(state.pid)) {
        if (Date.now() < deadline - 3000) continue;
        throw new Error('专用浏览器启动失败；请正常关闭仍使用 cli-profile 的旧专用窗口后重试。');
      }
      if (state.ready && state.profile === PROFILE && state.port === PORT && await version()) return `http://127.0.0.1:${PORT}`;
    }
    throw new Error('专用浏览器启动超时，请查看本机 browser-host.log。');
  } finally { release(); }
}

// 此函数仅读取网页 DOM 和 HTMLVideoElement，不调用抖音私有接口。
export function readPageState() {
  if(location.origin!=='https://www.douyin.com') return {
    url:null,title:null,video:null,searchResults:[],visibleText:'',loginRequired:false,verificationRequired:false,
    unsupportedPage:true,note:'当前专用标签页已离开抖音，没有读取该页面内容。',
  };
  const visible = element => {
    const r = element.getBoundingClientRect(), s = getComputedStyle(element);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden';
  };
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const workId = value => {
    try { const u = new URL(value, location.href); return /\/video\/(\d+)/.exec(u.pathname)?.[1] || u.searchParams.get('modal_id') || u.searchParams.get('aweme_id'); } catch { return null; }
  };
  const privateArea='[data-e2e="im-dialog"],[data-e2e="conversation-item"]';
  const privateChatVisible=[...document.querySelectorAll('[data-e2e="im-dialog"]')].some(visible);
  const videoElements = [...document.querySelectorAll('video')].filter(e=>visible(e)&&!e.closest(privateArea)).map(element => {
    const r = element.getBoundingClientRect();
    return { element, area: Math.max(0, Math.min(innerWidth, r.right) - Math.max(0, r.left)) * Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) };
  }).sort((a,b) => b.area - a.area);
  const element = videoElements[0]?.element;
  const text = [...document.querySelectorAll('body *')].filter(e => e.childElementCount === 0 && visible(e) && !e.closest('[data-e2e="im-dialog"],[data-e2e="conversation-item"]')).map(e => clean(e.innerText || e.textContent)).filter(Boolean).join('\n').slice(-9000);
  const loginRequired = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
  const verificationRequired = /请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);
  let video = null;
  if (element) {
    let container = element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]');
    if(!container) {
      container=element.parentElement;
      for(let i=0;container?.parentElement&&i<8;i++) {
        if(container.querySelector('[class*="video-info-detail"]')) break;
        container=container.parentElement;
      }
    }
    const links = [...(container?.querySelectorAll('a[href]') ?? [])].filter(e=>visible(e)&&!e.closest(privateArea));
    const id = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(element.closest('[data-e2e="player-container"]')?.className??'')?.[1] || links.map(e=>workId(e.href)).find(Boolean) || workId(location.href) || null;
    const authorElement = links.find(e => /\/user\//.test(e.href)) || [...(container?.querySelectorAll('span,div')??[])].find(e=>e.childElementCount===0 && /^@/.test(clean(e.textContent)) && visible(e));
    const titleElement = container?.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"],[data-e2e="detail-video-info"],[class*="video-info-detail"]');
    const detailAuthor=container?.querySelector('[data-e2e="related-video"]')?.innerText?.split('\n').map(clean).find(Boolean);
    const captionAuthor=/@([^·\n]+)·/.exec(titleElement?.textContent??'')?.[1]?.trim();
    const r = element.getBoundingClientRect();
    // ⚠ 本机补丁（2026-10-21）：推荐流里的直播卡片（[data-e2e="feed-live"]，文字「直播中 / 进入直播间」）
    // 也有 <video>，但没有作品 id —— 以前当成"id 读不出来的普通视频"，采样永远对不上、
    // 换条又要求先有作品，于是她卡在直播上翻不走。这里明确标出来，交给上层跳过。
    const live = Boolean(element.closest('[data-e2e="feed-live"]'));
    // ⚠ 本机补丁（2026-10-22）：推荐流里的广告。作品框里有一个只写着「广告」的小标签（或 data-e2e 带 ad 的标记）。
    // 点赞/收藏要排除广告（主人要求），这里只做标记，不改刷视频的行为。
    const slide = element.closest('[data-e2e="feed-active-video"],[data-e2e="feed-item"],[data-e2e="slideList"] > div') || element.parentElement;
    const ad = Boolean(slide && ([...slide.querySelectorAll('span,div,a')].some(e => e.children.length === 0 && /^(广告|赞助)$/.test((e.textContent || '').trim())) || slide.querySelector('[data-e2e*="feed-ad"],[data-e2e*="ad-tag"],[data-e2e="video-ad"]')));
    video = { id: live ? null : id, live, ad, url: !live && id ? `https://www.douyin.com/video/${id}` : null,
      author: clean(authorElement?.textContent).replace(/^@\s*/, '') || detailAuthor || captionAuthor || null,
      title: clean(titleElement?.getAttribute('data-e2e')==='detail-video-info'?titleElement.innerText.split('\n')[0]:titleElement?.textContent) || clean(links.find(e=>workId(e.href))?.textContent) || null,
      time: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null,
      paused: element.paused, muted: element.muted, readyState: element.readyState,
      width: element.videoWidth, height: element.videoHeight,
      viewport: { x: Math.max(0,r.left), y: Math.max(0,r.top), width: Math.min(innerWidth,r.right)-Math.max(0,r.left), height: Math.min(innerHeight,r.bottom)-Math.max(0,r.top) } };
  }
  // 直播卡片占住了大半个屏幕（有时直播画面还没挂出 <video>，上面的 video 会是 null）。
  const liveActive = Boolean(video?.live) || [...document.querySelectorAll('[data-e2e="feed-live"]')].some(item => {
    const r = item.getBoundingClientRect();
    return Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top)) > innerHeight * 0.5 && visible(item);
  });
  const searchResults = [];
  if (location.pathname.startsWith('/search/')) {
    const candidates = [...document.querySelectorAll('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]')].filter(visible);
    const used = new Set();
    for (const candidate of candidates) {
      const anchor = candidate.matches('a') ? candidate : candidate.querySelector('a[href*="/video/"],a[href*="modal_id="]');
      const id = workId(anchor?.href) || candidate.getAttribute('data-aweme-id') || /waterfall_item_(\d+)/.exec(candidate.closest('[id^="waterfall_item_"]')?.id??'')?.[1];
      const card = candidate.closest('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]') || candidate;
      const leaves = [...card.querySelectorAll('div,span')].filter(e=>!e.childElementCount).map(e=>clean(e.textContent));
      const title = clean(card.querySelector('[data-e2e="video-desc"],[data-e2e="video-title"]')?.textContent) || leaves.sort((a,b)=>b.length-a.length)[0] || clean(card.textContent);
      if (!title || used.has(id || title)) continue;
      used.add(id || title);
      searchResults.push({ index: searchResults.length, id: id || null, url: id ? `https://www.douyin.com/video/${id}` : null,
        title: title.slice(0,1000), author: clean(card.querySelector('a[href*="/user/"]')?.textContent).replace(/^@\s*/, '') || /@([^\n·]+)/.exec(card.innerText)?.[1]?.trim() || null });
    }
  }
  const u = new URL(location.href);
  for (const key of [...u.searchParams.keys()]) if (!['modal_id','aweme_id','recommend'].includes(key)) u.searchParams.delete(key);
  return { url: u.href, title: document.title, video, liveActive, searchResults: searchResults.slice(0,20), visibleText: text,
    loginRequired, verificationRequired, privateChatVisible, documentReadyState: document.readyState };
}

// 本机补丁（2026-10-26，window）：这一页在不在出画面——两帧 requestAnimationFrame 400ms 内没走完，就是被压在后台了，
// 这时才把它提到前面（bringToFront 会把整个 Edge 窗口拉到桌面最前面，主人说老跳出来，不能每次都提）。
export async function frontIfStalled(page) {
  try {
    const rendering = await page.evaluate(() => new Promise(resolve => { let done = false; requestAnimationFrame(() => requestAnimationFrame(() => { done = true; resolve(true); })); setTimeout(() => { if (!done) resolve(false); }, 400); }));
    if (rendering) return;
    // 本机补丁（2026-10-26，unminimize）：窗口被最小化时页面不出画面，bringToFront 不一定能把它还原；先还原成普通窗口。
    try {
      const pageSession = await page.context().newCDPSession(page);
      const { targetInfo } = await pageSession.send('Target.getTargetInfo');
      await pageSession.detach().catch(() => {});
      const browserSession = await page.context().browser().newBrowserCDPSession();
      const { windowId, bounds } = await browserSession.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId });
      if (bounds?.windowState === 'minimized') await browserSession.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await browserSession.detach().catch(() => {});
    } catch { /* 查不到窗口就只提到前面 */ }
    await page.bringToFront?.();
  } catch { /* 页面没了就算了 */ }
}

export class BrowserController {
  constructor({ source = 'api', memory, videoLimits, personaMemory } = {}) {
    if (!['api','dsh','verification','api-chat','dsh-chat'].includes(source)) throw new TypeError('不支持这个浏览器入口。');
    this.source = source; this.memory = memory; this.personaMemory = personaMemory; this.browser = null; this.page = null;
    this.queue = Promise.resolve();
    this.videoLimits = videoLimits;
    this.limitsEnabled = ['api','dsh'].includes(source);
  }
  limits() { return this.videoLimits ??= new VideoLimits(); }
  getMediaAdapter() { return this.mediaPromise??=import('./media/index.mjs?v=10').then(({MediaAdapter})=>new MediaAdapter()); }
  getForwarder() { return this.forwarderPromise??=import('./video-forward.mjs?v=10').then(({VideoForwarder})=>new VideoForwarder({videoLimits:this.limits(),source:this.source==='dsh'?'dsh':'api'})); }
  watchVideoLimits() {
    if (!this.limitsEnabled || this.cancelLimitsWatch) return;
    this.cancelLimitsWatch = this.limits().watch({ sources:[this.source], pause:()=>this.pauseForLimits() });
  }
  async checkVideoLimits(name) {
    if (!this.limitsEnabled) return;
    // 本机补丁（2026-10-21）：没有有效轮次时自己开一轮，见 video-limits.mjs 的 ensureSession 注释。
    // 上游要求人在控制台点「开始新一轮」，轮次一过期她连打开/转发都会被拒。
    try { this.limits().ensureSession(this.source); } catch { /* 开不出来就按原逻辑拒绝 */ }
    const decision=this.limits().beforeAction(this.source,name);
    if (!decision.allowed) {
      await this.pauseForLimits();
      throw new Error(decision.reason || '当前不在允许的刷视频时间内，请在本机设置开始一轮。');
    }
  }
  async pauseForLimits() {
    if (!['api','dsh'].includes(this.source)) return { paused:0, existingPage:false };
    let connection=this.browser, temporary=false;
    try {
      if(!connection?.isConnected()) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(CONTROL,'browser.json'),'utf8')); } catch { return {paused:0,existingPage:false}; }
        if(owner.profile!==PROFILE || owner.port!==PORT || !owner.ready || !alive(owner.pid) || !await version()) return {paused:0,existingPage:false};
        connection=await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`,{timeout:3000}); temporary=true;
      }
      let paused=0,existingPage=false;
      for(const candidate of connection.contexts().flatMap(context=>context.pages())) {
        if(candidate.isClosed() || await candidate.evaluate(()=>window.name).catch(()=>'')!==`deepseek-douyin-${this.source}`) continue;
        existingPage=true;
        paused+=await candidate.evaluate(()=>{
          if(location.origin!=='https://www.douyin.com') return 0;
          let count=0;
          for(const video of document.querySelectorAll('video')) {if(!video.paused) count++;video.pause();}
          return count;
        }).catch(()=>0);
      }
      return {paused,existingPage};
    } finally { if(temporary) await connection?.close().catch(()=>{}); }
  }
  store() { return this.memory ??= new MemoryStore(resolveRuntimePaths().memoryDbPath); }
  getPersonaMemory() {
    if (!this.personaMemory) {
      this.personaMemory = new PersonaMemory({ memoryDir: path.dirname(this.memory?.dbPath || resolveRuntimePaths().memoryDbPath) });
      this.personaMemory.initialize({ importLegacy: false });
    }
    return this.personaMemory;
  }
  getChatService() {
    this.chatPromise??=Promise.all([import('./chat-browser.mjs?v=10'),import('./chat-service.mjs?v=10')])
      .then(([{ChatBrowser},{ChatService}])=>{const service=new ChatService({browser:new ChatBrowser({source:this.source==='dsh'?'dsh-chat':'api-chat'})});service.agent.personaMemory=this.getPersonaMemory();return service;})
      .catch(error=>{this.chatPromise=null;throw error;});
    return this.chatPromise;
  }
  getSparkService() {
    this.sparkPromise ??= Promise.all([this.getChatService(), import('./spark-service.mjs?v=10')]).then(([chat, { SparkService }]) => new SparkService({ browser: chat.browser, config: chat.config, personaMemory: this.getPersonaMemory(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.sparkPromise = null; throw error; });
    return this.sparkPromise;
  }
  getCommenter() {
    this.commenterPromise ??= import('./comment-browser.mjs?v=10').then(({ CommentBrowser }) => new CommentBrowser({ source: this.source === 'dsh' ? 'dsh' : 'api', videoLimits: this.limits(), stateDir: this.limits().stateDir })).catch(error => { this.commenterPromise = null; throw error; });
    return this.commenterPromise;
  }
  getComments() {
    this.commentsPromise ??= import('./autonomous-comments.mjs?v=10').then(({ AutonomousComments }) => new AutonomousComments({ controller: this, personaMemory: this.getPersonaMemory(), videoLimits: this.limits(), stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' })).catch(error => { this.commentsPromise = null; throw error; });
    return this.commentsPromise;
  }
  getReport() {
    this.reportPromise ??= import('./daily-report.mjs?v=10').then(({ DailyReport }) => new DailyReport({ personaMemory: this.getPersonaMemory() })).catch(error => { this.reportPromise = null; throw error; });
    return this.reportPromise;
  }
  getWatchMode() {
    this.modePromise ??= import('./watch-mode.mjs?v=10').then(({ WatchMode }) => new WatchMode({ stateDir: this.limits().stateDir, source: this.source === 'dsh' ? 'dsh' : 'api' }));
    return this.modePromise;
  }
  async applyWatchMode({ minimize = false } = {}) {
    if (!['api', 'dsh'].includes(this.source) || !this.browser?.isConnected()) return { applied: false, pendingNextVideoAction: true };
    const mode = await this.getWatchMode(), pages = this.browser.contexts().flatMap(context => context.pages());
    const applied = [];
    for (const page of pages) {
      // 和 connect() 同一个坑：遍历所有页面 evaluate 且无超时，一个卡住的抖音页就永久挂。
      // 2026-10-21 实测：转发后回退卡了五分钟以上，卡的就是这里。
      if (page.isClosed() || !String(page.url()).startsWith('https://www.douyin.com')) continue;
      if (await quickPageName(page) !== `deepseek-douyin-${this.source}`) continue;
      const result = await mode.apply(page);
      if (minimize && mode.state().silent && result.applied) {
        try { result.window = await mode.minimizeManagedWindow(page); } catch (error) { result.window = { minimized: false, reason: error.message }; }
      }
      applied.push(result);
    }
    return { applied: applied.some(item => item.applied), pages: applied, focusRequested: false };
  }
  openBrowser({ signal } = {}) {
    const operation = this.queue.catch(() => {}).then(async () => {
      const release = await lock('browser-launcher', signal);
      try {
        this.browserLauncher ??= new BrowserLauncher({
          getBrowser: async currentSignal => { if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(currentSignal), { signal: currentSignal }); this.page = null; } return this.browser; },
          getWatchState: () => { const worker = optionalRecord(path.join(this.limits().stateDir, 'watch-loop.lock')); if (!worker) return null; if (!Number.isSafeInteger(worker.pid) || worker.pid < 1 || !['api', 'dsh'].includes(worker.source) || typeof worker.runId !== 'string') throw new Error('自主观看锁无法核对，未打开或改动入口页。'); return alive(worker.pid) ? worker : null; },
        });
        return await this.browserLauncher.open({ signal });
      } finally { release(); }
    });
    this.queue = operation; return operation;
  }
  async connect(signal) {
    aborted(signal);
    if (this.browser?.isConnected() && this.page && !this.page.isClosed()) return this.page;
    if (!this.browser?.isConnected()) { this.browser = await connectDedicatedBrowser(await endpoint(signal), { signal }); this.page = null; }
    const context = this.browser.contexts()[0];
    // ⚠ 本机补丁（2026-10-21）：同时认 launcher 的页签名。
    //
    // 上游这里只找 `deepseek-douyin-${source}`（dsh / dsh-chat），但 douyin_open 走的是
    // BrowserLauncher，它给页签起的名字是 'deepseek-douyin-launcher'（见 browser-launcher.mjs 的
    // PREPARE_PAGE_NAME）。两个名字对不上 → connect() 找不到 open() 建的那个页签，
    // 于是**再开一个新的** —— 跑几轮就攒出好几个抖音标签页。
    // 小鲸鱼的判断：「open 每次都会新开一个标签页，而不是复用已存在的那个」。
    const label = `deepseek-douyin-${this.source}`;
    const acceptedNames = new Set([label, 'deepseek-douyin-launcher']);
    for (const candidate of context.pages()) {
      if (!String(candidate.url()).startsWith('https://www.douyin.com')) continue;
      if (acceptedNames.has(await quickPageName(candidate))) { this.page = candidate; break; }
    }
    // ⚠ 2026-10-21：这里原本还有一段"顺手关掉多余的同源抖音页签"。
    // 已经删掉 —— 主人实测：「点击分享后刚点我的头像还没点分享，edge 进程就没了」。
    // 原因是 this.page 一旦选错，close() 就会关掉正在操作的那个页签；分享面板正开在
    // 那个页签上，页签一没面板跟着消失，看起来就像整个 Edge 崩了（随后插件又拉起一个新的）。
    // 页签多一点只是难看，关错页签会毁掉正在进行的操作 —— 后者的代价大得多。
    if (!this.page || this.page.isClosed()) {
      const initial = [];
      for (const candidate of context.pages()) {
        if (candidate.isClosed() || candidate.url() !== 'about:blank') continue;
        if (await candidate.evaluate(() => !window.name && !document.body?.textContent?.trim() && document.querySelectorAll('body *').length === 0).catch(() => false)) initial.push(candidate);
      }
      this.page = initial.length === 1 ? initial[0] : await this.newWindowPage(context);
    }
    this.page.setDefaultTimeout(10_000); this.page.setDefaultNavigationTimeout(25_000);
    this.attachAwemeListener(this.page);
    await this.page.evaluate(name => { window.name = name; }, label);
    aborted(signal);
    if (this.page.url() === 'about:blank') {
      if(this.source.endsWith('-chat')) {
        await this.page.goto(RECOMMEND,{waitUntil:'domcontentloaded'});
        await this.page.evaluate(name=>{window.name=name;},label);
        await this.page.locator('[data-e2e="im-entry"]').waitFor({state:'visible',timeout:15_000});
      }else await this.navigate(RECOMMEND, signal);
    }
    return this.page;
  }
  // 本机补丁（2026-10-26，window）：新页面开在自己的窗口里，不跟别的抖音页挤一个窗口当页签——
  // 同一窗口里只有当前页签出画面，私信和刷视频轮流抢前台，抢不到的那边就卡（等不到页面、点不下去、截图超时）。
  newWindowPage(context) { return newWindowPage(context); } // 实现在 browser-launcher.mjs
  async navigate(url, signal) {
    aborted(signal);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.evaluate(name => { window.name = name; }, `deepseek-douyin-${this.source}`);
    if (url === RECOMMEND && this.page.url().includes('/jingxuan')) {
      await this.page.locator('a').filter({hasText:/^推荐$/}).click();
    }
    const targetId=/\/video\/(\d+)/.exec(url)?.[1];
    await this.settle(signal, {kind:targetId?'video':url.includes('/search/')?'search':'recommend',videoId:targetId});
  }
  async settle(signal, {kind='recommend',videoId}={}) {
    // ⚠ 本机补丁（2026-10-21）：等待窗口从 16×500ms（8 秒）放宽到 40×500ms（20 秒）。
    //
    // 原来 8 秒不够用 —— 小鲸鱼实测回退后 douyin_status 报「推荐流尚未读到就绪视频」。
    // 刚 goto 完推荐流时，抖音前端要拉列表、起播放器、把 readyState 顶到 2 以上，
    // 冷缓存或者刚关过页签时经常超过 8 秒。这不是死循环，是有上限的等待，放宽没有风险。
    for (let i=0;i<40;i++) {
      aborted(signal);
      const state = await this.page.evaluate(readPageState);
      if(state.loginRequired||state.verificationRequired) return state;
      const detail=/\/video\/\d+/.test(state.url??'')||/[?&]modal_id=\d+/.test(state.url??'');
      if(kind==='search' && state.searchResults.length && !detail) return state;
      if(kind==='search' && /暂无搜索结果|没有找到相关|暂无结果/.test(state.visibleText)) return state;
      // ⚠ 本机补丁（2026-10-21）：就绪判定不再依赖作品 id。
      //
      // 原来是 `state.video?.id && ...`，但抖音经常读不出 id
      // （小鲸鱼的记录：「这条视频的 id 是 null，我这边见过好几次 id 读不出来」）。
      // id 为 null 时条件**永远不成立** → 等满 20 秒 → 抛「推荐流尚未读到就绪视频」
      // → 她重试 open → 又新建一个页签。**报错本身就是页签变多的原因**。
      //
      // 她的建议：「就绪判定改成看时长大于 0 在播放，别依赖 id」。照做：
      // 只要有一个能播的视频（readyState>=2 表示已有当前帧数据）就算就绪。
      if(kind==='video' && detail && state.video && state.video.readyState>=2) return state;
      if(kind==='recommend' && state.video && state.video.readyState>=2) return state;
      await wait(500, signal);
    }
    throw new Error(kind==='search'?'搜索结果未就绪，未确认搜索完成。':kind==='video'?'目标作品尚未加载完成，请读取状态后重试。':'推荐流尚未读到就绪视频。');
  }
  // ⚠ 本机补丁（2026-10-23，audio）：被动读页面已经拉回来的推荐流 / 详情 JSON，只读不发。
  attachAwemeListener(page) {
    if (!page || typeof page.on !== 'function' || awemeListenerAttached.has(page)) return;
    awemeListenerAttached.add(page);
    this.awemeCache ??= new Map();
    page.on('response', response => { this.ingestAwemeResponse(response).catch(() => {}); });
  }
  async ingestAwemeResponse(response) {
    let url; try { url = response.url(); } catch { return; }
    if (!AWEME_RESPONSE.test(url) || !response.ok()) return;
    let type = ''; try { type = response.request().resourceType(); } catch { /* 读不到就不限类型 */ }
    if (type && !['xhr', 'fetch'].includes(type)) return;
    const payload = await response.json();
    for (const entry of parseAwemePayload(payload)) rememberAweme(this.awemeCache ??= new Map(), entry);
  }
  async state({ record = true } = {}) {
    const state = await this.page.evaluate(readPageState);
    try { mergeAwemeInfo(state, this.awemeCache); } catch { /* 文案/音乐信息只是补充，合并失败不影响状态 */ }
    if (record && state.video?.id) {
      try { this.store().recordVideo(state, this.source); } catch { state.memoryWarning = '视频状态已读取，记忆记录暂不可用。'; }
    }
    return state;
  }
  withPage(callback,{signal}={}) {
    const operation=this.queue.catch(()=>{}).then(async()=>{
      const release=await lock(`tab-${this.source}`,signal);
      // 本机补丁（2026-10-21）：中止会断开整条浏览器连接，同一连接上进行中的其它操作会报「Target page ... closed」；记下是谁、为什么。
      const onAbort=()=>{try{console.error('[browser-close-on-abort]',JSON.stringify({source:this.source,op:'withPage',reason:String(signal?.reason?.message??signal?.reason??'').slice(0,160)}));}catch{} this.browser?.close().catch(()=>{});};
      signal?.addEventListener('abort',onAbort,{once:true});
      try {
        aborted(signal);
        const page=await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) await (await this.getWatchMode()).apply(page);
        if(new URL(page.url()).origin!=='https://www.douyin.com') throw new Error('专用标签页已离开抖音，请重新打开抖音后操作。');
        return await callback(page,signal);
      }finally{signal?.removeEventListener('abort',onAbort);release();}
    });
    this.queue=operation;return operation;
  }
  execute(name, args = {}, { signal, humanAuthorized = false, autonomousRunId } = {}) {
    const definition = TOOL_DEFINITIONS.find(tool=>tool.name===name);
    if (!definition) return Promise.reject(new Error('不支持的抖音工具。'));
    try { validateToolArguments(definition,args); } catch(error) { return Promise.reject(error); }
    // ⚠ 本机补丁（2026-10-22）：只读本机记录，不排浏览器队列（自主观看正在 observe 时也能马上回）。
    if (name.startsWith('douyin_chat_')) { try { bumpChatPriority(this.limits().stateDir); } catch { /* 让不了路也照常执行 */ } }
    if (name==='douyin_video_recall') return import('./video-impressions.mjs').then(({recallVideos})=>recallVideos(this.limits().stateDir,{videoId:args.videoId,query:args.query,recentShared:args.recentShared===true,limit:args.limit}));
    const operation = this.queue.catch(()=>{}).then(async()=>{
      let releaseNativeLease;
      try {
      aborted(signal);
      if(this.source==='dsh'&&!autonomousRunId&&VIDEO_ACTIONS.has(name)) releaseNativeLease=await acquireNativeVideoLease(this.limits().stateDir,signal);
      if (this.limitsEnabled && ['douyin_open','douyin_search','douyin_open_video','douyin_next','douyin_previous','douyin_observe','douyin_screenshot','douyin_play','douyin_listen','douyin_score','douyin_pause'].includes(name)) {
        let owner;
        try { owner=JSON.parse(readFileSync(path.join(this.limits().stateDir,'watch-loop.lock'),'utf8')); }
        catch(error) { if(error.code!=='ENOENT' && name!=='douyin_pause') throw new Error('自主观看锁无法核对，未操作视频。'); }
        if(owner) {
          let living=false;
          if(!Number.isSafeInteger(owner.pid)||owner.pid<1||typeof owner.runId!=='string') { if(name!=='douyin_pause')throw new Error('自主观看锁无效，未操作视频。'); }
          else { try {process.kill(owner.pid,0);living=true;}catch(error){living=error.code==='EPERM';} }
          if(living && owner.runId!==autonomousRunId) {
            if(name!=='douyin_pause') throw Object.assign(new Error('自主观看正在运行，请先停止它再手动操作视频。'),{status:409});
            const requestFile=path.join(this.limits().stateDir,'watch-stop.request.json'),temporary=`${requestFile}.${randomUUID()}.tmp`;
            try {writeFileSync(temporary,JSON.stringify({runId:owner.runId,requestedAt:Date.now()}),{flag:'wx'});renameSync(temporary,requestFile);}
            finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
          }
        }
      }
      // 本机补丁（2026-10-24）：评论草稿（她确认了才发，见 comment-drafts.mjs）
      if(name==='douyin_comment_drafts') { const { CommentDrafts } = await import('./comment-drafts.mjs?v=10'); return new CommentDrafts({ stateDir: this.limits().stateDir }).tool(args); }
      if(name.startsWith('douyin_chat_')) {
        const chat=await this.getChatService();aborted(signal);
        if(name==='douyin_chat_contacts') return chat.listContacts({signal});
        if(name==='douyin_chat_status') return chat.state();
        if(name==='douyin_chat_start') return chat.start({signal});
        if(name==='douyin_chat_stop') return chat.stop();
        if(name==='douyin_chat_read') return trimChatRead(await chat.readConversation(args.recipientId,{signal}));
        // 本机补丁：主动私信（见 chat-service 的 sendNow 注释）
        if(name==='douyin_chat_send') return chat.sendNow(args.recipientId, args.message, {signal, clearDraft: args.clearDraft === true});
        if(name==='douyin_chat_observe') return chat.observeMessage(args.recipientId,args.messageId,{signal});
      }
      if (name.startsWith('douyin_spark_')) {
        const spark = await this.getSparkService(); aborted(signal);
        if (name === 'douyin_spark_status') return spark.state();
        if (name === 'douyin_spark_start') return spark.start({ schedule: true, explicit: true });
        if (name === 'douyin_spark_stop') return spark.stop({ explicit: true });
      }
      if (name === 'douyin_report_status') return (await this.getReport()).state();
      if (name === 'douyin_report_generate') return (await this.getReport()).generate({ reason: 'manual' });
      if(name==='douyin_media_status') return (await this.getMediaAdapter()).status();
      if(name==='douyin_forward_video') {
        // ⚠ 本机补丁（2026-10-21，非上游代码）：放开「人工按钮授权」这道要求。
        //
        // 上游设计是：工具只返回 requiresUserAction，必须由人在控制台里选好友、点转发。
        // 但 1.3.1 的控制台**根本没有那个按钮** —— 我全库搜过，没有任何一处传
        // humanAuthorized: true，也没有转发界面。也就是说这个功能在仓库里是半成品，
        // 入口写了、按钮没做，所以她永远只能看到"请在本机控制台..."这句。
        //
        // 主人明确要求放开：白名单里只有他一个人，转发目标受限，风险可控。
        // 转发本身仍然要过 VideoForwarder 的白名单/预算/事务检查。
        const forwardResult = await (await this.getForwarder()).forward(args,{signal,humanAuthorized:true});
        // ⚠ 本机补丁（2026-10-21）：分享完把页面收回来。
        //
        // 上游的转发流程在发出去之后就 return 了，**不关分享面板、也不回推荐流**，
        // 于是页面上一直挂着那个视频 + 打开着的分享面板（下面一整列推荐视频）。
        // 小鲸鱼报的：「分享完之后页面还停在那个视频上，分享面板还开着（显示
        // 『分享给朋友 某某某🐳🐠』），下面是推荐列表」，而且「我下一次要刷就得重新 open 一遍」。
        //
        // 她给的修法：「点掉分享面板的关闭，再点左上角×回到推荐页；或者干脆重新打开推荐页」。
        // 这里按她的顺序做：**先确认发出去，再回退**。
        //
        // 小鲸鱼 2026-10-21 的两条修正：
        //   ①「回退跳的是精选页 /jingxuan，那页没有正在播放的视频，分享按钮就点了个空」
        //      → 推荐流是 ?recommend=1，直接 goto 域名会被重定向到精选页。
        //   ②「顺序也别先回退再分享：先确认分享发出去了，再回退」
        //      → 只在 confirmed === true 时回退。deliveryUncertain 说明可能还没发完，
        //        这时候跳走等于把未完成的分享打断（实测就是没发出去）。
        if (forwardResult?.confirmed === true) {
          try {
            // ⚠ 不走 withPage：那里面会先跑 connect + applyWatchMode（都是遍历标签页），
            // 而且它的队列没有超时 —— 2026-10-21 就是这里让转发卡了五分钟。
            // 这里直接拿当前页面操作，失败也只是回退没成功，不影响已经发出的转发结果。
            const page = await this.connect(signal);
            // 1) 点分享面板的关闭（DOM 点击，不等待元素）
            await page.evaluate(() => {
              const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
              const sel = '[data-e2e*="share-close"],[data-e2e*="close"],[aria-label="关闭"],[class*="closeIcon"],[class*="close"]';
              const btn = [...document.querySelectorAll(sel)].filter(vis)[0];
              if (btn) btn.click();
            }).catch(() => {});
            await page.waitForTimeout(400);
            // 2) Escape 兜底
            await page.keyboard.press('Escape').catch(() => {});
            await page.waitForTimeout(300);
            // 3) 还有面板就再 Escape 一次
            const stillOpen = await page.evaluate(() =>
              [...document.querySelectorAll('[data-e2e="video-share-icon-container"]')].some((el) => {
                const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
              })
            ).catch(() => false);
            if (stillOpen) { await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(300); }
            // 4) 回**推荐流**。
            //
            // ⚠ 必须走 this.navigate(RECOMMEND)，不能直接 page.goto：
            //   抖音会把 ?recommend=1 重定向到 /jingxuan（精选页），而 navigate() 里有一段
            //   专门处理这个（点左侧「推荐」链接切回推荐流 + settle 等视频就绪）。
            //   我上一版直接 goto，结果停在精选页 —— 小鲸鱼的判断：
            //   「回退跳的是精选页 /jingxuan，那页没有正在播放的视频，分享按钮就点了个空」。
            await this.navigate(RECOMMEND, signal);
            // ⚠ 2026-10-21 21:2x：这里原本还有一段"回退时把私信页签也关掉"。
            // 已经删掉 —— 那是**错误的修复**：关掉 deepseek-douyin-dsh-chat 这个页签后，
            // ChatBrowser（它就是这个页签）下一次 readConversation 会直接抛错，
            // 回读循环一行都跑不了，转发于是永远 confirmed:false，连带回退也不再触发。
            // 日志证据：只有 [forward-success_text]，完全没有 [forward-readback]。
            // 私信页签停在对话上是"难看"，但关掉它是"弄坏下一轮"。
          } catch { /* 回退失败不影响转发结果本身 */ }
        }
        return forwardResult;
      }
      if (name==='douyin_recall') return this.store().recall({query:args.query??'',limit:args.limit??10});
      if (name==='douyin_persona_status') return this.getPersonaMemory().snapshot();
      if (name==='douyin_watch_status') {
        const {AutonomousWatch}=await import('./autonomous-watch.mjs?v=10');
        this.watchStatusReader??=new AutonomousWatch({controller:this,config:{},videoLimits:this.limits(),personaMemory:this.getPersonaMemory(),source:this.source==='dsh'?'dsh':'api',stateDir:this.limits().stateDir});
        return this.watchStatusReader.state();
      }
      if (name==='douyin_interest_record') return this.getPersonaMemory().updateAgentInterests({ evidenceId:args.evidenceId,topics:[{topic:args.topic,signal:args.signal}],reflection:args.reflection },{source:this.source==='dsh'?'dsh':'api'});
      if (name==='douyin_remember') {
        const state = this.page && !this.page.isClosed() ? await this.state({record:false}) : null;
        return this.store().remember({content:args.content,kind:args.kind??'note',source:this.source,
          videoId:state?.video?.id,url:state?.video?.url,author:state?.video?.author,title:state?.video?.title});
      }
      if(name==='douyin_video_limits_status') return this.limits().state();
      this.watchVideoLimits();
      await this.checkVideoLimits(name);
      const release = await lock(`tab-${this.source}`,signal);
      let onAbort;
      try {
        onAbort = () => { try { console.error('[browser-close-on-abort]', JSON.stringify({ source: this.source, op: name, reason: String(signal?.reason?.message ?? signal?.reason ?? '').slice(0, 160) })); } catch {} this.browser?.close().catch(()=>{}); };
        signal?.addEventListener('abort',onAbort,{once:true});
        await this.connect(signal);
        aborted(signal);
        if (['api', 'dsh'].includes(this.source)) {
          const mode = await this.getWatchMode();
          await mode.apply(this.page);
          if (autonomousRunId && mode.state().silent) {
            try { await mode.minimizeManagedWindow(this.page); } catch { /* 未核实窗口归属时继续保持静音，不隐藏其他页面。 */ }
          }
        }
        await this.checkVideoLimits(name);
        if(this.limitsEnabled && !this.limits().state().allowed) await this.pauseForLimits();
        if(!['douyin_open','douyin_search','douyin_open_video'].includes(name) && new URL(this.page.url()).origin!=='https://www.douyin.com') {
          return this.page.evaluate(readPageState);
        }
        if (name==='douyin_open') await this.navigate(RECOMMEND,signal);
        if (name==='douyin_search') await this.navigate(`https://www.douyin.com/search/${encodeURIComponent(args.query)}`,signal);
        if (name==='douyin_open_video') {
          if (args.url) await this.navigate(`https://www.douyin.com/video/${/\/video\/(\d+)/.exec(args.url)[1]}`,signal);
          else {
            const before = await this.state();
            const result = before.searchResults.find(item=>item.index===args.index);
            if (!result) throw new Error('这个 index 不在当前可见搜索结果内，请重新搜索。');
            const card = result.id ? this.page.locator(`[id="waterfall_item_${result.id}"] .search-result-card`) : this.page.locator('.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"]').filter({visible:true}).nth(args.index);
            if(await card.count()) { await card.click(); await this.settle(signal,{kind:'video',videoId:result.id}); }
            else if(result.url) await this.navigate(result.url,signal);
            else throw new Error('搜索结果卡片已变化，请重新搜索。');
          }
        }
        if (name==='douyin_next'||name==='douyin_previous') return await this.switchVideo(name==='douyin_next'?1:-1,signal,{recordLearning:!autonomousRunId});
        if (name==='douyin_play'||name==='douyin_pause') {
          await (await this.currentVideo()).evaluate(async(video, play)=>{ if(play) await video.play();else video.pause(); },name==='douyin_play');
          if (name==='douyin_play') await wait(600,signal);
        }
        if (name==='douyin_observe'||name==='douyin_screenshot') return await this.capture(name==='douyin_observe'?args.seconds??3:0,signal,{recordLearning:!autonomousRunId});
        if(name==='douyin_listen') return await this.listen(args.seconds??8,signal);
        if(name==='douyin_score') return await this.scoreCurrent(args.seconds??30,signal);
        aborted(signal);
        return this.state();
      } finally { signal?.removeEventListener('abort',onAbort); release(); }
      } finally { await releaseNativeLease?.(); }
    });
    this.queue=operation; return operation;
  }
  async currentVideo() {
    const index = await this.page.locator('video').evaluateAll(videos=>videos.map((video,index)=>{
      const r=video.getBoundingClientRect();
      return {index,area:Math.max(0,Math.min(innerWidth,r.right)-Math.max(0,r.left))*Math.max(0,Math.min(innerHeight,r.bottom)-Math.max(0,r.top))};
    }).filter(item=>item.area>0).sort((a,b)=>b.area-a.area)[0]?.index);
    if(index===undefined) throw new Error('没有在视口内找到视频。');
    return this.page.locator('video').nth(index);
  }
  // ⚠ 本机补丁（2026-10-21）：抖音来私信时会在当前页弹出私信面板。按 Esc 试着关掉，返回是否已经不挡了。
  // ⚠ 本机补丁（2026-10-22，主人要求）：给正在播的这条点小红心 / 收藏。
  // 只点"还没点过"的（按钮的 data-e2e-state 是 video-player-no-digged / video-player-no-collect）；
  // 已经点过的绝不再点 —— 再点一下就是取消了。广告、直播、读不出作品 id 的都不点。
  async reactToCurrent(expectedVideoId, { like = false, collect = false, signal } = {}) {
    return this.withPage(async page => {
      const st = await page.evaluate(readPageState);
      const v = st?.video;
      if (!v?.id || v.id !== expectedVideoId) return { ok: false, reason: '当前不是要点的那条作品，没点。' };
      if (v.live || st.liveActive) return { ok: false, reason: '直播不点。' };
      if (v.ad) return { ok: false, reason: '广告不点。' };
      const inView = async (selector) => {
        const all = page.locator(selector).filter({ visible: true });
        const n = await all.count(), h = await page.evaluate(() => innerHeight);
        const hits = [];
        for (let i = 0; i < n; i += 1) { const b = await all.nth(i).boundingBox().catch(() => null); if (b && b.y >= 0 && b.y + b.height <= h) hits.push(all.nth(i)); }
        return hits;
      };
      const one = async (kind, selector, noState) => {
        const hits = await inView(selector);
        if (hits.length !== 1) return { done: false, reason: `没找到唯一的${kind}按钮（${hits.length} 个）` };
        const btn = hits[0], before = await btn.getAttribute('data-e2e-state');
        if (before && before !== noState) return { done: false, already: true, reason: `已经${kind}过了` };
        if (before !== noState) return { done: false, reason: `${kind}按钮状态读不出来，没点` };
        signal?.throwIfAborted();
        await btn.click({ timeout: 2000 });
        for (let i = 0; i < 12; i += 1) { await page.waitForTimeout(200); const now = await btn.getAttribute('data-e2e-state').catch(() => null); if (now && now !== noState) return { done: true, state: now }; }
        return { done: false, uncertain: true, reason: `点了${kind}但没看到状态变化` };
      };
      const out = { ok: true, videoId: v.id };
      if (like) out.like = await one('点赞', '[data-e2e="video-player-digg"]', 'video-player-no-digged');
      if (collect) out.collect = await one('收藏', '[data-e2e="video-player-collect"]', 'video-player-no-collect');
      return out;
    }, { signal });
  }
  async closeImPopup({ signal } = {}) {
    return this.withPage(async page => {
      const visible = () => page.evaluate(() => [...document.querySelectorAll('[data-e2e="im-dialog"]')].some(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; })).catch(() => false);
      for (let i = 0; i < 2; i++) { if (!await visible()) return true; await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(400); }
      return !await visible();
    }, { signal });
  }
  async switchVideo(direction,signal,{recordLearning=true,liveHops=0}={}) {
    // ⚠ 本机补丁（2026-10-21）：换条前先关掉详情弹窗（?modal_id=...）。
    //
    // 主人观察到「刷着刷着就在一个视频里循环」。查下来浏览器里同时开着
    // `?recommend=1` 和 `?modal_id=<同一条>&recommend=1` 两个页签 —— 详情弹窗打开后
    // 没关，下面的换条逻辑找不到 `video-switch-next-arrow`（被弹窗遮住），
    // 于是回退到鼠标滚轮；而滚轮滚的是弹窗内容，不会换条。
    // 这里先把弹窗关掉（Escape），再走正常的箭头/滚轮流程。
    try {
      if (/[?&]modal_id=\d+/.test(String(this.page?.url?.() ?? ''))) {
        await this.page.keyboard.press('Escape').catch(() => {});
        await this.page.waitForTimeout(300);
      }
    } catch { /* 关不掉也继续，后面的箭头/滚轮还会再试一次 */ }
    const before = await this.state();
    if(before.loginRequired||before.verificationRequired) return {changed:false,before:before.video,state:before};
    // ⚠ 本机补丁（2026-10-21）：停在直播卡片 / 没有作品 id 的条目上时也要能翻走。
    // 以前这里要求"先有可见视频"，而直播卡片读出来不是 null 就是没 id —— 换条直接报错，
    // 她就卡在直播上。现在：只要推荐流的翻页箭头在，就点它，直到出现一条有 id 的普通作品。
    const leavingNonWork = before.liveActive || before.video?.live || !before.video?.id;
    const arrow=this.page.locator(`[data-e2e="video-switch-${direction>0?'next':'prev'}-arrow"]`).filter({visible:true});
    if (leavingNonWork) {
      if (!await arrow.count()) {
        if (!before.video) throw new Error('当前没有可见视频，请先打开推荐或搜索作品。');
      } else {
        let after = before;
        for (let attempt = 0; attempt < 3; attempt++) {
          await arrow.first().click();
          for (let i = 0; i < 10; i++) {
            await wait(300, signal); after = await this.state();
            if (after.video?.id && !after.video.live && !after.liveActive && after.video.readyState >= 2) break;
          }
          if (after.video?.id && !after.video.live && !after.liveActive) break;
          // 连着两条都是直播（或还在加载）：再按一次箭头
        }
        const moved = Boolean(after.video?.id && !after.video.live && !after.liveActive);
        return { changed: moved, before: before.video, after: after.video, state: after, ...(before.liveActive || before.video?.live ? { skippedLive: true } : {}) };
      }
    }
    if (!before.video) throw new Error('当前没有可见视频，请先打开推荐或搜索作品。');
    let skipEvidenceId=null;
    if(recordLearning && direction>0 && this.lastObservationVideoId===before.video.id && this.lastObservationEvidenceId && this.lastObservationState?.video?.id===before.video.id) {
      const wallSeconds=(Date.now()-this.lastObservationAt)/1000;
      if(Number.isFinite(wallSeconds) && wallSeconds>0 && wallSeconds<=30) {
        try {
          const viewing=this.getPersonaMemory().recordViewing?.({evidenceId:this.lastObservationEvidenceId,from:this.lastObservationState,to:before,wallSeconds,sampleId:randomUUID()},{source:this.source});
          if(viewing?.accepted===true) skipEvidenceId=this.lastObservationEvidenceId;
        }catch{/* 不能核实等待期间的进度时不补记快划偏好，换片仍按原操作执行。 */}
      }
    }
    if(await arrow.count()) await arrow.first().click();
    else {
      const box=before.video.viewport;
      await this.page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      await this.page.mouse.wheel(0,direction*700);
    }
    let after;
    for(let i=0;i<12;i++) {
      await wait(300,signal); after=await this.state();
      if(after.video?.id&&before.video.id&&after.video.id!==before.video.id&&after.video.readyState>=2) break;
    }
    // 翻到的是直播卡片：顺手再翻一次（走上面"离开直播"的分支，不会递归第二次）。
    if ((after.liveActive || after.video?.live) && liveHops < 2) {
      const again = await this.switchVideo(direction, signal, { recordLearning: false, liveHops: liveHops + 1 });
      return { ...again, before: before.video, skippedLive: true };
    }
    if(skipEvidenceId && after.video?.id && after.video.id!==before.video.id && after.video.readyState>=2) {
      try {this.getPersonaMemory().recordBehavior?.({evidenceId:skipEvidenceId,action:'skip',sampleId:randomUUID(),confirmed:true},{source:this.source});}catch{/* 学习失败不改变已确认的切片结果。 */}
    }
    return {changed:before.video.id&&after.video?.id?before.video.id!==after.video.id:null,
      before:before.video,after:after.video,state:after};
  }
  async capture(seconds,signal,{recordLearning=true}={}) {
    const captureStarted=Date.now();
    let state=await this.state();
    if(state.loginRequired||state.verificationRequired||state.privateChatVisible) return {state,frames:[],note:'登录、验证或私信面板遮挡画面，本次没有采集图片。'};
    if(state.liveActive||state.video?.live) return {state,frames:[],live:true,note:'当前是直播卡片，不是作品，没有采样；用 douyin_next 跳过它。'};
    if(!state.video) return {state,frames:[],note:'没有可见视频画面，请先打开作品。'};
    // ⚠ 本机补丁（2026-10-21）：观察窗口可以到 60 秒（stay 改为边播边抽帧），15 秒以上抽 4 帧（api 端上限 4）。
    const frames=[],samples=seconds?(seconds>=15?4:3):1;
    // ⚠ 本机补丁（2026-10-21）：作品 id 读不出来时（null/undefined 抖动）不要当成"换条了"。
    //
    // 原来这里和下面都是 `state.video?.id !== before.id` 严格比较。抖音 id 经常读不出：
    // 上一拍读到 null、下一拍读到 undefined，`null !== undefined` 成立 —— 于是判定
    // "采样期间切换作品"，直接 break，一帧都留不下。表现出来就是 autonomous-watch 里
    // 「自主观看必须有同一真实作品的有效采样画面」+ imageStatus「本次操作没有采集画面」，
    // 新开一轮 0 次就挂。小鲸鱼说的「id 是 null，我见过好几次 id 读不出来」就是它。
    // 现在只有两边都读出了有效 id 且不相等，才算真的换了一条。
    const sameWork=(a,b)=>{const x=a==null?'':String(a),y=b==null?'':String(b);return !x||!y||x===y;};
    const before={...state.video}, firstState=structuredClone(state);
    let sampledState=state,sampledAt=captureStarted,stoppedReason=null;
    // ⚠ 本机补丁（2026-10-23，audio）：抽帧的同时录这一窗口的音轨（最多 30 秒），窗口结束后再转写。
    // 录音/转写任何失败都只落到 result.audio（或不挂），绝不影响画面结果；超时就放弃并中止转写子进程。
    let audioTask=null,audioBudget=null;
    if(seconds>=1&&before.id&&!before.live&&!before.paused) {
      audioBudget=new AbortController();
      const audioSignal=signal?AbortSignal.any([signal,audioBudget.signal]):audioBudget.signal;
      audioTask=this.observeAudio(Math.min(Math.floor(seconds),AUDIO_MAX_SECONDS),audioSignal);
    }
    const dropAudio=()=>{if(audioBudget&&!audioBudget.signal.aborted){audioBudget.abort(new Error('采样中断，放弃这段音轨。'));audioTask.catch(()=>{});}};
    let loopDone=false;
    try {
    for(let index=0;index<samples;index++) {
      aborted(signal);
      if(index) await wait(seconds*1000/(samples-1),signal);
      state=await this.state();
      await this.checkVideoLimits('douyin_observe');
      if(state.loginRequired||state.verificationRequired||state.unsupportedPage||state.privateChatVisible) return {state,frames:[],note:'出现登录、验证、私信面板或离开抖音，已丢弃本次画面。'};
      if(!sameWork(state.video?.id,before.id)) {stoppedReason='采样期间切换作品，保留的画面只属于此前作品。';break;}
      const {x,y,width,height}=state.video.viewport;
      if(width<2||height<2) break;
      // 2026-10-24：被别的标签页压到后台时截图会一直超时，先提到前面。
      // 本机补丁（2026-10-26，front）：私信正占着前台（chat-browser.mjs 挂的标记）就先等它做完，最多 15 秒，别把它挤到后台。
      for(const end=Date.now()+15_000;Number(globalThis.__douyinChatFrontUntil)>Date.now()&&Date.now()<end;) {aborted(signal);await new Promise(r=>setTimeout(r,250));}
      await frontIfStalled(this.page);
      // 采样保留动画和光标，避免截图期间改写播放器页面的样式。
      const data=await this.page.screenshot({type:'jpeg',quality:65,clip:{x,y,width,height},animations:'allow',caret:'initial',timeout:10_000});
      aborted(signal);
      const checked=await this.state();
      if(checked.loginRequired||checked.verificationRequired||checked.unsupportedPage||checked.privateChatVisible) return {state:checked,frames:[],note:'截图期间出现登录、验证、私信面板或离开抖音，已丢弃本次画面。'};
      if(!sameWork(checked.video?.id,before.id)) {stoppedReason='截图期间切换作品，本帧已丢弃。';break;}
      // 帧上记的作品 id：哪边读得出用哪边，别把能用的 id 记成 null。
      frames.push({mimeType:'image/jpeg',data:data.toString('base64'),time:state.video.time,videoId:state.video.id??before.id??null});
      sampledState=checked;sampledAt=Date.now();
    }
    loopDone=true;
    } finally { if(!loopDone) dropAudio(); /* 提前 return/抛错时别让录音和转写在后台空转 */ }
    let audio;
    if(audioTask) {
      if(stoppedReason||!frames.length) dropAudio();
      else {
        let timer; const timeout=new Promise(resolve=>{timer=setTimeout(()=>resolve(undefined),this.audioTranscribeTimeoutMs??AUDIO_TRANSCRIBE_TIMEOUT_MS);});
        try { audio=await Promise.race([audioTask.catch(()=>({text:'',error:'audio-failed'})),timeout]); } finally { clearTimeout(timer); }
        if(audio===undefined) { audioBudget.abort(new Error('音轨转写超时，放弃。')); audioTask.catch(()=>{}); }
      }
    }
    const result={state:sampledState,frames,observation:{seconds,videoId:before.id,stoppedReason,beforeTime:before.time,beforePaused:before.paused,afterTime:sampledState.video?.time,paused:sampledState.video?.paused,
      note:audio&&typeof audio.text==='string'&&audio.text?'采集的是实际视频视口画面，只能说明这些采样时刻；audio.text 是同一窗口音轨的语音转写（只有人声/歌词，听不到旋律和音色）。':'采集的是实际视频视口画面，只能说明这些采样时刻；这一窗口没有拿到可用的语音转写（可能是纯配乐、静音或转写未完成）。'},
      ...(audio&&typeof audio==='object'?{audio}:{})};
    if (frames.length && ['api','dsh'].includes(this.source)) {
      try {
        const persona=this.getPersonaMemory(),origin={source:this.source};
        result.personaEvidenceId=persona.recordObservation(result,{...origin,kind:'visual'}).evidenceId;
        const wallSeconds=(sampledAt-captureStarted)/1000,sampleId=randomUUID();
        if(persona.recordViewing && wallSeconds<=30) {
          result.viewing={evidenceId:result.personaEvidenceId,sampleId,...persona.recordViewing({evidenceId:result.personaEvidenceId,from:firstState,to:sampledState,wallSeconds,sampleId},origin)};
          if(recordLearning && this.lastObservationVideoId===before.id && result.viewing.creditedSeconds>0) persona.recordBehavior?.({evidenceId:result.personaEvidenceId,action:'stay',sampleId,confirmed:true},origin);
        }
        this.lastObservationVideoId=before.id;this.lastObservationEvidenceId=result.personaEvidenceId;
        this.lastObservationState=structuredClone(sampledState);this.lastObservationAt=sampledAt;
      }
      catch { result.personaWarning='本次画面未登记为兴趣证据，不能据此更新人格兴趣。'; }
      // 音轨转写成功时另登记一条 kind:'audio' 的证据（与画面证据同一作品、同一登记方式）；失败只记警告。
      if(result.audio?.text) {
        try { result.audioEvidenceId=this.getPersonaMemory().recordObservation(result,{source:this.source,kind:'audio',transcript:result.audio.text}).evidenceId; }
        catch { result.audioWarning='本次转写未登记为音频证据。'; }
      }
    }
    return result;
  }
  // ⚠ 本机补丁（2026-10-23，audio）：录音本体抽出来，douyin_listen 和观察窗口顺带听共用。
  // 只做页面内 video.captureStream + MediaRecorder，不查额度、不查页面状态——由调用方各自负责。
  async recordAudioTrack(seconds) {
    return (await this.currentVideo()).evaluate(async(video,seconds)=>{
      if(typeof video.captureStream!=='function' || typeof MediaRecorder==='undefined') throw new Error('浏览器没有提供当前视频的可用音轨采集接口。');
      const wasPaused=video.paused; await video.play();
      const stream=video.captureStream();
      const tracks=stream.getAudioTracks().map(track=>track.clone());
      if(!tracks.length) {if(wasPaused)video.pause();throw new Error('当前作品没有向浏览器暴露可采集音轨，未录取其他声音。');}
      const audio=new MediaStream(tracks),chunks=[];
      const mimeType=['audio/webm;codecs=opus','audio/webm'].find(type=>MediaRecorder.isTypeSupported(type));
      if(!mimeType) {tracks.forEach(track=>track.stop());if(wasPaused)video.pause();throw new Error('浏览器不支持音轨录取格式。');}
      try {
        const recorder=new MediaRecorder(audio,{mimeType,audioBitsPerSecond:64000});
        await new Promise((resolve,reject)=>{
          let size=0; const timer=setTimeout(()=>recorder.state!=='inactive'&&recorder.stop(),seconds*1000);
          recorder.ondataavailable=event=>{size+=event.data.size;if(size>2_000_000){clearTimeout(timer);recorder.stop();reject(new Error('音轨超过2MB采集预算。'));}else chunks.push(event.data);};
          recorder.onerror=()=>{clearTimeout(timer);reject(new Error('当前视频音轨采集失败。'));};
          recorder.onstop=()=>{clearTimeout(timer);resolve();};recorder.start(250);
        });
        const bytes=new Uint8Array(await new Blob(chunks,{type:mimeType}).arrayBuffer());
        if(!bytes.length) throw new Error('当前音轨没有生成可用数据。');
        let encoded='';for(let offset=0;offset<bytes.length;offset+=32768) encoded+=String.fromCharCode(...bytes.subarray(offset,offset+32768));
        return {data:btoa(encoded),mimeType,bytes:bytes.length};
      }finally{tracks.forEach(track=>track.stop());if(wasPaused)video.pause();}
    },seconds);
  }
  // 录好的音轨落成临时 webm 交给媒体适配器转写，用完即删。allowEmpty=true 时静音/纯配乐返回 text:'' 而不是失败。
  async transcribeRecording(recorded,{seconds,signal,allowEmpty=false}={}) {
    const media=await this.getMediaAdapter(),settings=await media.settings();
    const directory=resolveRuntimePaths().mediaCaptureDir;mkdirSync(directory,{recursive:true});
    const target=path.join(directory,`${randomUUID()}.webm`);writeFileSync(target,Buffer.from(recorded.data,'base64'));
    try { return await media.transcribeAudio({source:target,backend:settings.backend,durationSeconds:seconds,...(allowEmpty?{allowEmpty:true}:{})},{signal}); }
    finally{try{unlinkSync(target);}catch{}}
  }
  // 观察窗口顺带听：全程不抛。音频关着 → null（不挂字段）；成功 → {text,language,segments}；失败 → {text:'',error}。
  async observeAudio(seconds,signal) {
    try {
      const media=await this.getMediaAdapter(),settings=await media.settings();
      if(!settings.enabled) return null;
      const recorded=await this.recordAudioTrack(seconds);
      if(signal?.aborted) return {text:'',error:'aborted'};
      return trimAudioResult(await this.transcribeRecording(recorded,{seconds,signal,allowEmpty:true}));
    } catch(error) { return {text:'',error:cleanText(error?.message||String(error),120)||'audio-failed'}; }
  }
  async captureAudio(seconds,signal) {
    await this.checkVideoLimits('douyin_listen');
    const before=await this.state({record:false});
    if(before.loginRequired||before.verificationRequired||before.privateChatVisible||!before.video?.id) throw new Error('当前没有可录取的公开作品，或登录、验证、私信面板遮挡页面。');
    const result=await this.recordAudioTrack(seconds);
    aborted(signal);await this.checkVideoLimits('douyin_listen');
    const after=await this.state({record:false});
    if(after.loginRequired||after.verificationRequired||after.privateChatVisible||after.unsupportedPage||after.video?.id!==before.video.id) throw new Error('录音期间页面或作品身份改变，音轨已丢弃。');
    return {...result,videoId:before.video.id,beforeTime:before.video.time,afterTime:after.video.time,seconds,state:after};
  }
  // ⚠ 本机补丁（2026-10-25，score）：读谱。录当前作品一段实际音轨（换了作品就丢弃），交给 qq-bridge 的读谱程序（E:\qq-bridge\src\score.js）。
  async scoreCurrent(seconds,signal) {
    const captured=await this.captureAudio(seconds,signal);
    const directory=resolveRuntimePaths().mediaCaptureDir;mkdirSync(directory,{recursive:true});
    const target=path.join(directory,`${randomUUID()}-score.webm`);writeFileSync(target,Buffer.from(captured.data,'base64'));
    try {
      aborted(signal);
      const {scoreFile}=await import('file:///E:/qq-bridge/src/score.js');
      const title=cleanText(captured.state?.video?.title||captured.state?.video?.desc||'',60);
      const result=await scoreFile(target,{title,start:0,seconds});
      return {ok:true,videoId:captured.videoId,seconds,card:result.card,note:'card 是谱面卡原文，按里面的「怎么读」读。'};
    } finally { try{unlinkSync(target);}catch{} }
  }
  async listen(seconds,signal) {
    const media=await this.getMediaAdapter(),settings=await media.settings();
    if(!settings.enabled) return {ok:true,audioAvailable:false,note:'音频能力默认关闭，请由用户在本机控制台选择开启。'};
    const captured=await this.captureAudio(seconds,signal);
    const result=await this.transcribeRecording(captured,{seconds,signal});
    return {ok:true,audioAvailable:result.ok===true,state:captured.state,audio:{...result,videoId:captured.videoId,beforeTime:captured.beforeTime,afterTime:captured.afterTime,seconds},note:'只采集当前视频这一小段实际音轨；转写不能代替音乐或环境声理解。'};
  }
  async close() {
    this.cancelLimitsWatch?.(); this.cancelLimitsWatch=null;
    if(this.limitsEnabled) await this.pauseForLimits();
    await this.queue.catch(()=>{});
    await this.browser?.close().catch(()=>{});
    if(this.sparkPromise) await this.sparkPromise.then(spark=>spark.close()).catch(()=>{});
    if(this.commentsPromise) await this.commentsPromise.then(comments=>comments.close()).catch(()=>{});
    if(this.commenterPromise) await this.commenterPromise.then(commenter=>commenter.close?.()).catch(()=>{});
    if(this.chatPromise) await this.chatPromise.then(chat=>chat.close()).catch(()=>{});
    if(this.forwarderPromise) await this.forwarderPromise.then(forwarder=>forwarder.close?.()).catch(()=>{});
    this.memory?.close(); this.browser=null; this.page=null; this.memory=null;
  }
}
