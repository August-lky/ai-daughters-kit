// 这条鱼的「生物钟」—— 决定今天醒几次、什么时候醒、醒来看不看，到点**退出**来叫醒她。
//
// 为什么用"退出"叫醒：后台任务没法给 agent 注入一个回合 ✗，但它**结束**时系统会通知 agent ✓
// —— 跟直播间 `danmaku await` 是同一个套路（已在实战验证过）。
//
// 用法:
//   node whale-night.mjs plan      掷骰子，生成今天的计划（写 ~/.dsh/whale-night.json + 事件）
//   node whale-night.mjs clock     常驻：算计划 → 到点退出（WHALE_WAKE）/ 不看则睡到该窗口末退出（WHALE_SKIP）/ 次数用完（WHALE_DONE）
//   node whale-night.mjs mark      写"今晚醒过"的标记（给 Windows 计划任务兜底用：DSH 关着时也能留痕）
//   node whale-night.mjs status    看配置 / 今天的计划 / 醒了几次 / 兜底标记
//   node whale-night.mjs clock --test [秒]   自测：不走配置窗口，几秒后退出叫醒
//
// 配置（~/.dsh/whale-night.config.json，缺字段用默认值）：
//   {
//     "windows": [ {"start":"07:00","end":"09:00"}, {"start":"17:00","end":"18:00"} ],
//     "maxWakesPerDay": 2,
//     "skipChance": 0.3,
//     "maxVideos": 5, "maxMinutes": 20
//   }
//   兼容旧配置：没有 windows 时，用 windowStart/windowEnd 当成"一个窗口"。
//
// 设计原则（2026-10-14 起，2026-10-17 扩成多窗口）：
//   · **窗口固定，时刻随机** —— 机器才准点 ✗。每个窗口内随机挑一个时刻。
//   · **窗口 = 一次醒来的机会**，但**每天合计 ≤ maxWakesPerDay**（默认 = 窗口数，硬上限 3）——
//     窗口可以设四个，但不能醒四次（每次醒来都是一笔真开销）。
//   · **有权利不看** —— 每次醒来独立掷 skipChance（默认 30%），"今天不想看"也是活人 ✓
//   · **有上限** —— 条数 + 分钟数写死在配置里，防烧白饭。
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../lib/config.mjs'

const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const STATE = path.join(HOME, '.dsh', 'whale-night.json')
const MARK = path.join(HOME, '.dsh', 'whale-wake')
const CFG = path.join(HOME, '.dsh', 'whale-night.config.json')
// 作息默认值来自统一配置（lib/config.mjs）；本文件自己的 whale-night.config.json 仍可覆盖
const DEFAULTS = { ...config().night }

const argv = process.argv.slice(2)
const cmd = argv[0]
const TEST = argv.includes('--test')
const testSecs = TEST ? Number(argv[argv.indexOf('--test') + 1] ?? 5) : 0

const load = (f, dflt) => { try { return { ...dflt, ...JSON.parse(fs.readFileSync(f, 'utf8')) } } catch { return { ...dflt } } }
const save = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n') }
const today = () => new Date().toLocaleDateString('sv-SE')
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`
const parseHHMM = (s) => { const [h, m] = String(s).split(':').map(Number); return (h === 24 ? 1440 : h * 60) + (m || 0) }
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes() }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const cfg = load(CFG, DEFAULTS)

// 窗口：优先 windows[]；没有就退回 windowStart/windowEnd 一个窗口（兼容旧配置）
// 每个窗口自带 wakes（醒来几次，2026-10-18 主人定）；0 = 这个窗口不醒 ✓
function windowsOf(c) {
  const list = Array.isArray(c.windows) && c.windows.length
    ? c.windows
    : [{ start: c.windowStart ?? '20:00', end: c.windowEnd ?? '24:00', wakes: c.maxWakesPerDay ?? 1 }]
  return list
    .map((w) => ({
      start: parseHHMM(w.start),
      end: parseHHMM(w.end),
      label: `${w.start}–${w.end}`,
      wakes: Math.max(0, Number(w.wakes ?? 1) || 0),
    }))
    .filter((w) => w.end > w.start)
}
const WINDOWS = windowsOf(cfg)
// 总次数 = 各窗口之和；一个窗口都没配次数 → 退回 maxWakesPerDay（旧配置）→ 再退回窗口数
const MAX_WAKES = Math.min(
  12,
  Math.max(0, WINDOWS.reduce((s, w) => s + w.wakes, 0) || Number(cfg.maxWakesPerDay ?? WINDOWS.length) || WINDOWS.length),
)

const st = load(STATE, {})
const wakesToday = (s) => (s.date === today() ? Number(s.wakes ?? 0) : 0)

function makePlan() {
  const now = nowMin()
  const done = wakesToday(st)
  if (MAX_WAKES === 0) return { date: today(), action: 'done', wakes: done, reason: '所有窗口的"醒来次数"都是 0 → 今天不醒' }
  if (done >= MAX_WAKES) return { date: today(), action: 'done', wakes: done, reason: `今天已经醒了 ${done} 次（上限 ${MAX_WAKES}）` }
  // 还没结束的窗口
  const open = WINDOWS.filter((w) => w.end > now)
  if (!open.length) return { date: today(), action: 'done', wakes: done, reason: '今天的窗口都过完了' }
  // 每个窗口能醒 w.wakes 次；用 usedCount 记今天每个窗口已经用掉几次（2026-10-18 修：以前一个窗口只能用一次 ✗）
  const usedCount = st.date === today() && st.usedCount && typeof st.usedCount === 'object' ? { ...st.usedCount } : {}
  const byUsed = (list) => list.filter((w) => (usedCount[w.label] ?? 0) < w.wakes)
  let pool = byUsed(open)
  if (!pool.length) return { date: today(), action: 'done', wakes: done, reason: '所有窗口的醒来次数都用完了' }
  const w = pool[Math.floor(Math.random() * pool.length)]
  usedCount[w.label] = (usedCount[w.label] ?? 0) + 1
  const withinWindow = `${w.label} 第 ${usedCount[w.label]}/${w.wakes} 次`

  if (Math.random() < Number(cfg.skipChance ?? 0.3)) {
    return {
      date: today(), action: 'skip', wakes: done, usedCount, window: w.label, endAt: w.end, withinWindow,
      reason: `这次不想看（掷骰子掷到了「不看」那 ${Math.round((Number(cfg.skipChance ?? 0.3)) * 100)}%）`,
    }
  }
  let at = w.start + Math.floor(Math.random() * Math.max(1, w.end - w.start))
  if (at <= now) at = Math.min(w.end - 1, now + 1 + Math.floor(Math.random() * 10)) // 该窗口已开始 → 顺延一点点
  return {
    date: today(), action: 'wake', at, atText: hhmm(at), wakes: done, usedCount, window: w.label, withinWindow,
    roll: 'watch', maxVideos: cfg.maxVideos ?? 5, createdAt: new Date().toISOString(),
  }
}

function logEvent(kind, note) {
  try {
    fs.mkdirSync(path.join(HOME, '.dsh'), { recursive: true })
    fs.appendFileSync(path.join(HOME, '.dsh', 'whale-log.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), kind, target: null, note }) + '\n')
  } catch {}
}

const winText = () => WINDOWS.map((w) => w.label).join(' · ')

if (cmd === 'plan') {
  const p = makePlan()
  save(STATE, p)
  logEvent('night-plan', p.action === 'wake'
    ? `今天 ${p.atText}（窗口 ${p.window}）看视频`
    : `今天不看：${p.reason}`)
  console.log(JSON.stringify(p, null, 2))
  process.exit(0)
}

if (cmd === 'mark') {
  save(MARK, { date: today(), at: new Date().toISOString(), by: 'windows-task' })
  console.log(`已留标记：${MARK}（${today()}）`)
  process.exit(0)
}

if (cmd === 'status') {
  const p = load(STATE, {})
  const m = load(MARK, {})
  const done = wakesToday(p)
  console.log(`配置: 窗口 ${winText()} | 今天最多醒 ${MAX_WAKES} 次 | 不看概率 ${Math.round(Number(cfg.skipChance ?? 0.3) * 100)}% | 一次初筛 ${cfg.maxVideos ?? 5} 条`)
  const uc = p.date === today() && p.usedCount && typeof p.usedCount === 'object' ? p.usedCount : {}
  const wdesc = WINDOWS.map((w) => `${w.label}×${w.wakes}${uc[w.label] ? `（已用 ${uc[w.label]}）` : ''}`).join(' · ')
  console.log(`今天已醒: ${done}/${MAX_WAKES} · 各窗口: ${wdesc || '(无)'}`)
  console.log(`当前的计划: ${p.date ?? '(无)'} → ${p.action ?? '(未生成)'}${p.atText ? ' @ ' + p.atText : ''}${p.window ? '（窗口 ' + p.window + (p.withinWindow ? ' · ' + p.withinWindow : '') + '）' : ''}${p.reason ? '（' + p.reason + '）' : ''}`)
  console.log(`兜底标记: ${m.date ?? '(无)'}${m.date && m.date !== today() ? `  ← 有 ${m.date} 的标记（那晚 DSH 可能关着）` : ''}`)
  process.exit(0)
}

if (cmd === 'clock') {
  if (TEST) {
    console.log(`[test] 模拟生物钟：${testSecs} 秒后退出叫醒…`)
    await sleep(testSecs * 1000)
    save(STATE, { ...load(STATE, {}), date: today(), action: 'wake', at: nowMin(), atText: hhmm(nowMin()), woke: true, test: true })
    logEvent('night-wake', '[test] 生物钟自测')
    console.log('WHALE_WAKE at=' + hhmm(nowMin()) + ' (test)')
    process.exit(0)
  }
  // ⚠️ 重新算计划的三种情况（不修就会死循环 ✗）：
  //   ① 跨天了 / 没计划 ② 上一趟已经醒了（woke=true）→ 该排下一趟 ③ 上一趟是 skip 且已到窗口末（done=true）
  let p = load(STATE, {})
  const stale = p.date !== today() || !p.action || p.woke === true || p.done === true
  if (stale) {
    p = makePlan(); save(STATE, p)
    logEvent('night-plan', p.action === 'wake' ? `${p.atText} 看视频（窗口 ${p.window}${p.withinWindow ? ' · ' + p.withinWindow : ''}）` : `不醒：${p.reason}`)
  }
  console.log(`[生物钟] 这一趟：${p.action}${p.atText ? ' @ ' + p.atText : ''}${p.window ? '（窗口 ' + p.window + (p.withinWindow ? ' · ' + p.withinWindow : '') + '）' : ''}${p.reason ? '（' + p.reason + '）' : ''}`)

  // 次数用完 / 窗口都过了：立刻退出（不睡），让她知道"今天到此为止"
  if (p.action === 'done' || p.action === 'already') {
    console.log('WHALE_DONE ' + (p.reason ?? ''))
    process.exit(0)
  }

  if (p.action === 'skip') {
    // 不看：睡到**这个窗口的**末，再退出 —— 退出同样会叫醒她，但醒来只需看一眼"这次不看"
    const end = Number(p.endAt) || (WINDOWS[WINDOWS.length - 1]?.end ?? nowMin())
    const waitMin = Math.max(0, end - nowMin())
    console.log(`[生物钟] 这次不看，${waitMin} 分钟后（窗口 ${p.window ?? ''} 末）退出`)
    for (let i = 0; i < waitMin * 60; i += 60) await sleep(60_000)
    save(STATE, { ...p, done: true })
    console.log('WHALE_SKIP ' + (p.reason ?? ''))
    process.exit(0)
  }

  // 看：睡到随机点
  while (nowMin() < p.at) {
    const left = (p.at - nowMin()) * 60_000
    await sleep(Math.min(60_000, Math.max(5_000, left)))
  }
  const woke = { ...p, woke: true, wakes: wakesToday(p) + 1, wokeAt: new Date().toISOString() }
  save(STATE, woke)
  logEvent('night-wake', `生物钟叫醒（第 ${woke.wakes} 次 · 计划 ${p.atText}）`)
  console.log(`WHALE_WAKE at=${p.atText} wake=${woke.wakes}/${MAX_WAKES} maxVideos=${cfg.maxVideos ?? 5}${p.withinWindow ? ` slot=${p.withinWindow}` : ''}`)
  process.exit(0)
}

console.log('用法: node whale-night.mjs plan | clock [--test 5] | mark | status')
