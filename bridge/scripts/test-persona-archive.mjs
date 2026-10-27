// 抖音人格账本归档（2026-10-26）：旧的观看 / 互动挪走；兴趣和留下的记录引用的观察一条不少。
import assert from 'node:assert/strict';
import { splitPersona } from './douyin-persona-archive.mjs';

const day = 86400e3, now = 1_800_000_000_000, cutoff = now - 3 * day;
const obs = (id, at) => ({ id, videoId: id.slice(6), observedAt: at, sources: ['dsh'] });
const state = {
  version: 1, generation: 7,
  observations: [obs('video:old-interest', now - 9 * day), obs('video:old-view', now - 8 * day), obs('video:old-lonely', now - 7 * day), obs('video:new', now - day), obs('video:old-but-new-view', now - 6 * day)],
  interests: [{ topic: '鲸鱼', evidence: [{ evidenceId: 'video:old-interest', videoId: 'old-interest' }] }],
  userPreferences: [],
  behavior: { version: 1,
    viewings: [{ evidenceId: 'video:old-view', at: now - 8 * day }, { evidenceId: 'video:new', at: now - day }, { evidenceId: 'video:old-but-new-view', at: now - day }],
    actions: [{ evidenceId: 'video:old-view', at: now - 8 * day }] }
};
const { next, archived } = splitPersona(state, cutoff);

assert.equal(next.generation, 8, '版本号加一');
assert.deepEqual(next.observations.map((o) => o.id).sort(), ['video:new', 'video:old-but-new-view', 'video:old-interest'].sort(), '兴趣引用的、留下的观看引用的观察都留着');
assert.deepEqual(archived.observations.map((o) => o.id).sort(), ['video:old-lonely', 'video:old-view'].sort(), '没人引用的旧观察归档');
assert.equal(next.behavior.viewings.length, 2);
assert.equal(archived.viewings.length, 1);
assert.equal(next.behavior.actions.length, 0);
assert.equal(archived.actions.length, 1);
assert.equal(next.interests.length, 1, '兴趣不动');
const kept = new Set(next.observations.map((o) => o.id));
for (const ref of [...next.interests.flatMap((i) => i.evidence), ...next.behavior.viewings, ...next.behavior.actions]) assert.ok(kept.has(ref.evidenceId), `引用 ${ref.evidenceId} 还在`);
assert.equal(state.observations.length, 5, '原对象没被改');
console.log('✅ 旧的观看 / 互动和没人引用的旧观察归档，所有引用都还在；全部通过：1 组');
