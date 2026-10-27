// 2026-10-25 她所有回合都报 DeepSeek 400、搬家后又「令牌全被拒」，两处修补：
//   ① 群友昵称里的 🦆 被引用预览按 UTF-16 码元截成半个（落单代理项），DeepSeek 拒收整个请求，而且留在会话历史里每轮都 400：
//      预览改用 truncateText；交给 DSH 的文字、回给她工具的字符串都 toWellFormed 兜底。
//   ② 她抄 48 位令牌时末尾多抄了一位：完整真令牌后面多出一两位也认（得先知道整串真令牌，安全不降级）。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { truncateText } from '../src/md-to-plain.js';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };
const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ① 截断不切半个 emoji；兜底把落单的换掉
{
  const nick = '有推荐的插件吗@某某某🐳🐠';
  assert.ok(lone.test(nick.slice(0, 12)), '原来的 slice(0, 12) 会切出半个 🦆');
  assert.ok(!lone.test(truncateText(nick, 12)), 'truncateText 不切');
  assert.ok(!/qBody\.slice\(0, 12\)/.test(src), '引用预览不再用 slice 截');
  const wf = new Function(`${src.match(/function wellFormedV2\(v\) \{[^\n]+\}/)[0]}\nreturn wellFormedV2;`)();
  assert.ok(!lone.test(wf('某某某\ud83d…')) && wf('🦆') === '🦆');
  assert.equal((src.match(/api\.sessions\.prompt\(\{[^)]*?wellFormedContentV2\(/gs) || []).length, 4, '四处交给 DSH 的地方都过了兜底');
  assert.match(src, /res\.end\(JSON\.stringify\(obj, \(k, v\) => wellFormedV2\(v\), 2\)\)/);
  ok('半个 emoji：截断不切开，交给 DSH / 回给工具前兜底换掉');
}

// ② 令牌末尾多一两位也认，少一位、改一位不认
{
  const body = src.match(/const tokenEq = \(a, b\) => \{[\s\S]*?\n {4}\};/)[0];
  const tokenEq = new Function('crypto', `${body}\nreturn tokenEq;`)(crypto);
  const real = crypto.randomBytes(24).toString('hex');
  assert.equal(tokenEq(real, real), true);
  assert.equal(tokenEq(`${real}6`, real), true, '多抄一位');
  assert.equal(tokenEq(`${real}66`, real), true, '多抄两位');
  assert.equal(tokenEq(`${real}666`, real), false, '多三位不认');
  assert.equal(tokenEq(real.slice(0, -1), real), false, '少一位不认');
  assert.equal(tokenEq(`${real.slice(0, -1)}x`, real), false, '改一位不认');
  assert.equal(tokenEq('abc6', 'abc'), false, '短令牌不放宽');
  ok('令牌：完整真令牌 + 一两位多余的也认，别的照样拒');
}
console.log(`全部通过：${passed} 组`);
