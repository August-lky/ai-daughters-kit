// 反射层实测（browser/whale-reflex.js）：独立临时 Edge 窗口，像 --init-script 那样预装脚本，打一首歌看游戏自己的判定。
// 用法：node scripts/test-whale-reflex.cjs <song> [optsJSON]；环境变量 VW/VH 窗口大小、JANK=毫秒 模拟卡顿、SCRIPT=换脚本路径
// 2026-10-24：照她现在的路走——从 game.html?song= 进，游戏框架自己跳到 experiments/falling-mode/…?modePicker=1，
// 默认选中的是「演出模式」tab（那里的「开始演奏」会去 performance-xxx 页，不是下落模式），所以要先点「下落模式」tab。
// 新建的临时浏览器第一次开局会弹「游玩 Tip」「新功能」引导，一路点掉。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('C:/Users/admin/.dsh/profiles/tauri/node_modules/playwright');

const SONG = process.argv[2] || 'qiuyuying';
const OPTS = JSON.parse(process.argv[3] || '{}');
const URL = `https://www.bilibili.com/toy/rhythm-vocaloid/18842483023872-v30005/game.html?song=${SONG}`;

(async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflex-edge-'));
  const ctx = await chromium.launchPersistentContext(userDir, { channel: 'msedge', headless: false, viewport: { width: Number(process.env.VW || 1280), height: Number(process.env.VH || 760) }, args: ['--autoplay-policy=no-user-gesture-required'] });
  await ctx.addInitScript({ path: process.env.SCRIPT || 'E:/qq-bridge/browser/whale-reflex.js' });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等游戏那一层出来
  let game = null;
  for (let i = 0; i < 60 && !game; i += 1) { game = page.frames().find((f) => /bilibilitoy\.com.*falling-mode/.test(f.url())); if (!game) await page.waitForTimeout(500); }
  if (!game) throw new Error('没找到游戏 iframe');
  console.log('框架：', page.frames().map((f) => f.url()).filter((u) => !/hdslb/.test(u)));
  const dismiss = async () => {
    for (let i = 0; i < 8; i += 1) {
      const b = game.locator('[role=dialog]:visible button:visible, .rv-play-tips button:visible').filter({ hasText: /下一步|确定|知道了|开始|完成/ }).last();
      if (!(await b.count())) return;
      console.log('关掉引导：', (await b.innerText()).trim());
      await b.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(800);
    }
  };
  const fallingTab = game.locator('.journal-mode-tab', { hasText: '下落模式' }).first();
  await fallingTab.waitFor({ timeout: 60000 }).catch(() => {});
  if (await fallingTab.count() && !/selected/.test(await fallingTab.getAttribute('class'))) { await fallingTab.click(); await page.waitForTimeout(3000); }
  await game.waitForSelector('#startBtn', { state: 'visible', timeout: 60000 });
  await game.waitForFunction(() => !document.getElementById('startBtn').disabled, null, { timeout: 60000 }).catch(() => {});
  console.log('外层开关在吗：', await page.evaluate(() => typeof window.__whaleReflex));
  console.log('启动：', JSON.stringify(await page.evaluate((o) => window.__whaleReflex.start(o), OPTS)));
  await game.click('#startBtn', { timeout: 5000 }).catch(() => {}); // 第一次会被「游玩 Tip」挡住，点掉它就开局
  await page.waitForTimeout(1500);
  await dismiss();
  if (process.env.JANK) {
    // 模拟她边玩边截图/抓快照时的卡顿：游戏那一层每 250ms 卡死 JANK 毫秒
    await page.waitForTimeout(2500);
    const g = page.frames().find((f) => /bilibilitoy.com.*falling-mode/.test(f.url()));
    await g.evaluate((ms) => { setInterval(() => { const t = performance.now(); while (performance.now() - t < ms) { /* busy */ } }, 250); }, Number(process.env.JANK));
    console.log('卡顿模拟已开：', process.env.JANK, 'ms / 250ms');
  }
  const t0 = Date.now();
  let st = null;
  while (Date.now() - t0 < 6 * 60 * 1000) {
    await page.waitForTimeout(5000);
    st = await page.evaluate(() => window.__whaleReflex.status());
    process.stdout.write(`\r${Math.round((Date.now() - t0) / 1000)}s 按键 ${st.stats?.presses} 长条 ${st.stats?.holds} 连打 ${st.stats?.rollHits} 故意漏 ${st.stats?.skipped} 没按就miss ${st.stats?.missUnpressed} 按了仍miss ${st.stats?.missPressed} 长条断 ${st.stats?.holdBroken} 最大帧隔 ${st.stats?.maxFrameGapMs}ms   `);
    if (st.result) break;
  }
  console.log('\n结果：', JSON.stringify(st));
  // 成绩有没有被交：看游戏的预览标记
  console.log('预览标记（不交成绩）：', await game.evaluate(() => window.__RV_PREVIEW_BUILD__));
  await page.evaluate(() => window.__whaleReflex.stop());
  await ctx.close();
  fs.rmSync(userDir, { recursive: true, force: true });
})().catch((e) => { console.error('测试失败：', e.message); process.exit(1); });
