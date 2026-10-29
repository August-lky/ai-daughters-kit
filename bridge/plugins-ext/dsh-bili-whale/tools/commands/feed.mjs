// 选题器：照"她自己的偏好"挑今天该看什么。**只读**，不产生任何对外动作。
//
// 用法: node feed.mjs [--n 6] [--per 2] [--pool 30]
// 数据来源：~/.dsh/whale-diary.md 的「爱看」一行（偏好关键词）+「看过的」表格（防重复）
//          + commented-videos.md（已评论过的视频也排除）
//
// 为什么这么做（2026-10-14 主人定的方向）：主人要的是"有日子的鱼"，
// 所以"看什么"不该由别人喂，而该由她自己的偏好决定 —— 偏好写在日记里，这个脚本只负责照它去捞。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)
const opt = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i]
}
const N = Number(opt.n ?? 6)
const PER = Number(opt.per ?? 2)
const POOL = Number(opt.pool ?? 30)

const HOME = (process.env.USERPROFILE || process.env.HOME || '/')
const diary = path.join(HOME, '.dsh', 'whale-diary.md')
// 2026-10-18：审计表挪到 `~/.bili-ai/` ✓（原来写死作者机器路径 ✗ 换机器就写不进去，静默失效 ✗）
const audit = path.join(HOME, '.bili-ai', 'commented-videos.md')

// ── 偏好与"看过"名单：都从日记里读 ──
let prefs = [...(config().preferences?.like ?? [])]   // 偏好来自统一配置（首选）
let dislike = [...(config().preferences?.dislike ?? [])]
let seen = new Set()
try {
  const text = fs.readFileSync(diary, 'utf8')
  const m = text.match(/^-\s*\*\*爱看\*\*：(.+)$/m)
  // 兼容旧写法：日记里若仍写着「爱看」，只在配置没给偏好时兜底（日记应回归纯叙事）
  if (m && !prefs.length) prefs = m[1].split(/[·、,，]/).map((s) => s.trim()).filter(Boolean)
  for (const bv of text.matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) seen.add(bv[0])
} catch { console.log('（读不到日记，用默认偏好）') }
try {
  for (const bv of fs.readFileSync(audit, 'utf8').matchAll(/\bBV[0-9A-Za-z]{10}\b/g)) seen.add(bv[0])
} catch { /* 没有审计表也无妨 */ }

const cred = JSON.parse(fs.readFileSync(path.join(HOME, '.bili-ai', 'credentials.json'), 'utf8'))
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const H = { 'user-agent': UA, referer: 'https://search.bilibili.com/', cookie: `SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}` }
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: H })).json()
const mixin = MIXIN_TAB.map((i) => (keyOf(nav.data?.wbi_img?.img_url ?? '') + keyOf(nav.data?.wbi_img?.sub_url ?? ''))[i]).join('').slice(0, 32)
const wbi = (p) => {
  const wts = Math.round(Date.now() / 1000)
  const q = Object.keys({ ...p, wts }).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(k === 'wts' ? wts : p[k]).replace(/[!'()*]/g, ''))}`).join('&')
  return `${q}&w_rid=${crypto.createHash('md5').update(q + mixin).digest('hex')}`
}
const secs = (s) => { const p = String(s).split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0] * 3600 + p[1] * 60 + p[2] }

const pool = []
for (const kw of prefs.slice(0, 6)) {
  for (const order of ['click', 'pubdate']) {
    try {
      const j = await (await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${wbi({ search_type: 'video', keyword: kw, order, page: 1 })}`, { headers: H })).json()
      for (const it of (j?.data?.result ?? []).slice(0, POOL / prefs.length + 4)) {
        pool.push({
          bv: it.bvid, t: String(it.title).replace(/<[^>]+>/g, ''), d: secs(it.duration),
          dm: Number(it.danmaku ?? 0), play: Number(it.play ?? 0), up: it.author, kw,
        })
      }
    } catch { /* 这个词没结果就跳过 */ }
    await new Promise((r) => setTimeout(r, 300))
  }
}

// ── #3 更多来源（2026-10-18 加，Kimi 评审指出：只搜关键词 = 只刷"搜索"，不是刷 B 站）
//   --source search（默认）| popular（热门）| rank（排行榜）| all（三个都要）
const SOURCE_HOT = String((process.argv.find((a) => a.startsWith('--source=')) ?? '').split('=')[1] ?? '')
  || (process.argv.includes('--source') ? String(process.argv[process.argv.indexOf('--source') + 1] ?? 'all') : 'search')
async function fetchPopular() {
  const j = await (await fetch('https://api.bilibili.com/x/web-interface/popular?pn=1&ps=20', { headers: H })).json()
  for (const it of (j?.data?.list ?? [])) {
    pool.push({ bv: it.bvid, t: String(it.title ?? '').replace(/<[^>]+>/g, ''), d: Number(it.duration ?? 0),
      dm: Number(it.stat?.danmaku ?? 0), play: Number(it.stat?.view ?? 0), up: it.owner?.name ?? '', kw: '热门' })
  }
}
async function fetchRank() {
  const j = await (await fetch('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', { headers: H })).json()
  for (const it of (j?.data?.list ?? []).slice(0, 20)) {
    pool.push({ bv: it.bvid, t: String(it.title ?? '').replace(/<[^>]+>/g, ''), d: Number(it.duration ?? 0),
      dm: Number(it.stat?.danmaku ?? 0), play: Number(it.stat?.view ?? 0), up: it.owner?.name ?? '', kw: '排行' })
  }
}
// 关注的人发了什么（2026-10-18 加）：真人才会"刷关注"——只搜关键词等于只刷"搜索"，不像人
async function fetchFollowing() {
  const j = await (await fetch('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?type=video&page=1', { headers: H })).json()
  if (j?.code !== 0) throw new Error(`code=${j?.code} ${j?.message ?? ''}`)
  for (const it of (j?.data?.items ?? [])) {
    const a = it?.modules?.module_author
    const ar = it?.modules?.module_dynamic?.major?.archive
    if (!ar?.bvid) continue
    const dt = String(ar.duration_text ?? '')          // 形如 "05:23"
    const p = dt.split(':').map(Number)
    const secs = p.length === 2 ? p[0] * 60 + p[1] : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : 0
    pool.push({ bv: ar.bvid, t: String(ar.title ?? '').replace(/<[^>]+>/g, ''), d: secs,
      dm: 0, play: Number(ar.stat?.play ?? 0), up: a?.name ?? '', kw: '关注' })
  }
}
try { if (SOURCE_HOT === 'popular' || SOURCE_HOT === 'all') await fetchPopular() } catch { console.error('（热门源取不到，跳过）') }
try { if (SOURCE_HOT === 'rank' || SOURCE_HOT === 'all') await fetchRank() } catch { console.error('（排行源取不到，跳过）') }
try { if (SOURCE_HOT === 'following' || SOURCE_HOT === 'all') await fetchFollowing() } catch (e) { console.error(`（关注源取不到，跳过：${String(e.message).slice(0, 60)}）`) }
console.error(`[来源] ${SOURCE_HOT === 'all' ? '搜索 + 热门 + 排行 + 关注' : SOURCE_HOT === 'popular' ? '热门' : SOURCE_HOT === 'rank' ? '排行' : SOURCE_HOT === 'following' ? '关注' : '搜索'}`)

const uniq = [...new Map(pool.map((x) => [x.bv, x])).values()].filter((x) => !seen.has(x.bv))
// 排序：偏好是"看得懂 + 有反应"，所以短视频 + 弹幕密度优先，兼顾播放量
uniq.sort((a, b) => (b.dm / Math.max(30, b.d)) * 1 + Math.log10(b.play + 1) * 3 - ((a.dm / Math.max(30, a.d)) + Math.log10(a.play + 1) * 3))

console.log(`偏好（来自日记）: ${prefs.join(' · ')}`)
console.log(`已看过/已评论过（已排除）: ${seen.size} 个 BV`)
console.log(`候选池: ${pool.length} 条 → 去重去已看后 ${uniq.length} 条\n`)
console.log(`今天可以看这几条（每词最多 ${PER} 条，共 ${N} 条）：`)
const perKw = {}
let shown = 0
for (const x of uniq) {
  if (shown >= N) break
  perKw[x.kw] = perKw[x.kw] ?? 0
  if (perKw[x.kw] >= PER) continue
  perKw[x.kw] += 1; shown += 1
  console.log(`  ${String(shown).padStart(2)}. ${x.bv}  ${String(x.d).padStart(4)}s  弹幕${String(x.dm).padStart(7)}  播放${String(x.play).padStart(9)}  ${x.t.slice(0, 40)}  @${x.up}`)
}
console.log('\n看完跑：node bili.mjs debrief <BV>   → 然后把"想法"写进日记的「想说」区（不发）')
