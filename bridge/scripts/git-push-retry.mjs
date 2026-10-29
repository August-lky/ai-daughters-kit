// 推送重试，按路轮换（2026-10-29 主人点头的 M13：备份推送间歇性失败）。
//
// 为什么：backup-her.mjs / publish-kit.mjs 原来直连 github，偶尔「Connection was reset」「Failed to connect to github.com:443 after 21048 ms」。
// 本机有代理（地址在 config.json / sister/config.json 的 proxy 字段，姐姐的 claude 也走它），直连失败的那几次走代理多半就通了；
// 但代理软件也会有没开的时候，所以不能只走代理：每次重试按「走代理 → 走代理 → 直连」轮换，日志写清用的哪条路和 git 的原话。
// git 调用（run）和等待（sleep）都能注入，测试不联网（scripts/test-git-push-retry.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const PROXY_ENV = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/** 日志里不留代理 / 远端网址里的账号密码。 */
export function hideCreds(text) {
  return String(text ?? '').replaceAll(/:\/\/[^@/\s]*@/g, '://***@');
}

function defaultGitProxy() {
  try { return execFileSync('git', ['config', '--global', '--get', 'http.proxy'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function readProxyField(file) {
  try { return String(JSON.parse(fs.readFileSync(file, 'utf8'))?.proxy || '').trim(); } catch { return ''; }
}

/**
 * 找本机代理：环境变量 → git 全局 http.proxy → qq-bridge/config.json 的 proxy → sister/config.json 的 proxy。都没有返回 ''（那就只能直连）。
 */
export function resolveProxy({ root, env = process.env, gitProxy = defaultGitProxy, readField = readProxyField } = {}) {
  for (const k of PROXY_ENV) if (String(env[k] || '').trim()) return String(env[k]).trim();

  const g = String(gitProxy() || '').trim();

  if (g) return g;
  if (root) {
    for (const f of [path.join(root, 'config.json'), path.join(root, 'sister', 'config.json')]) {
      const p = readField(f);

      if (p) return p;
    }
  }

  return '';
}

/** 第 attempt 次（从 1 起）走哪条路：有代理时 1、2 走代理，3 直连，4、5 又走代理……；没代理就一直直连。 */
export function routeFor(attempt, proxy) {
  if (!proxy) return 'direct';

  return (attempt - 1) % 3 === 2 ? 'direct' : 'proxy';
}

/** 这条路对应的 git 参数和环境：走代理用 -c http.proxy=<代理>；直连用 -c http.proxy= 并去掉环境里的代理变量，确保真的是直连。 */
export function gitInvocation(route, proxy, pushArgs, env = process.env) {
  const childEnv = { ...env, GIT_TERMINAL_PROMPT: '0' };

  if (route === 'proxy') return { args: ['-c', `http.proxy=${proxy}`, ...pushArgs], env: childEnv };

  for (const k of PROXY_ENV) delete childEnv[k];

  return { args: ['-c', 'http.proxy=', ...pushArgs], env: childEnv };
}

function defaultRun(args, { cwd, env, timeoutMs }) {
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, env });
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * 推送，失败隔一会儿再试，每次按 routeFor 换路。成功返回 { ok: true, attempt, route }；全失败抛错（日志里有每次的原因）。
 * run(args, { cwd, env, timeoutMs }) 失败要抛错（带 stderr），跟 execFileSync 一样。
 */
export async function pushWithRetry({
  cwd, proxy = '', attempts = 3, log = () => {}, pushArgs = ['push', '-q', '-u', 'origin', 'main'],
  run = defaultRun, sleep = defaultSleep, delayMs = (attempt) => attempt * 60e3, timeoutMs = 90e3, env = process.env
} = {}) {
  const label = (route) => (route === 'proxy' ? `走代理 ${hideCreds(proxy)}` : '直连');

  for (let attempt = 1; ; attempt++) {
    const route = routeFor(attempt, proxy);
    const inv = gitInvocation(route, proxy, pushArgs, env);

    try {
      run(inv.args, { cwd, env: inv.env, timeoutMs });
      log(`推送第 ${attempt} 次成功（${label(route)}）`);

      return { ok: true, attempt, route };
    } catch (error) {
      const why = hideCreds(String(error?.stderr || error?.message || error)).trim().split('\n').slice(-3).join(' | ');
      log(`推送第 ${attempt} 次没成（${label(route)}）：${why}`);

      if (attempt >= attempts) throw new Error(`推送连续 ${attempts} 次没成，见上面的原因`);

      await sleep(delayMs(attempt));
    }
  }
}
