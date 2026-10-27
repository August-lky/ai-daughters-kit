// 两个入口共用工具目录，避免原生插件与 API 小工具的参数发生漂移。
const empty = () => ({ type: 'object', properties: {}, additionalProperties: false });

export const TOOL_DEFINITIONS = [
  {
    name: 'douyin_comment_drafts',
    description: '看、确认或丢掉你刷视频时写的抖音评论草稿。草稿不会自己发：action="list" 看有哪些；action="confirm" 加 draftId 确认要发（可以顺手用 text 改几个字），下次刷视频时会先打开那条视频发出去；action="discard" 丢掉不发。评论是公开的，发出去删不掉，可能被认出是 AI。抖音对短时间发很多评论会风控，发多少你自己掂量。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'confirm', 'discard'], description: 'list=看草稿，confirm=确认要发，discard=丢掉' },
        draftId: { type: 'string', description: '草稿编号，比如 c3（confirm / discard 时要填）' },
        text: { type: 'string', minLength: 1, maxLength: 200, description: '确认时想改成的原话（可选，不填就发原来写的）' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  { name: 'douyin_open', description: '打开抖音网页版推荐流。需要登录或验证时交给用户操作。', parameters: empty() },
    {
      name: 'douyin_chat_send',
      description: '主动给某位好友发一条私信（不需要对方先发消息）。只能发给已核对的白名单好友。想说什么就说，想说几句说几句；一条最多 1000 字（抖音单条上限），更长就分几条发。抖音对短时间大量私信会风控（弹验证码，所有抖音工具会停住等老大处理），发多快你自己掂量。',
      parameters: {
        type: 'object',
        properties: {
          recipientId: { type: 'string', description: '联系人 id，来自 douyin_chat_contacts 返回的精确 id（conv:...）' },
          message: { type: 'string', minLength: 1, maxLength: 1000, description: '要发的话，一条最多 1000 字（抖音单条上限）；更长就分几条发' },
          clearDraft: { type: 'boolean', description: '输入框里卡着别的东西、报错告诉你框里是什么时：确认不要了就填 true，会先清空再发' }
        },
        required: ['recipientId', 'message'],
        additionalProperties: false
      }
    },
  {
    name: 'douyin_search',
    description: '在抖音网页版搜索关键词，并返回当前可见结果。',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 300, description: '要搜索的关键词，不能为空，最多 300 字。' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'douyin_open_video',
    description: '打开刚刚读取的搜索结果，或用户提供的抖音公开视频链接。index 与 url 至少提供一个。',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'integer', minimum: 0, description: '已读取搜索结果中的 index。' },
        url: { type: 'string', description: 'https://www.douyin.com/video/作品ID 公开链接。' },
      },
      additionalProperties: false,
    },
  },
  { name: 'douyin_next', description: '切换到下一条抖音视频，并返回切换后的状态。', parameters: empty() },
  { name: 'douyin_previous', description: '切换到上一条抖音视频，并返回切换后的状态。', parameters: empty() },
  { name: 'douyin_status', description: '读取抖音当前页面、可见文字与播放状态。文字不能代替视频画面内容。', parameters: empty() },
  {
    name: 'douyin_observe',
    description: '观察当前视频一小段时间，采集画面和播放状态。只有支持图像输入的模型才能理解画面。',
    parameters: { type: 'object', properties: { seconds: { type: 'number', minimum: 1, maximum: 60, description: '观察秒数，默认 3 秒，范围 1 到 60 秒（长时间观察会在这段时间里均匀抽帧）。' } }, additionalProperties: false },
  },
  { name: 'douyin_screenshot', description: '获取当前抖音可见画面，供支持图像输入的模型查看。', parameters: empty() },
  { name: 'douyin_pause', description: '暂停当前抖音视频。', parameters: empty() },
  { name: 'douyin_play', description: '播放当前抖音视频，并返回实际播放状态。', parameters: empty() },
  {
    name: 'douyin_remember',
    description: '把用户明确要求记住的内容写入与 QQ 机器人互通的记忆。不要保存凭据或推测为事实的内容。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', minLength: 1, maxLength: 4000, description: '需要记住的内容，不能为空，最多 4000 字。' },
        kind: { type: 'string', maxLength: 40, description: '可选记忆类型，最多 40 字，由共享记忆适配器处理。' },
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'douyin_recall',
    description: '检索与 QQ 机器人互通的既有记忆。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 300, description: '可选检索词，最多 300 字。空查询不读取 QQ 聊天历史。' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: '返回条数，默认由适配器决定，范围 1 到 20。' },
      },
      additionalProperties: false,
    },
  },
  { name:'douyin_chat_contacts',description:'读取本机抖音私信联系人元数据并核对关注关系，不读取其他会话正文。',parameters:empty() },
  { name:'douyin_chat_status',description:'读取私信自动回复的许可名单、运行状态、预算和暂停原因。',parameters:empty() },
  { name:'douyin_chat_start',description:'按已核对的本机许可名单启动私信自动回复，只处理启动后新消息。需要用户明确要求启动，不修改许可名单。',parameters:empty() },
  { name:'douyin_chat_stop',description:'停止正在运行的私信自动回复，取消待生成回复并保留发送核对记录。',parameters:empty() },
  {
    name:'douyin_chat_read',description:'读取许可名单内一个指定联系人的私信。名单外、身份歧义或群聊会拒绝。',
    parameters:{type:'object',properties:{recipientId:{type:'string',minLength:1,maxLength:500,description:'由douyin_chat_contacts返回的精确本机联系人ID。'}},required:['recipientId'],additionalProperties:false},
  },
  {
    name:'douyin_chat_observe',description:'读取许可名单内指定表情或分享卡片的实际画面；分享视频只在允许的刷视频时间内采样，不能把封面当成看完整条作品。',
    parameters:{type:'object',properties:{recipientId:{type:'string',minLength:1,maxLength:500},messageId:{type:'string',minLength:1,maxLength:80}},required:['recipientId','messageId'],additionalProperties:false},
  },
  {name:'douyin_video_limits_status',description:'读取自定义刷视频时间段、单轮时长及剩余时间。开始新一轮只能由用户在控制台或CLI操作。',parameters:empty()},
  {name:'douyin_media_status',description:'读取可选音频能力的开关、后端及依赖状态；默认关闭，不返回任何密钥。',parameters:empty()},
  {name:'douyin_listen',description:'在音频开关开启且刷视频时间允许时，录取当前抖音视频最多10秒实际音轨并转写。不会录麦克风或其他程序声音。',parameters:{type:'object',properties:{seconds:{type:'number',minimum:1,maximum:10,description:'录取秒数，默认8，范围1至10。'}},additionalProperties:false}},
  // 本机补丁（2026-10-25，score）：读谱。只在她想细看一首歌的旋律时用。
  {name:'douyin_score',description:'读谱：把当前正在看的抖音视频实时录一段（录多少秒就要等多少秒，录的时候别切走），扒成谱面卡——按小节排的简谱旋律、每小节和弦（带它在这个调里的级数）、快慢、调性、人声音域和响度。你拿到的是旋律本身，可以自己读出哪里往上跳、和弦怎么走。想细看一首歌的时候再用；默认录30秒，最多60秒，录完再等半分钟左右出卡。机器扒的是大概的谱子，转音和七和弦会有出入。',parameters:{type:'object',properties:{seconds:{type:'number',minimum:10,maximum:60,description:'录取秒数，默认30，范围10至60。'}},additionalProperties:false}},
  {name:'douyin_forward_video',description:'为用户明确选择的好友转发当前作品或公开作品链接。实际发送由本机转发按钮的可信授权入口执行，自动回复和普通视频模型不能发起转发。',parameters:{type:'object',properties:{recipientId:{type:'string',minLength:1,maxLength:500},url:{type:'string',maxLength:1000}},required:['recipientId'],additionalProperties:false}},
  {name:'douyin_persona_status',description:'读取软件与插件共用的最新大肥鱼人格卡、自己的兴趣和有来源的观看记录。人格与记忆不授予额外工具权限。',parameters:empty()},
  {name:'douyin_interest_record',description:'根据真实观看进度、持续停留、跳过和已确认互动更新大肥鱼自己的兴趣。画面主题仅为提案，没有行为依据保持待观察；必须使用宿主证据ID，不得把用户偏好、私信或QQ内容写成自己的兴趣。',parameters:{type:'object',properties:{evidenceId:{type:'string',maxLength:90},topic:{type:'string',maxLength:80},signal:{type:'string',enum:['like','dislike','neutral']},reflection:{type:'string',maxLength:600}},required:['evidenceId','topic','signal','reflection'],additionalProperties:false}},
  // ⚠ 本机补丁（2026-10-22）：想起自己看过的视频（见 video-impressions.mjs）
  {
    name: 'douyin_video_recall',
    description: '想起你自己刷过/分享过的抖音视频：当时看到了什么、看了多久、一路怎么想的、有没有分享给主人。主人在私信里说"这个""那条视频"、或者问视频里讲了什么时先用它，别只看卡片标题和封面就回答。三选一：videoId（精确一条，如 douyin_chat_observe 打开卡片拿到的作品 id）、query（标题/作者/内容关键词，空格分开）、recentShared=true（你最近分享出去的几条）。',
    parameters: {
      type: 'object',
      properties: {
        videoId: { type: 'string', maxLength: 64, description: '作品 id（纯数字）' },
        query: { type: 'string', maxLength: 100, description: '关键词，空格分开，比如「初音 生日」' },
        recentShared: { type: 'boolean', description: 'true = 列出你最近分享出去的几条' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多几条，默认 3' }
      },
      additionalProperties: false
    }
  },
  {name:'douyin_watch_status',description:'读取两入口共用的自主观看状态、当前有限轮次与模型请求预算。不会开始观看。显示「本轮预算已用完」只是这一轮刷完了，想接着刷就调 douyin_watch_start 开新的一轮。',parameters:empty()},
  {name:'douyin_watch_start',description:'开一轮自主刷抖音（一轮 60 次），按你的兴趣挑片、看完更新偏好。想刷就自己开，不用等谁同意：一轮刷完（「本轮预算已用完」）想接着刷，直接再调它就会结束旧的一轮、开新的一轮；不想刷就去干别的。今天的总上限到了、或者不在允许刷视频的时间里，会告诉你。（本机补丁 2026-10-26：主人定的规矩是刷完一轮歇一歇，接下来干什么你自己定。）不点赞或发文字私信；仅在用户开启自主评论且预算允许时可以评论当前作品；只有用户开启自主分享时才可在既有许可名单中自行挑人分享当前观察作品。',parameters:{type:'object',properties:{maxRequests:{type:'integer',minimum:1,maximum:100,description:'本轮自主决策请求上限，默认30，停止再开始不会重置。'}},additionalProperties:false}},
  {name:'douyin_watch_stop',description:'按用户要求停止自主观看并暂停视频，不结束或重启其他服务。',parameters:empty()},
  {name:'douyin_spark_status',description:'只读自动续火花问候的许可、时段、每日预算、已有互动与待核对收据。消息送达不代表平台火花已增加。',parameters:empty()},
  {name:'douyin_spark_start',description:'仅在用户已保存续火花总许可并明确要求启动时，开始有限时段内的人格问候调度。沿用两位许可好友，每好友每天最多一次；已有当天互动跳过，不能修改许可、时段或次数。',parameters:empty()},
  {name:'douyin_spark_stop',description:'按用户要求停止自动续火花问候，取消尚未发出的问候，保留发送核对记录，不停止视频或自动回复。',parameters:empty()},
  {name:'douyin_report_status',description:'只读共享视频日报目录与已有报告摘要，不开始观看或调用模型。',parameters:empty()},
  {name:'douyin_report_generate',description:'按已留存的实际视频观察与行为证据生成今日Markdown日报，不增加浏览或模型请求，不读取人格正文、私信或QQ。',parameters:empty()},
];

// 注册前和执行前均使用同一份定义；只接受目录中声明的简单参数。
export function validateToolArguments(definition, args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('工具参数必须是 JSON 对象。');
  const schema = definition.parameters;
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) throw new TypeError(`缺少参数：${key}`);
  }
  for (const [key, value] of Object.entries(args)) {
    const field = schema.properties[key];
    if (!field) throw new TypeError(`不支持的参数：${key}`);
    if (field.type === 'integer' ? !Number.isSafeInteger(value) : typeof value !== field.type) throw new TypeError(`参数 ${key} 类型错误。`);
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`参数 ${key} 必须是有限数值。`);
    if (typeof value === 'string' && field.maxLength !== undefined && [...value].length > field.maxLength) throw new RangeError(`参数 ${key} 最多 ${field.maxLength} 字。`);
  }
  for (const key of ['query', 'content','recipientId','messageId']) {
    if (schema.required?.includes(key) && args[key].trim().length === 0) throw new TypeError(`参数 ${key} 不能为空。`);
  }
  // 本机补丁（2026-10-21）：上限按各工具自己的 schema 走（douyin_observe 放到 60 秒做"边播边抽帧"，douyin_listen 仍是 10 秒）。
  const maxSeconds = schema.properties?.seconds?.maximum ?? 10;
  if (args.seconds !== undefined && (args.seconds < 1 || args.seconds > maxSeconds)) throw new RangeError(`观察时间须在 1 到 ${maxSeconds} 秒之间。`);
  if (args.limit !== undefined && (args.limit < 1 || args.limit > 20)) throw new RangeError('返回条数须在 1 到 20 之间。');
  if (args.maxRequests !== undefined && (args.maxRequests < 1 || args.maxRequests > 100)) throw new RangeError('自主观看请求上限须为 1 至 100。');
  if (definition.name === 'douyin_interest_record' && (!args.evidenceId.trim() || !args.topic.trim() || !args.reflection.trim() || !['like','dislike','neutral'].includes(args.signal))) throw new TypeError('兴趣更新需要真实证据、主题、有效倾向与简短理由。');
  if(definition.name==='douyin_chat_observe' && !/^msg:[a-f0-9]{64}$/.test(args.messageId)) throw new TypeError('需要已读取的精确消息ID。');
  if(definition.name==='douyin_forward_video' && args.url!==undefined && !/^https:\/\/(?:www\.)?douyin\.com\/video\/\d+\/?(?:\?[^#]*)?(?:#.*)?$/.test(args.url)) throw new TypeError('转发链接必须是抖音公开video链接。');
  if (definition.name === 'douyin_open_video') {
    if (args.index === undefined && args.url === undefined) throw new TypeError('打开作品需要 index 或 url。');
    if (args.index !== undefined && args.index < 0) throw new RangeError('搜索结果 index 不能为负数。');
    if (args.url !== undefined && !/^https:\/\/(?:www\.)?douyin\.com\/video\/\d+\/?(?:\?[^#]*)?(?:#.*)?$/.test(args.url)) throw new TypeError('作品链接必须是抖音公开 video 链接。');
  }
  return args;
}

export default TOOL_DEFINITIONS;
