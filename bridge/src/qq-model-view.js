// Only the model-facing view is compacted. Stored messages and console/API data
// retain the original fields for display, media retrieval and troubleshooting.
const DEFAULT_FALSE_FIELDS = new Set([
  'quoteTargetIsSelf', 'isOwner', 'isSelf', 'hasMedia', 'hasForward'
]);
const OPTIONAL_FIELDS = new Set([
  'seq', 'messageId', 'sender', 'userId', 'text', 'plain', 'tail', 'kind',
  'ownerLabel', 'media', 'forwardIds', 'nestedForwardIds'
]);

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEmpty(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

function compactMedia(media, canResolveByMessage) {
  return media.map((item, index) => {
    if (!isRecord(item)) return item;
    const result = { ...item };
    // A local seq is a bridge message handle accepted by qq_get_message_images.
    // Forwarded nodes only have messageSeq, and may not be locally resolvable:
    // keep their transport references, even when they happen to have messageId.
    if (canResolveByMessage) {
      delete result.file;
      delete result.url;
      // Match the image tool's one-based ordering; never filter/reorder items.
      if (result.index == null) result.index = index + 1;
    } else if (result.file === result.url) {
      delete result.file;
    }
    for (const key of ['file', 'url', 'faceId']) {
      if (isEmpty(result[key])) delete result[key];
    }
    return result;
  });
}

export function compactModelMessage(message) {
  if (!isRecord(message)) return message;
  const result = { ...message };
  // No trimming or truncation: differing plain text can contain resolved quote
  // context, and tail can carry the end of a long message absent from text.
  const seenText = new Set();
  for (const key of ['text', 'plain', 'tail']) {
    if (typeof result[key] !== 'string') continue;
    if (seenText.has(result[key])) delete result[key];
    else seenText.add(result[key]);
  }
  for (const key of OPTIONAL_FIELDS) {
    if (isEmpty(result[key])) delete result[key];
  }
  for (const key of DEFAULT_FALSE_FIELDS) {
    if (result[key] === false) delete result[key];
  }
  if (Array.isArray(result.media)) {
    const canResolveByMessage = Number.isSafeInteger(message.seq) && message.seq > 0;
    result.media = compactMedia(result.media, canResolveByMessage);
  }
  return result;
}

export function compactModelData(data, depth = 0, seen = new WeakSet()) {
  // ⚠ 本机补丁（2026-10-21）：加深度上限 + 循环引用保护。
  //
  // 原来是无条件递归遍历所有属性。合并转发的原始数据（bot.raw('get_forward_msg')
  // 返回的那个结构）里可能带循环引用或极深的嵌套，一旦踩到就是
  // `RangeError: Maximum call stack size exceeded` —— 未捕获异常直接把 MCP server
  // 进程带走。于是 qq_get_forward_msg 连着两次只回一句「Connection closed」：
  // 工具自己的 catch（「查看合并转发失败：…」）根本没机会执行，进程已经没了。
  // 这也是为什么 bridge.log 里一条「合并转发」记录都查不到 —— 请求压根没走到那层。
  // 现在：太深就截断，遇到环就置空，序列化永远不会爆栈。
  if (depth > 12) return null;
  if (Array.isArray(data)) {
    if (seen.has(data)) return null;
    seen.add(data);
    try {
      return data.map((item) => compactModelData(item, depth + 1, seen));
    } finally { seen.delete(data); }
  }
  if (!isRecord(data)) return data;
  if (seen.has(data)) return null;
  seen.add(data);
  try {
    return Object.fromEntries(Object.entries(data).map(([key, value]) => [
      key,
      (key === 'messages' || key === 'newMessages') && Array.isArray(value)
        ? value.map((item) => compactModelMessage(item))
        : compactModelData(value, depth + 1, seen)
    ]));
  } finally { seen.delete(data); }
}

export function serializeModelData(data) {
  return JSON.stringify(compactModelData(data));
}
