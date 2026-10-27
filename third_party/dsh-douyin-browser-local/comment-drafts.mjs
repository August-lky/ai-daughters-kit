// 本机补丁（2026-10-24，她的信 M1）：抖音评论草稿。
//
// 她刷视频时想在某条底下说一句 → 自己写好（watch 决策里的 commentText）→ 存成草稿，不发；
// 下次醒来看到草稿，用 douyin_comment_drafts 确认（可以改几个字）或者丢掉；
// 确认过的，等下一次刷视频时由观看循环打开那条视频、走原来的评论服务发出去（见 autonomous-watch.mjs）。
// 主人 2026-10-24：不设条数上限（只有评论服务里那道每日保险），她自己确认就发。
import fs from 'node:fs';
import path from 'node:path';
import { validateCommentText } from './autonomous-comments.mjs?v=10';

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP = 60;

export class CommentDrafts {
  constructor({ stateDir, now = () => Date.now() } = {}) {
    this.file = path.join(stateDir, 'comment-drafts.json');
    this.now = now;
  }

  read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && Array.isArray(data.drafts)) return { seq: Number(data.seq) || 0, drafts: data.drafts };
    } catch { /* 没有就是空的 */ }
    return { seq: 0, drafts: [] };
  }

  write(data) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    data.drafts = data.drafts.slice(-KEEP);
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 2));
    fs.renameSync(`${this.file}.tmp`, this.file);
  }

  /** 草稿 / 已确认但还没发的，放了一天就作废（看过的视频记录会滚掉，再发也核对不上）。 */
  expire(data) {
    for (const d of data.drafts) {
      if (['draft', 'confirmed'].includes(d.status) && this.now() - d.at > DAY_MS) Object.assign(d, { status: 'expired', updatedAt: this.now() });
    }
    return data;
  }

  /** 观看循环存草稿。同一条视频还有没发的草稿就改写那一条，不重复。 */
  add({ videoId, evidenceId, text, title = '', author = '' }) {
    const data = this.expire(this.read());
    const clean = validateCommentText(text);
    const open = data.drafts.find((d) => d.videoId === videoId && ['draft', 'confirmed'].includes(d.status));
    if (open) {
      Object.assign(open, { text: clean, evidenceId, status: 'draft', updatedAt: this.now() });
      this.write(data);
      return open;
    }
    data.seq += 1;
    const draft = { id: `c${data.seq}`, at: this.now(), videoId: String(videoId), evidenceId, text: clean, title: String(title || '').slice(0, 80), author: String(author || '').slice(0, 40), status: 'draft' };
    data.drafts.push(draft);
    this.write(data);
    return draft;
  }

  find(data, id) {
    const draft = data.drafts.find((d) => d.id === String(id || '').trim());
    if (!draft) throw new Error(`没有 ${id} 这条草稿`);
    return draft;
  }

  confirm(id, text) {
    const data = this.expire(this.read());
    const draft = this.find(data, id);
    if (!['draft', 'confirmed'].includes(draft.status)) throw new Error(`${draft.id} 已经是「${statusText(draft.status)}」了，不能再确认`);
    Object.assign(draft, { ...(text ? { text: validateCommentText(text) } : {}), status: 'confirmed', confirmedAt: this.now(), updatedAt: this.now() });
    this.write(data);
    return draft;
  }

  discard(id) {
    const data = this.expire(this.read());
    const draft = this.find(data, id);
    if (!['draft', 'confirmed'].includes(draft.status)) throw new Error(`${draft.id} 已经是「${statusText(draft.status)}」了`);
    Object.assign(draft, { status: 'discarded', updatedAt: this.now() });
    this.write(data);
    return draft;
  }

  /** 观看循环：下一条要发的（最早确认的那条）。 */
  nextConfirmed() {
    const data = this.expire(this.read());
    this.write(data);
    return data.drafts.filter((d) => d.status === 'confirmed').sort((a, b) => a.confirmedAt - b.confirmedAt)[0] || null;
  }

  mark(id, patch) {
    const data = this.read();
    const draft = data.drafts.find((d) => d.id === id);
    if (!draft) return null;
    Object.assign(draft, patch, { updatedAt: this.now() });
    this.write(data);
    return draft;
  }

  /** 给她看的：还没发的 + 一天内发了 / 没发成的。 */
  list() {
    const data = this.expire(this.read());
    return data.drafts
      .filter((d) => ['draft', 'confirmed'].includes(d.status) || this.now() - (d.updatedAt || d.at) < DAY_MS)
      .map((d) => ({ id: d.id, video: [d.title, d.author && `@${d.author}`].filter(Boolean).join(' ') || d.videoId, text: d.text, status: statusText(d.status), ...(d.reason ? { reason: d.reason } : {}) }));
  }

  /** douyin_comment_drafts 工具 */
  tool({ action = 'list', draftId, text } = {}) {
    if (action === 'confirm') {
      const d = this.confirm(draftId, text);
      return { ok: true, draft: { id: d.id, text: d.text }, note: '确认了。下次刷视频时会先打开那条视频把它发出去（正在刷的话一两分钟内）；发没发成，下次醒来会告诉你。公开的，发出去删不掉。' };
    }
    if (action === 'discard') { const d = this.discard(draftId); return { ok: true, draft: { id: d.id }, note: '丢掉了，不会发。' }; }
    return { ok: true, drafts: this.list() };
  }
}

export function statusText(status) {
  return { draft: '草稿，等你确认', confirmed: '已确认，等下次刷视频时发', posting: '正在发', posted: '发出去了', failed: '没发成', uncertain: '不确定发没发出去', discarded: '丢掉了', expired: '放了一天没确认，作废了' }[status] || status;
}
