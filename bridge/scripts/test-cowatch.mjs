// 姐姐陪看（sister/cowatch.mjs）：认视频页、对上妹妹的记录、读她在抖音上做的事。不连浏览器。
import assert from 'node:assert/strict';
import { videoIdOf, pickWatchPage, impressionOf, douyinActions, createCowatch } from '../sister/cowatch.mjs';

let passed = 0;
const ok = (name) => { passed += 1; console.log('✅', name); };

// ① 视频号、挑页面
{
  assert.equal(videoIdOf('https://www.douyin.com/jingxuan?modal_id=7698432064617549119'), '7698432064617549119');
  assert.equal(videoIdOf('https://www.douyin.com/video/7690542590109715758?x=1'), '7690542590109715758');
  assert.equal(videoIdOf('https://www.douyin.com/?recommend=1'), '');
  const t = [
    { type: 'page', url: 'https://www.douyin.com/?recommend=1', webSocketDebuggerUrl: 'ws://a' },
    { type: 'iframe', url: 'https://www.douyin.com/video/111111111', webSocketDebuggerUrl: 'ws://b' },
    { type: 'page', url: 'https://www.douyin.com/jingxuan?modal_id=222222222', webSocketDebuggerUrl: 'ws://c' }
  ];
  assert.equal(pickWatchPage(t).webSocketDebuggerUrl, 'ws://c', '只挑带视频号的页面，不挑 iframe');
  assert.equal(pickWatchPage([{ type: 'page', url: 'https://www.douyin.com/', webSocketDebuggerUrl: 'ws://x' }]), null);
  ok('认出妹妹正在看的视频页');
}

// ② 妹妹的记录、她做的事
{
  const rows = [{ videoId: 'v1', title: '旧' }, { videoId: 'v1', title: '新', reflection: '好看' }, { videoId: 'v2' }];
  assert.equal(impressionOf('v1', rows).reflection, '好看', '同一条取最后一次');
  assert.equal(impressionOf('v9', rows), null);
  const inbox = [
    { at: 50, direction: 'outgoing', name: '旧的', text: '早就发了' },
    { at: 200, direction: 'incoming', name: '朋友', text: '朋友说的不算' },
    { at: 300, direction: 'outgoing', name: '群友33', text: '这只猫被拉成蛇了' },
    { at: 400, direction: 'outgoing', name: '老大', text: '', media: { type: 'shared-work', author: '冬冰' } }
  ];
  const share = { operations: [{ status: 'confirmed', completedAt: new Date(500).toISOString(), recipientName: '群友33' }, { status: 'failed', completedAt: new Date(600).toISOString() }] };
  assert.deepEqual(douyinActions(100, { inbox, share }), ['私信给 群友33：「这只猫被拉成蛇了」', '私信给 老大：一条视频（@冬冰）', '把一条视频转给了群友33']);
  ok('她在抖音上做的事：只读她发出去的，别人发给她的不读');
}

// ③ 节奏：换了视频才截图；攒够、隔够才叫姐姐；叫成功才算看过
{
  let url = 'https://www.douyin.com/jingxuan?modal_id=111111111';
  const fakeFetch = async () => ({ json: async () => [{ type: 'page', url, webSocketDebuggerUrl: 'ws://127.0.0.1:1/' }] });
  const cw = createCowatch({ everyMin: 0, fetchImpl: fakeFetch });
  await cw.tick();
  await cw.tick();
  assert.equal(cw._seen.length, 1, '同一条不重复记');
  url = 'https://www.douyin.com/jingxuan?modal_id=222222222';
  await cw.tick();
  assert.equal(cw._seen.length, 2);
  assert.equal(cw.watching(), true);
  const d = cw.due();
  assert.ok(d && d.text.includes('1.') && d.text.includes('2.'));
  assert.equal(cw.due() !== null, true, '没 commit 之前还算没看过');
  d.commit();
  assert.equal(cw.due(), null, 'commit 之后不再给');
  ok('换视频才记、叫成功才算看过');
}

console.log(`全部通过：${passed} 组`);
