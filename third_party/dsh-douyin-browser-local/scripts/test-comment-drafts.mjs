// 抖音评论草稿（2026-10-24，她的信 M1）：她自己写 → 存草稿 → 她确认 → 观看循环打开那条视频发出去
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const { CommentDrafts, statusText } = await import(new URL('comment-drafts.mjs', root));
const { parseWatchDecision } = await import(new URL('api-agent.mjs', root));
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drafts-'));

test('存草稿 → 列出 → 确认（可改字）→ 下一条要发的就是它', () => {
  let now = 1_000_000;
  const d = new CommentDrafts({ stateDir: dir(), now: () => now });
  const a = d.add({ videoId: '123', evidenceId: 'obs-1', text: '这段红石太狠了', title: '红石音乐', author: '某up' });
  assert.equal(a.id, 'c1');
  assert.equal(d.list()[0].status, '草稿，等你确认');
  assert.equal(d.nextConfirmed(), null, '没确认的不发');
  now += 1000;
  d.confirm('c1', '这段红石是真的狠');
  const next = d.nextConfirmed();
  assert.equal(next.id, 'c1');
  assert.equal(next.text, '这段红石是真的狠');
});

test('同一条视频再写一次是改写原草稿，不重复', () => {
  const d = new CommentDrafts({ stateDir: dir() });
  d.add({ videoId: '9', evidenceId: 'o', text: '第一版' });
  d.add({ videoId: '9', evidenceId: 'o', text: '第二版' });
  assert.equal(d.list().length, 1);
  assert.equal(d.list()[0].text, '第二版');
});

test('丢掉的不发；发过的不能再确认', () => {
  const d = new CommentDrafts({ stateDir: dir() });
  d.add({ videoId: '1', evidenceId: 'o', text: '嗯' });
  d.discard('c1');
  assert.equal(d.nextConfirmed(), null);
  assert.throws(() => d.confirm('c1'), /丢掉了/);
  d.add({ videoId: '2', evidenceId: 'o', text: '好看' });
  d.confirm('c2');
  d.mark('c2', { status: 'posted' });
  assert.throws(() => d.confirm('c2'), /发出去了/);
});

test('放了一天没确认的作废', () => {
  let now = 0;
  const d = new CommentDrafts({ stateDir: dir(), now: () => now });
  d.add({ videoId: '1', evidenceId: 'o', text: '嗯嗯' });
  now = 25 * 3600 * 1000;
  assert.equal(d.nextConfirmed(), null);
  assert.equal(d.list()[0].status, '放了一天没确认，作废了', '作废的再列一天，让她知道没发');
});

test('评论原话也要过原来的检查：不带链接、@', () => {
  const d = new CommentDrafts({ stateDir: dir() });
  assert.throws(() => d.add({ videoId: '1', evidenceId: 'o', text: '去 www.example.com 看' }));
  assert.throws(() => d.add({ videoId: '1', evidenceId: 'o', text: '@某人 快来' }));
});

test('工具：list / confirm / discard', () => {
  const d = new CommentDrafts({ stateDir: dir() });
  d.add({ videoId: '1', evidenceId: 'o', text: '好听' });
  assert.equal(d.tool({ action: 'list' }).drafts.length, 1);
  assert.match(d.tool({ action: 'confirm', draftId: 'c1' }).note, /下次刷视频时/);
  assert.equal(statusText('confirmed'), '已确认，等下次刷视频时发');
});

test('刷视频决策：comment 必须带她自己写的 commentText；别的动作不带', () => {
  const base = { reason: '想说', topics: [{ topic: 'x', signal: 'like' }], reflection: '好看' };
  const ctx = { commentContext: { enabled: true, paused: false, remainingDaily: 5, remainingSession: 3 } };
  const ok = parseWatchDecision(JSON.stringify({ ...base, action: 'comment', commentText: '太好听了' }), ctx);
  assert.equal(ok.commentText, '太好听了');
  assert.throws(() => parseWatchDecision(JSON.stringify({ ...base, action: 'comment' }), ctx), /commentText/);
  const skip = parseWatchDecision(JSON.stringify({ ...base, action: 'skip', commentText: '多余' }), ctx);
  assert.equal(skip.commentText, undefined);
});

test('接线：观看循环存草稿、每拍先发确认过的；工具登记和分派；发布键找法', () => {
  const read = (f) => fs.readFileSync(new URL(f, root), 'utf8');
  const watch = read('autonomous-watch.mjs');
  assert.match(watch, /this\.getCommentDrafts\(\)\.add\(\{ videoId: observedState\.video\.id, evidenceId, text: decision\.commentText/);
  assert.match(watch, /const confirmedComment = this\.getCommentDrafts\(\)\.nextConfirmed\(\);/);
  assert.match(watch, /douyin_open_video', \{ url: `https:\/\/www\.douyin\.com\/video\/\$\{draft\.videoId\}` \}/);
  assert.match(read('tool-definitions.mjs'), /name: 'douyin_comment_drafts'/);
  assert.match(read('core.mjs'), /if\(name==='douyin_comment_drafts'\)/);
  const browser = read('comment-browser.mjs');
  assert.match(browser, /function findSendIcon\(root\)/);
  assert.match(browser, /\.comment-input-inner-container \[contenteditable="true"\]/);
  assert.match(read('autonomous-comments.mjs'), /perSessionLimit > 20/);
});
