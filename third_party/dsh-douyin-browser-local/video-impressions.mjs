// ⚠ 本机补丁（2026-10-22，主人要求）：她刷过、分享过的视频，过后要还记得「看了什么、当时怎么想的」。
//
// 以前每次决策（stay/skip/share…）的 reason、reflection 只写进 watch-events.jsonl，
// 那份是按轮次的流水、不带作品 id，过后谁也查不到"那条视频她当时觉得怎样"。
// 主人在抖音私信里回她分享的卡片（"这个视频里面说你擅长什么？"），她只能看见卡片标题和封面，答不上来。
//
// 这里按作品记一份「观看印象」：state/video-impressions.jsonl，一次决策一行。
// douyin_video_recall 按作品 id / 关键词 / 最近分享 把同一条作品的印象拼起来给她；
// bridge 在主人发来抖音私信时，也读这份文件把她最近分享那几条的印象递给她。
import fs from 'node:fs';
import path from 'node:path';

export const IMPRESSIONS_FILE = 'video-impressions.jsonl';
const MAX_BYTES = 8 * 1024 * 1024; // 超过就只留后一半，防止无限长

const clip = (value, n) => { const s = String(value ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };

export function appendImpression(stateDir, record) {
  if (!record?.videoId) return;
  const file = path.join(stateDir, IMPRESSIONS_FILE);
  const row = {
    at: record.at ?? Date.now(), runId: record.runId ?? null, videoId: String(record.videoId),
    title: record.title ? clip(record.title, 200) : null, author: record.author ? clip(record.author, 60) : null,
    time: Number.isFinite(record.time) ? Math.round(record.time) : null, duration: Number.isFinite(record.duration) ? Math.round(record.duration) : null,
    action: record.action ?? null, reason: record.reason ? clip(record.reason, 300) : null, reflection: record.reflection ? clip(record.reflection, 500) : null,
    topics: Array.isArray(record.topics) ? record.topics.slice(0, 5).map((t) => t?.topic).filter(Boolean) : [],
  };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');
  try {
    if (fs.statSync(file).size > MAX_BYTES) {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch { /* 裁不动下次再裁 */ }
}

function readJsonl(file) {
  try { return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// 本机时钟比真实时间快（见 E:\qq-bridge\state\clock-skew.json），显示给她的时间要换回北京时间。
function skewMs() { return Number(readJson('E:\\qq-bridge\\state\\clock-skew.json')?.skewMs) || 0; }
function bj(ms, skew) {
  return new Date(ms - skew).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** 把同一条作品的所有印象拼成一份。 */
function summarize(videoId, rows, shares, tells, skew) {
  const mine = rows.filter((r) => r.videoId === videoId).sort((a, b) => a.at - b.at);
  const last = mine[mine.length - 1] || {};
  const title = [...mine].reverse().find((r) => r.title)?.title ?? null;
  const author = [...mine].reverse().find((r) => r.author)?.author ?? null;
  const duration = Math.max(0, ...mine.map((r) => r.duration || 0)) || null;
  const furthest = Math.max(0, ...mine.map((r) => r.time || 0)) || null;
  const seen = new Set(), thoughts = [];
  for (const r of mine) {
    for (const t of [r.reason, r.reflection]) {
      if (!t) continue;
      const key = t.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key); thoughts.push(`[${bj(r.at, skew)} ${r.action ?? ''}] ${t}`);
    }
  }
  const topics = [...new Set(mine.flatMap((r) => r.topics || []))].slice(0, 8);
  const shared = shares.filter((o) => o.videoId === videoId && o.status === 'confirmed').map((o) => ({ at: bj(Date.parse(o.startedAt), skew), reason: clip(o.reason, 200) }));
  const told = tells.filter((t) => t.videoId === videoId).map((t) => clip(t.tell, 200));
  return {
    videoId, url: `https://www.douyin.com/video/${videoId}`, title, author,
    firstSeen: mine.length ? bj(mine[0].at, skew) : null, lastSeen: mine.length ? bj(last.at, skew) : null,
    // 只有实时记下的进度才可信（10-22 之前补的历史没有逐次进度，看 thoughts 里自己写的"看到多少"）
    watched: duration && furthest ? `最远看到第 ${furthest} 秒 / 共 ${duration} 秒（约 ${Math.min(100, Math.round((furthest / duration) * 100))}%）` : null,
    decisions: mine.length, topics,
    // 最多 8 条，留头尾：开头是第一印象，结尾是看完的想法
    thoughts: thoughts.length > 8 ? [...thoughts.slice(0, 3), '……', ...thoughts.slice(-5)] : thoughts,
    shared, told,
  };
}

/**
 * 找她对作品的印象。
 *   videoId：精确找一条
 *   query：在标题、作者、她的想法里找关键词
 *   recentShared：最近分享出去的几条（主人说"这个"多半指它们）
 */
export function recallVideos(stateDir, { videoId, query, recentShared, limit = 3 } = {}) {
  const rows = readJsonl(path.join(stateDir, IMPRESSIONS_FILE));
  const shares = readJson(path.join(stateDir, 'share-ledger.json'))?.operations || [];
  const tells = readJsonl(path.join(stateDir, 'watch-tell.jsonl'));
  const skew = skewMs();
  const n = Math.max(1, Math.min(10, Number(limit) || 3));
  let ids = [];
  if (videoId) ids = [String(videoId)];
  else if (recentShared) ids = [...new Set(shares.filter((o) => o.status === 'confirmed').sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).map((o) => o.videoId))].slice(0, n);
  else if (query && String(query).trim()) {
    const words = String(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
    const score = new Map();
    for (const r of rows) {
      const hay = `${r.title ?? ''} ${r.author ?? ''} ${r.reason ?? ''} ${r.reflection ?? ''} ${(r.topics || []).join(' ')}`.toLowerCase();
      const hit = words.filter((w) => hay.includes(w)).length;
      if (hit) score.set(r.videoId, Math.max(score.get(r.videoId) || 0, hit * 1e13 + r.at));
    }
    ids = [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, n);
  } else {
    throw new TypeError('给一个 videoId、query 关键词，或者 recentShared=true。');
  }
  const videos = ids.map((id) => summarize(id, rows, shares, tells, skew)).filter((v) => v.decisions || v.shared.length);
  return {
    found: videos.length,
    videos,
    note: videos.length
      ? '这是你当时刷到它时的真实记录（看的是抽帧画面，没有声音）。thoughts 是你当时一路的想法。这里没有的细节就照实说记不太清，别编。'
      : '没找到你看过这条的记录（可能很早之前看的，或者是别人分享来的、你没刷到过）。照实说没看过就好；想看可以让他发链接，或者等自主观看停下来用 douyin_open_video 打开。',
  };
}
