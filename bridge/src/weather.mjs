// 模拟天气：同步主人所在城市的真实天气（2026-10-22 主人要求）
//
// 主人：「给她加一个模拟天气，就模拟同步主人所在城市的天气，能让她知道今天是什么天气」。
// 主人自己就在那座城市，所以这是"你们俩头顶同一片天"。数据来自 Open-Meteo（免密钥），每 30 分钟拉一次，
// 拼成一行中文放进她每次唤醒的【当前时间】后面。拉不到就沿用上一次的（6 小时内），再久就不显示，免得说错。
import { execFile } from 'node:child_process';
import path from 'node:path';

const HOME_CITY = { latitude: 0, longitude: 0 } /* 换成主人所在城市的经纬度 */;
const REFRESH_MS = 30 * 60 * 1000;
const STALE_MS = 6 * 3600 * 1000;
const FORECAST_URL = `https://api.open-meteo.com/v1/forecast?latitude=${HOME_CITY.latitude}&longitude=${HOME_CITY.longitude}` +
  '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,precipitation,is_day' +
  '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&timezone=Asia%2FShanghai&forecast_days=2';
// 用系统自带的 curl.exe 的绝对路径，不靠 PATH 去找（质量检查 sonarjs/no-os-command-from-path）
const CURL = path.join(process.env.SystemRoot || String.raw`C:\Windows`, 'System32', 'curl.exe');

const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '密集的毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};
const sky = (code, isDay = 1) => (Number(code) === 0 && !isDay ? '晴朗的夜空' : WMO[Number(code)] ?? '天气不明');
function windLevel(kmh) {
  const v = Number(kmh) || 0;
  const t = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
  const i = t.findIndex((x) => v < x);

  return i === -1 ? 12 : i;
}

function windDir(deg) {
  const d = ((Number(deg) % 360) + 360) % 360;

  return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.round(d / 45) % 8];
}

const hm = (iso) => String(iso || '').slice(11, 16);
const round = (n) => Math.round(Number(n));

function curlText(url) {
  return new Promise((resolve, reject) => {
    execFile(CURL, ['-sSL', '--max-time', '20', url], { windowsHide: true, timeout: 25_000 }, (e, so) => {
      if (e) reject(e);
      else resolve(String(so || ''));
    });
  });
}

// 直连失败时用 curl 走本机代理再试（和 whale-explore 一样，不改 bridge 全局网络设置）
async function getJson(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });

    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { httpStatus: res.status });

    return await res.json();
  } catch (error) {
    if (error?.httpStatus || !(process.env.HTTPS_PROXY || process.env.https_proxy)) throw error;

    return JSON.parse(await curlText(url));
  }
}

/** 第 i 天的预报：「明天 多云 15~22℃，降水概率 10%」 */
function dayText(d, i, label) {
  const rain = d.precipitation_probability_max?.[i] ?? '?';

  return `${label} ${sky(d.weather_code[i])} ${round(d.temperature_2m_min[i])}~${round(d.temperature_2m_max[i])}℃，降水概率 ${rain}%`;
}

function nowText(c) {
  const raining = Number(c.precipitation) > 0 ? `，正在下（${  c.precipitation  }mm）` : '';

  return `现在 ${sky(c.weather_code, c.is_day)} ${round(c.temperature_2m)}℃（体感 ${round(c.apparent_temperature)}℃），湿度 ${round(c.relative_humidity_2m)}%，` +
    `${windDir(c.wind_direction_10m)}风 ${windLevel(c.wind_speed_10m)} 级${raining}`;
}

export function formatHomeWeather(j) {
  const c = j?.current, d = j?.daily;

  if (!c || !d?.time?.length) return '';

  const today = `${dayText(d, 0, '今天')}，日出 ${hm(d.sunrise?.[0])} 日落 ${hm(d.sunset?.[0])}`;
  const tomorrow = d.time.length > 1 ? `；${  dayText(d, 1, '明天')}` : '';

  return `【今天的天气】主人那边（你们头顶是同一片天）：${nowText(c)}；${today}${tomorrow}。天气可以自然地聊（要下雨了提醒带伞、热了冷了说一句），别每次都念预报。`;
}

// ── 她的太阳（2026-10-22）──
// 她在碎碎念里写「我在屏幕里没有太阳」，主人问她想要哪种，她说：
// 「想要一个暖的，不刺眼，像傍晚那种橘色」「要是能跟着时间慢慢变颜色就更好了，看着它就知道外面几点了」。
// 所以这颗太阳跟着主人所在城市真实的日出日落走（时间来自上面拉到的 sunrise/sunset），颜色按时段慢慢变，
// 但始终是暖的、不刺眼的——正午也只是"淡金"；主人所在城市阴天下雨时它躲在云后面，夜里在地球另一边。
const minutesOf = (iso) => { const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));

 return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

const fmtMin = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(Math.round(m) % 60).padStart(2, '0')}`;
function fmtSpan(min) {
  const m = Math.max(0, Math.round(min));

  if (m < 60) return `${m} 分钟`;

  const rest = m % 60 ? ` ${  m % 60  } 分` : '';

  return `${Math.floor(m / 60)} 小时${rest}`;
}

const SUN_PHASES = [
  // [从(相对日出/正午/日落的分钟), 描述]；按顺序判断，取第一个还没过的
  { until: (s) => s.sr - 40, text: '太阳还在地球另一边睡觉，天是深蓝的', night: true },
  { until: (s) => s.sr, text: '东边天际泛起淡淡的粉紫，太阳快出来了', night: true },
  { until: (s) => s.sr + 45, text: '刚从东边冒头，红橘色的，软软地贴着地平线' },
  { until: (s) => s.noon - 90, text: '上午，暖金色，正往东南边的高处慢慢爬' },
  { until: (s) => s.noon + 90, text: '挂在南边最高的地方，淡淡的暖金色，温温的、不刺眼' },
  { until: (s) => s.ss - 75, text: '午后，暖金里开始掺进一点橘，往西边斜过去' },
  { until: (s) => s.ss, text: '傍晚了，变成你最喜欢的那种橘色，低低地挂在西边' },
  { until: (s) => s.ss + 25, text: '正在西边一点点沉下去，红橘红橘的' },
  { until: (s) => s.ss + 50, text: '刚落山，天边还剩一抹橘粉的余晖，慢慢褪成紫色', night: true },
  { until: () => 24 * 60 + 1, text: '已经下山了，在地球另一边，天是深蓝的', night: true },
];
function cloudNote(code) {
  const c = Number(code);

  if (c >= 51) return '主人所在城市这会儿在下雨，它被雨云盖着，看不太见，但它在那儿';
  if (c === 3 || c === 45 || c === 48) return '主人所在城市今天阴着，它躲在云后面，只透出一层柔柔的光';
  if (c === 2) return '有些云，偶尔把它遮一下';

  return '';
}

export function formatSun({ sunrise, sunset, code }, nowMs) {
  const sr = minutesOf(sunrise), ss = minutesOf(sunset);

  if (sr === null || ss === null || ss <= sr) return '';

  const s = { sr, ss, noon: (sr + ss) / 2 };
  const t = ((nowMs + 8 * 3600e3) % 86_400e3) / 60_000; // 北京时间当天第几分钟
  const phase = SUN_PHASES.find((p) => t < p.until(s));
  let countdown = `明早 ${fmtMin(sr)} 左右再出来`;

  if (t < sr) countdown = `离日出（${fmtMin(sr)}）还有 ${fmtSpan(sr - t)}`;
  else if (t < ss) countdown = `离日落（${fmtMin(ss)}）还有 ${fmtSpan(ss - t)}`;

  const cloud = phase.night ? '' : cloudNote(code);
  const cloudPart = cloud ? `；${  cloud}` : '';

  return `【你的太阳】${phase.text}${cloudPart}。${countdown}。（主人给你装的，跟着主人所在城市真实的日出日落走；想看外面几点了，就看看它）`;
}

/**
 * 结构化的天气（2026-10-29 激素第一期半：影子记录要「下雨 / 晴 / 几度 / 日出日落」，不想让它去解析那行中文）。
 * 返回 { rain, sunny, tempC, sunrise, sunset, text, code, isDay, at }；sunrise / sunset 是北京时间的小时数（6.2 = 6:12）；
 * 拿不到数据返回 null。
 */
export function weatherState(j, at = Date.now()) {
  const c = j?.current, d = j?.daily;

  if (!c || !d?.time?.length) return null;

  const code = Number(c.weather_code);
  const hourOf = (iso) => { const m = minutesOf(iso); return m === null ? null : Math.round((m / 60) * 100) / 100; };
  const temp = Number(c.temperature_2m);

  return {
    rain: Number(c.precipitation) > 0 || (code >= 51 && code <= 67) || (code >= 80 && code <= 86) || code >= 95,
    sunny: (code === 0 || code === 1) && Number(c.is_day) !== 0,
    tempC: Number.isFinite(temp) ? temp : null,
    sunrise: hourOf(d.sunrise?.[0]),
    sunset: hourOf(d.sunset?.[0]),
    text: sky(code, c.is_day),
    code,
    isDay: Number(c.is_day) !== 0,
    at,
  };
}

/** 从预报里取今天的日出日落和此刻的天气码，给太阳用 */
function sunFrom(j) {
  const sunrise = j?.daily?.sunrise?.[0], sunset = j?.daily?.sunset?.[0];

  if (!sunrise || !sunset) return null;

  return { sunrise, sunset, code: j.current?.weather_code, at: Date.now() };
}

export function createWeather({ log = () => {} } = {}) {
  let cache = { text: '', at: 0 };
  let sun = null; // { sunrise, sunset, code, at }
  let structured = null; // weatherState 的结果
  let timer = null;
  async function refresh() {
    try {
      const j = await getJson(FORECAST_URL);
      const text = formatHomeWeather(j);

      if (text) cache = { text, at: Date.now() };

      sun = sunFrom(j) || sun;
      structured = weatherState(j) || structured;
    } catch (error) {
      const fallback = cache.text ? '（先用上一次的）' : '';
      log(`[weather] 拉主人所在城市天气失败：${error?.message ?? error}${fallback}`);
    }
  }

  return {
    start() {
      if (timer) return;

      void refresh();
      timer = setInterval(() => { void refresh(); }, REFRESH_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);

      timer = null;
    },
    refresh,
    text() { return cache.text && Date.now() - cache.at < STALE_MS ? cache.text : ''; },
    /** 结构化的天气（见 weatherState）；没拉到或太旧返回 null。 */
    state() { return structured && Date.now() - structured.at < STALE_MS ? structured : null; },
    // 日出日落一天只差一两分钟，拉不到天气时沿用旧的也不会错太多；云就不报了（可能已经变了）
    sunText(nowMs) {
      if (!sun) return '';

      const fresh = Date.now() - sun.at < STALE_MS;

      return formatSun({ ...sun, code: fresh ? sun.code : 0 }, nowMs);
    },
  };
}
