// 语音服务按需启动（2026-10-25 主人：「语音服务应该只在她们要发语音的时候启用，不再使用就关闭」）。
// 服务（E:\voice-feiyu\feiyu_tts_server.py）空闲 5 分钟会自己整个退出，内存和显存全还回去；
// 要说话时这里发现它没开，就用隐藏启动器拉起来，等它能接话再说。妹妹（mcp-snowluma-safe）和姐姐（sister/qq-mcp）共用。
import { spawn } from 'node:child_process';

export const VOICE_URL = 'http://127.0.0.1:9881';
const LAUNCHER = 'E:\\qq-bridge\\start-voice-hidden.vbs';

async function healthy(url) {
  try { return (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

let starting = null;
/** 服务没开就拉起来，最多等 waitMs。返回是否可用。 */
export async function ensureVoiceService({ url = VOICE_URL, waitMs = 45000 } = {}) {
  if (await healthy(url)) return true;
  if (!starting) {
    starting = (async () => {
      try { spawn('wscript.exe', [LAUNCHER], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { return false; }
      const end = Date.now() + waitMs;
      while (Date.now() < end) {
        await new Promise((r) => setTimeout(r, 1000));
        if (await healthy(url)) return true;
      }
      return false;
    })().finally(() => { setTimeout(() => { starting = null; }, 0); });
  }
  return starting;
}

/** POST /speak；服务没开先拉起来。返回 wav 路径，失败抛错。 */
export async function speakVia({ text, voice, url = VOICE_URL, timeoutMs = 150000 }) {
  if (!await ensureVoiceService({ url })) throw new Error('语音服务没起来');
  const res = await fetch(`${url}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok || !data.path) throw new Error(data.error || `HTTP ${res.status}`);
  return data.path;
}
