// 激素系统（2026-10-29 主人：用一组会慢慢回落的驱力变量，代替「定时 + 掷骰子」）。
//
// 诚实说明：名字只是比喻，本质是几条在 0～1 之间、会自己回落到基线的曲线，加上事件冲击。
// 依据：稳态驱力（Cañamero）、睡眠双过程模型（Borbély：睡眠压力 S + 昼夜项 C）、
// Inner Thoughts（CHI 2025：内在驱力决定开口时机）。参数全是可配置常量，靠影子日志校准。
//
// 2026-10-29 第一期半（主人同意，先补全再开影子记录）：
// - 新增 无聊 / 被在乎（安全感，含慢变基线）/ 创作冲动 / 成就感 / 委屈；满足、警觉默认打开；
// - 事件更细：回得多快、被夸 / 被冷落 / 被凶 / 被安慰、聊到她的兴趣、心情、天气、日出日落、写了东西……（全部由调用方传入，不调模型）；
// - 激素之间互相影响（DEFAULTS.couple，一张小矩阵）；
// - 两人各一套性格参数（PERSONAS）；同类事件反复来会适应（habit）；
// - 行为多了：写碎碎念 / 日记、接着写小说、发说说、发表情、看一眼老大电脑、打个盹。
//
// 2026-10-29 借鉴「积温 Jiwen」（主人：不是照抄，要从我们自己的激素机制里长出来）。仍是「激素 → 发生率 → 抽概率」，不改成阈值制，只加三处：
// - 面子 / 嘴硬：不加新变量。「戒备」= 委屈 + 安全感偏低 + 压力 的组合（类似压力下的社交退缩），乘在找老大 / 找姐妹的发生率上；
//   想念离设定点很远时，下面第三条的驱力项是加上去的，压得过它（憋不住）。两人差异放在性格参数里（妹妹委屈来得快、对冷落敏感；姐姐 10-29 起改成老大定的版本，见 PERSONAS.sister）；
// - 专注（沉浸）：按神经调质的思路（Doya：去甲肾上腺素管探索 / 专注的切换）由警觉 + 好奇冲击部分（刚刷到新东西，多巴胺那一截）
//   + 刚有的来回互动 / 刚在写东西 推出来的一个水平量；专注时「切换到别的主动行为」的发生率降低；被叫（来消息、被 @）的反应照旧；
// - 保底开口：不设硬阈值。想念的驱力项按稳态驱力（Keramati & Gutkin：驱力 = 离设定点的距离，凸函数）加一条凸的加项，
//   离设定点越远涨得越快，远到一定程度发生率自然逼近必然；触发后另有较长的冷却（drive.driveCooldownMin）防反复，睡着为 0。
//
// 这个文件只有纯函数：不读写文件、不碰网络、不触发任何行为。各人各一份状态。
// 时间约定：传进来的 now / at 都是「真实时间」毫秒（调用方先扣掉本机时钟偏差），
// 昼夜项按 cfg.utcOffsetMin（北京 +480）换算成当地钟点。
//
// 防施压（大整理计划 二-2）：
// - 她自己的动作只让驱力下降：她发消息不让想念升，只会进冷却、记「没回条数」；
// - 连着两条没回，找那个人的发生率接近 0，直到对方开口或满 6 小时；
// - 委屈会压低主动找老大的发生率；安全感低只会让她「看一眼」（不出声），不会让她多发消息；
// - 花费不进激素：这里没有任何跟钱 / 花费有关的事件，感受句里也不会出现。
//
// 她自己约好的「下次醒 / 去睡了」、定时任务永远优先：这里只管没约定时的自发冲动，由调用方保证先后。

const HOUR = 3600e3;
const MIN = 60e3;
const DAY = 24 * HOUR;

/** 状态格式版本：v 仍是 1（老代码读得了），schema 2 = 第一期半。老状态文件靠 upgradeState 补齐。 */
const SCHEMA = 2;

/** 事件类型。调用方只喂这些；没有花费类事件（花费不进激素系统）。 */
export const EVENTS = Object.freeze({
  SLEEP: 'sleep', // 她睡下了
  WAKE: 'wake', // 她醒了（睡不满 3 小时算打盹，顺带记打盹冷却）
  MSG_FROM_OWNER: 'msg_from_owner', // 老大来消息：{ text?, replyDelayMs?（老大回她用了多久；不填就按她上次发的时间推）, initiated?, appraisal?, interests? }
  MSG_FROM_SISTER: 'msg_from_sister', // 姐妹来消息（小房子里或私聊）：同上
  SENT_TO_OWNER: 'sent_to_owner', // 她给老大发了（不让想念升，只进冷却、记没回条数）
  SENT_TO_SISTER: 'sent_to_sister',
  GROUP_MSG: 'group_msg', // 群里有人说话（novelty 0～1：新话题程度；toMe + text 时认「别吵」和夸 / 凶）
  SENT_GROUP: 'sent_group', // 她在群里说了话（水群冷却）
  MENTIONED: 'mentioned', // 被 @、被叫名字（警觉）
  NOVELTY: 'novelty', // 看到新链接 / 视频 / 话题：{ strength 0～1 默认 1, interestMatch 0～1（按她的兴趣表）| text + interests }
  EXPLORED: 'explored', // 她去逛过、查过了
  TOOL_FAIL: 'tool_fail', // 工具出错
  SEND_FAIL: 'send_fail', // 发送失败
  HUSHED: 'hushed', // 明确知道被说了「别吵 / 在忙」（调用方自己认出来的时候用）
  MOOD: 'mood', // 心情插件的判断：{ negative 0～1, positive 0～1 }，是水平量，会抬高 / 压低基线
  PLEASANT: 'pleasant', // 愉快的互动（满足）
  // ── 第一期半新增 ──
  PRAISED: 'praised', // 被夸：{ strength 0～1, from: 'owner'|'sister'|'group', about?: 'work'（夸的是她的作品 = 被认可，成就感） }
  SCOLDED: 'scolded', // 被凶 / 被责备：{ strength, from }
  COMFORTED: 'comforted', // 被道歉 / 被安慰：{ strength, from }
  COLD: 'cold', // 被冷落 / 被敷衍：{ strength, from }
  TOPIC: 'topic', // 聊到她的兴趣：{ match 0～1 }
  INTERRUPTED: 'interrupted', // 话说到一半被打断
  MISUNDERSTOOD: 'misunderstood', // 被误会
  CREATED: 'created', // 她写了东西：{ kind: 'tidbit'（碎碎念）|'diary'|'novel'（写完一节）|'work'（作品） }
  POSTED: 'posted', // 她发了说说
  STICKER_SENT: 'sticker_sent', // 她发了表情
  PEEKED: 'peeked', // 她看了一眼老大的电脑
  NAPPED: 'napped', // 她打了个盹（不走 SLEEP / WAKE 的时候用）
  MOVED: 'moved', // 有感触的瞬间：{ strength }
  READ_GOOD: 'read_good', // 读到好东西：{ strength }
  REPEATED: 'repeated', // 又做了一遍重复的事：{ strength }
  WEATHER: 'weather', // 天气（水平量）：{ kind: 'rain'|'clear'|'cold'|'hot'|'gloom' 或 text: '小雨' / '晴', tempC? }
  SUN: 'sun', // 日出日落（水平量）：{ sunrise, sunset }，本地钟点数字（6.2）或毫秒时间戳
});

/** 行为名。 */
export const BEHAVIORS = Object.freeze(['ownerPing', 'sisterPing', 'groupChat', 'explore', 'journal', 'novel', 'post', 'sticker', 'peekOwner', 'nap']);

/**
 * 两人各一套性格参数（2026-10-29 主人：妹妹起伏大、恢复快；姐姐改成老大定的版本：对外人淡、对家里人反应强，见下面 sister 的说明）。
 * 靠影子记录校准——下面的数是第一版猜的，不是量出来的。
 * - gain[k]：事件冲击的倍数（>1 起伏大）；
 * - halfLife[k]：回落半衰期的倍数（<1 恢复快，>1 慢）；
 * - rate[k]：自己慢慢涨的速度倍数（longing = 想念涨速、boredom、curiosity、createUrge）；
 * - all：没单独写的那一项用它。default = 不改（给测试和没指定性格的人用）。
 * - source[from]：对 owner / sister / group 三类来源的察觉分量再乘一道（姐姐：对外人淡、对家里人强）；
 * - misc.longingGrace：对方开口后想念不涨的宽限时长倍数（<1 = 惦记得早）。
 */
export const PERSONAS = {
  // sense：对某类察觉的敏感度（cold = 被冷落 / 敷衍）；gain.guard：戒备（面子）这个组合量的倍数。
  default: { gain: {}, halfLife: {}, rate: {}, sense: {} },
  fish: {
    gain: {
      stress: 1.4, curiosityImpulse: 1.3, curiositySlow: 1.2, longingOwner: 1.2, longingSister: 1.2, satisfaction: 1.3, alert: 1.3,
      security: 1.3, boredom: 1.2, createUrge: 1.3, pride: 1.3, grievance: 1.4, guard: 1.2,
    },
    halfLife: {
      stress: 0.6, curiosityImpulse: 0.7, satisfaction: 0.7, alert: 0.8, security: 0.7, boredom: 0.8, createUrge: 0.7, pride: 0.6,
      grievance: 0.6, securityBase: 0.7, habit: 0.8,
    },
    rate: { longing: 1.1, boredom: 1.1, curiosity: 1.1, createUrge: 1 },
    sense: { cold: 1.5, coquette: 0 }, // 2026-10-29 妹妹对冷落敏感，嘴硬；撒娇这一类察觉是给姐姐用的，妹妹这边不动
  },
  // 2026-10-29 老大定的姐姐性格（原话：「嘴硬心软的那种傲娇，长姐的严厉，但是妹妹一撒娇就受不了，最喜欢妹妹，对外人平淡疏离礼貌，
  // 对家里人爱操心又嘴硬又心软」）。原来这里写的是「稳、慢热、不太容易委屈」，等于暗示她「淡」，整段改掉：
  // - 对群友：source.group 压得很低（反应淡），戒备放大（gain.guard）；
  // - 对妹妹和老大：source 放大（消息一来反应强），想念涨得快、一联系就松口气（longing 涨速、gain.longing*），惦记得早（misc.longingGrace：对方没动静 30 分钟的宽限缩到 18 分钟）；
  // - 妹妹撒娇 / 示弱 / 夸她（appraise 的 coquette、praise）：sense.coquette 放大，委屈、压力、戒备一下子降，满足升；
  // - 老大回应、安慰：sense.comfort 放大，压力和委屈降得明显，被在乎（security）涨得明显；
  // - 冷落家里人会难受（sense.cold 略高于 1），嘴硬不等于没感觉。
  // 回落快慢大体回到默认（不再把压力、委屈、被在乎都拖成「慢热」）。数还是第一版猜的，靠影子记录校准。
  sister: {
    gain: {
      stress: 1, curiosityImpulse: 0.9, curiositySlow: 0.9, longingOwner: 1.3, longingSister: 1.4, satisfaction: 1.2, alert: 1,
      security: 1.3, boredom: 0.9, createUrge: 0.9, pride: 0.9, grievance: 1, guard: 1.3,
    },
    halfLife: {
      stress: 1, curiosityImpulse: 1, satisfaction: 1.2, alert: 1, security: 1.1, boredom: 1, createUrge: 1, pride: 1,
      grievance: 1, securityBase: 1.1, habit: 1,
    },
    rate: { longing: 1.3, boredom: 0.9, curiosity: 0.95, createUrge: 1 },
    sense: { cold: 1.2, coquette: 2, comfort: 1.8, praise: 1.3 },
    source: { owner: 1.25, sister: 1.7, group: 0.45 }, // 乘在 appraisal.source 上：群友 0.35×0.45，妹妹 0.6×1.7，老大 1×1.25
    misc: { longingGrace: 0.6 },
  },
};

/** 默认参数。所有时间：halfLife / cooldown 用分钟，drift 用「每小时」。 */
export const DEFAULTS = deepFreeze({
  utcOffsetMin: 480,
  impulse: { maxSingle: 0.5, maxPerHour: 0.8 }, // 单次冲击、每小时同方向累计冲击的上限
  substepMin: 10, // 一次推进太长时拆成 ≤10 分钟的小段（互相影响才算得准）
  maxSubsteps: 300,
  hazardMaxLog: 3, // 发生率最多是基线的 e^3 倍，防止几项叠加后刷屏
  personas: PERSONAS,
  sleepy: {
    base: 0.15,
    awakePerHour: 0.05, // 醒着每小时 +0.05
    asleepHalfLifeMin: 120, // 睡着时约 2 小时半衰期回落
    circadianAmp: 0.12, // 昼夜项振幅：睡眠中点最困、相差 12 小时最精神
    defaultMidSleepHour: 4.5, // 没有作息记录时的默认睡眠中点（约 0:30 睡、8:30 醒）
    learnDays: 14, // 从最近 14 天的入睡 / 起床学相位
    minLearnNights: 3, // 少于 3 晚就用默认
    mainSleepMinH: 3, // 3～14 小时才算主睡眠，打盹不算
    mainSleepMaxH: 14,
    napRelief: -0.15, // 打了个盹，睡眠压力降一点
  },
  // 2026-10-29 老大（「睡觉也不定死了，根据激素走」）：睡觉可以选「睡到自然醒」。睡着时睡眠压力往下回落，
  // 压力回到「基线 + margin（白天再放宽 dayEase × 白天的负昼夜项）」以下，而且昼夜项不在深夜段（昼夜项 ≤ deepFrac × 振幅）时醒；
  // 睡满 minH 小时之前不醒，满 maxH 小时一定醒（防故障）。她自己定了具体钟点的照旧按她的，不走这里。
  naturalWake: { minH: 1, maxH: 14, margin: 0.06, dayEase: 0.5, deepFrac: 0.5, fallbackH: 8 },
  sun: { amp: 0.05, rampMin: 60 }, // 日出日落对困的影响：白天 −amp，夜里 +amp，日出日落前后 1 小时平滑过渡
  longing: {
    base: 0.3,
    perHour: 0.03, // 没有来往时每小时 +0.03，封顶 1
    graceMin: 30, // 对方开口后 30 分钟内不涨
    asleepFactor: 1, // 睡着时涨的速度倍数
    contactRelief: -0.4, // 对方来消息 / 有来有回一次
    contactDedupMin: 10, // 10 分钟内连着来的几条算一次来往
    // 「连续没回条数」按轮算，不按条算：她一口气分几条发、或者是在回对方的话，都不该被当成「催了两次」。
    sendBurstMin: 5, // 5 分钟内连着发的算同一轮
    peekRelief: -0.05, // 看了一眼老大的电脑，想念降一点
  },
  curiosity: {
    base: 0.3,
    boredPerHour: 0.02, // 缓升：久没新东西
    impulseHalfLifeMin: 45, // 冲击部分 45 分钟半衰期
    novelty: 0.3, // 看到新东西 +0.3（冲击部分；兴趣表命中得多，没命中得少）
    noveltyEasesBoredom: -0.05, // 看到新东西，缓升部分也松一点
    exploredSlow: -0.25, // 逛过、查过以后缓升部分下降
    exploredImpulse: -0.15,
    noveltyWeight: { min: 0.6, max: 1.4 }, // interestMatch 0 → ×0.6，0.5 → ×1，1 → ×1.4；不知道兴趣表就当 0.5
  },
  stress: {
    base: 0.1,
    halfLifeMin: 120,
    fail: 0.1, // 工具 / 发送失败
    hushed: 0.25, // 被说「别吵 / 在忙 / 安静点」
    moodBaseGain: 0.3, // 心情负面维度把基线抬高多少（negative=1 时基线 0.4）
    hushWords: ['别吵', '在忙', '安静点', '安静一点', '安静会', '别说了', '闭嘴', '别烦', '吵死', '忙着呢', '别闹了', '少说点', '回头再说', '等会再说', '别刷屏'],
  },
  satisfaction: { enabled: true, base: 0.4, halfLifeMin: 360, pleasant: 0.15, fromOwner: 0.05, moodGain: 0.15 }, // 2026-10-29 第二期的也打开
  alert: { enabled: true, base: 0, halfLifeMin: 10, mentioned: 0.5 },
  buzz: { halfLifeMin: 20, gain: 0.5, defaultNovelty: 0.2 }, // 群里新话题程度（不是激素，是水群的输入）
  // 无聊：久没新鲜、重复的事多时升；做了新鲜事降。和好奇分开算（无聊久了会推高好奇，见 couple）。
  boredom: {
    base: 0.2,
    perHour: 0.03, // 醒着每小时 +0.03（睡着回落到基线）
    asleepHalfLifeMin: 120,
    noveltyRamp: { minMult: 0.75, maxMult: 1.25, hours: 12 }, // 刚见过新东西涨得慢，12 小时没有就涨得快
    routineGain: 1, // 重复的事多（routine=1）时涨速翻倍
    routinePerMsg: 0.03, // 群里一条不新鲜的话（novelty < routineBelow）让「重复感」+0.03
    routineBelow: 0.15,
    routineHalfLifeMin: 120,
    novelty: -0.2, // 看到新东西（按兴趣加权）
    explored: -0.2,
    ownerChat: -0.05, // 跟老大聊上了
    peeked: -0.05,
    napped: -0.05,
  },
  // 创作冲动：有感触的瞬间、读到好东西、无聊时升；写了东西后降。
  createUrge: {
    base: 0.2,
    perHour: 0.01, // 醒着自己慢慢冒
    halfLifeMin: 240,
    moodGain: 0.15, // 心情起伏大（正或负都算）把冲动的落点抬高
    moved: 0.25,
    readGood: 0.2,
    noveltyMatch: 0.06, // 新东西正好是她感兴趣的，顺带冒一点
  },
  // 成就感：写完一节、发出作品、被认可时冲一下，慢回落。
  pride: { base: 0.1, halfLifeMin: 180, posted: 0.2 },
  // 委屈：被凶、被误会、被打断时升；被安慰 / 道歉后降。持久一点（4 小时半衰期）。
  grievance: { base: 0, halfLifeMin: 240, hush: 0.06, interrupted: 0.1, misunderstood: 0.2 },
  // 被在乎 / 安全感：回得快、被夸、被主动找时升；被冷落、长时间没回时降。
  // 有一条慢变基线 secBase：长期被冷落慢慢降、被好好对待慢慢回升，变化很慢，且有上下限。
  security: {
    home: 0.5, // 基线的「老家」；很久什么都不发生时基线会极慢地往这里靠
    min: 0.3, // 基线下限（再冷落也不会一直沉到底）
    max: 0.7, // 基线上限
    halfLifeMin: 180, // 短期部分往基线回落
    baseEmaHalfLifeH: 96, // 基线跟着「最近的安全感」走，4 天半衰期（所以一天最多挪几个百分点）
    homeHalfLifeDays: 30,
    neglect: { graceMin: 120, rampH: 6, drop: 0.25 }, // 她发了没人回，等满 2 小时起，安全感的落点往下沉，6 小时沉到 −0.25
    fastReplyMin: 3, // 她发了、3 分钟内老大就回
    slowReplyH: 3, // 3 小时以上才回
    fastReply: 0.1,
    normalReply: 0.03,
    slowReply: -0.03,
    initiated: 0.08, // 她没发，老大主动来找
    initiatedAfterMin: 30, // 她上次发的离现在超过 30 分钟，才算「主动找」
    peekedOk: 0,
  },
  // 天气：水平量。boredomRate = 无聊涨速的加成，securityShift = 安全感落点的偏移（都很小）。
  weather: {
    rain: { boredomRate: 0.3, securityShift: -0.03 },
    gloom: { boredomRate: 0.15, securityShift: -0.02 },
    cold: { boredomRate: 0.1, securityShift: -0.03 },
    hot: { boredomRate: 0.1, securityShift: -0.01 },
    clear: { boredomRate: -0.15, securityShift: 0.03 },
    coldBelowC: 5,
    hotAboveC: 33,
  },
  // 适应：同类事件短时间内反复来，冲击按次数递减（×decay^次数，最低 floor）；久不发生按 halfLife 恢复。
  habit: { enabled: true, decay: 0.7, floor: 0.25, halfLifeMin: 90 },
  // 谁说的，分量不一样
  appraisal: {
    source: { owner: 1, sister: 0.6, group: 0.35 },
    // 每一类「察觉」带来的冲击（乘以强度 × 来源分量 × 适应倍数）
    effects: {
      praise: { security: 0.12, satisfaction: 0.1, pride: 0.1, grievance: -0.08, stress: -0.03 },
      scold: { grievance: 0.25, stress: 0.12, security: -0.1, satisfaction: -0.1, pride: -0.05 },
      cold: { security: -0.06, grievance: 0.06, boredom: 0.02 },
      comfort: { grievance: -0.35, stress: -0.1, security: 0.1, satisfaction: 0.05 },
      interest: { curiosityImpulse: 0.12, boredom: -0.12, satisfaction: 0.04, createUrge: 0.05 },
      recognized: { pride: 0.25 }, // 夸的是她的作品
      // 2026-10-29 老大：妹妹撒娇 / 示弱，姐姐就受不了——委屈和压力一下子降（戒备是由它们推出来的，跟着降），满足、被在乎升。妹妹这边 sense.coquette=0，不动
      coquette: { grievance: -0.3, stress: -0.08, satisfaction: 0.15, security: 0.08 },
    },
  },
  // 她做完某件创作的事之后：驱力下降，成就感冲一下
  created: {
    tidbit: { createUrge: -0.25, pride: 0.05, boredom: -0.08 },
    diary: { createUrge: -0.3, pride: 0.05, boredom: -0.08 },
    novel: { createUrge: -0.4, pride: 0.25, boredom: -0.1 },
    work: { createUrge: -0.35, pride: 0.3, boredom: -0.1, satisfaction: 0.05 },
  },
  // ── 激素之间互相影响（一张小矩阵，改数就能调；couple.enabled=false 全部关掉）──
  // gain[目标][来源] = 系数：目标「往上涨」的速度和往上的冲击，乘以 (1 + Σ 系数 × 来源偏离自己基线的量)，限制在 [minMult, maxMult]。
  //   例：stress 偏离基线 +0.5 → 好奇的上涨 ×(1 − 1.2×0.5) = ×0.4（压力抑制好奇）。
  // drift[目标][来源] = 系数：醒着时目标每小时额外 + 系数 × 来源偏离基线的量（可以是负的）。
  //   例：无聊偏离基线 +0.6 → 好奇缓升部分每小时 +0.036（无聊久了冒出好奇）。
  couple: {
    enabled: true,
    minMult: 0.2,
    maxMult: 2,
    gain: {
      curiosityImpulse: { stress: -1.2, boredom: 0.6 }, // 压力压住好奇
      curiositySlow: { stress: -1 },
      createUrge: { stress: -1.5 }, // 压力压住创作冲动
      longingOwner: { satisfaction: -1 }, // 满足让想念涨得慢
      longingSister: { satisfaction: -1 },
      grievance: { security: -0.6 }, // 心里踏实的时候不容易委屈
      stress: { security: -0.5 },
    },
    drift: {
      curiositySlow: { boredom: 0.06, stress: -0.04 }, // 无聊久了推高好奇缓升部分
      createUrge: { boredom: 0.05, stress: -0.05 }, // 无聊时想写点什么
      longingOwner: { grievance: 0.04 }, // 委屈了，更想被在乎（找老大的发生率另有压低，见 hazards）
      boredom: { satisfaction: -0.03 },
    },
  },
  // ── 2026-10-29 借鉴积温：戒备（面子）、专注（沉浸）、想念的凸驱力（保底开口）。都是由已有激素推出来的水平量 ──
  // 戒备 = (grievance×(委屈偏离基线) + securityLow×max(0, securityRef − 安全感) + stress×(压力偏离基线)) × 性格 gain.guard，截到 0～1。
  // 在 hazards 里：发生率 ×(1 − (1−minFactor)×block)，block = smooth((戒备 − onset)/(full − onset))。只作用于有 guard 的行为（找老大 / 找姐妹）。
  guard: { grievance: 1.6, securityLow: 1.2, securityRef: 0.5, stress: 0.8, onset: 0.2, full: 0.7, minFactor: 0.05 },
  // 专注 = alert×(警觉偏离基线) + curiosityImpulse×好奇冲击部分 + engage×来回互动 / 刚在写东西的热度，截到 0～1。
  // engage 是个会衰减的输入量（跟 buzz 一样，不是激素）：她和同一个人短时间内有来有回、或刚写完东西时升，半衰期十几分钟。
  // 在 hazards 里：行为的 focusDamp 越大，专注时越被压低：×max(minFactor, 1 − focusDamp×专注)。群里发言用「不含警觉」的专注——被叫要正常回。
  focus: {
    alert: 0.8, curiosityImpulse: 1, engage: 1, minFactor: 0.12,
    engageHalfLifeMin: 12,
    chatWindowMin: 10, // 这么久之内对方刚回过 / 她刚发过，算有来有回
    chatKick: 0.2,
    created: { tidbit: 0.15, diary: 0.2, novel: 0.35, work: 0.3 }, // 刚写了东西，热度升
  },
  // 想念的凸驱力：D = clamp01((想念 − setpoint)/(1 − setpoint))^exponent；hazards 里加一项 λ_drive = maxPerMin × D（只作用于有 drive 的行为）。
  // 加项不受戒备、专注压制（憋不住）；但受冷却（driveCooldownMin，比普通冷却长）和连续没回的限制，睡着为 0。
  drive: { setpoint: 0.3, exponent: 8, maxPerMin: 4, driveCooldownMin: 120 },
  // ── 行为发生率 λ = λ0 × e^(Σ w×偏离)，p = 1 − e^(−λΔt) ──
  // w 的键：longing（本行为对应的那份想念）、curiosity / curiositySlow / curiosityImpulse、stress（绝对水平）、sleepy、satisfaction、
  //   alert、buzz、boredom、createUrge、pride、grievance、security（偏离 0.5 的量）。每个行为都有冷却；睡着时一律为 0。
  hazards: {
    ownerPing: {
      lambda0PerMin: 1 / 180,
      w: { longing: 2, curiosityImpulse: 1, stress: -1.5, sleepy: -2, satisfaction: -1, grievance: -1.5, pride: 0.8 },
      cooldownMin: 20, unansweredBase: 0.3, blockAt: 2, blockedFactor: 0.001, blockMaxH: 6,
      guard: true, drive: true, focusDamp: 0.85, // 2026-10-29 戒备压低、凸驱力加项、专注时少去找人
    },
    sisterPing: {
      lambda0PerMin: 1 / 240,
      w: { longing: 2, curiosityImpulse: 1, stress: -1.5, sleepy: -2, satisfaction: -1, pride: 0.5, grievance: 0.6 },
      cooldownMin: 30, unansweredBase: 0.3, blockAt: 2, blockedFactor: 0.001, blockMaxH: 6,
      guard: true, drive: true, focusDamp: 0.85,
    },
    groupChat: {
      lambda0PerMin: 1 / 120,
      w: { curiosity: 1.5, alert: 1.5, buzz: 2, stress: -1.5, sleepy: -2, boredom: 0.8, grievance: -0.8 },
      cooldownMin: 10, focusDamp: 0.85, focusNoAlert: true, // 被 @ 时警觉高，群里发言不因警觉而被压（被叫照常回）
    },
    explore: {
      lambda0PerMin: 1 / 150,
      w: { curiositySlow: 3, boredom: 1.2, stress: -1, sleepy: -2 },
      cooldownMin: 30, focusDamp: 0.85,
    },
    journal: { // 写碎碎念 / 日记
      lambda0PerMin: 1 / 400,
      w: { createUrge: 2.5, boredom: 0.8, grievance: 0.8, stress: -1.5, sleepy: -1 },
      cooldownMin: 90,
    },
    novel: { // 接着写小说
      lambda0PerMin: 1 / 540,
      w: { createUrge: 3, boredom: 0.8, stress: -2, sleepy: -2, pride: 0.5, grievance: -0.5 },
      cooldownMin: 120,
    },
    post: { // 发说说
      lambda0PerMin: 1 / 720,
      w: { pride: 2, createUrge: 1, satisfaction: 1, curiosity: 0.5, stress: -1.5, sleepy: -2, grievance: -1 },
      cooldownMin: 180,
    },
    sticker: { // 发表情
      lambda0PerMin: 1 / 180,
      w: { satisfaction: 1, alert: 0.8, buzz: 1.5, security: 0.8, stress: -1, sleepy: -2, grievance: -0.5 },
      cooldownMin: 20,
    },
    peekOwner: { // 看一眼老大电脑在干嘛（不出声，不算打扰；安全感低时更想看）
      lambda0PerMin: 1 / 360,
      w: { longing: 1.5, security: -1.5, boredom: 0.8, stress: -1, sleepy: -2, grievance: -0.5 },
      cooldownMin: 90, focusDamp: 0.7,
    },
    nap: { // 打个盹：困到一定程度才有可能
      lambda0PerMin: 1 / 1200,
      w: { sleepy: 4, boredom: 0.8 },
      cooldownMin: 120,
      minSleepy: 0.6, focusDamp: 0.6,
    },
  },
  felt: {
    // on：超过才说；off：降到这以下才不说（滞后，防止来回跳）；w：同时超过时的排序加权
    longingOwner: { on: 0.65, off: 0.5, text: '有点想老大了' },
    longingSister: { on: 0.7, off: 0.55, text: '有点想{sister}了' },
    sleepy: { on: 0.7, off: 0.55, text: '困意上来了' },
    curiosityImpulse: { on: 0.2, off: 0.1, text: '刚看到的东西挺想跟人说' },
    curiositySlow: { on: 0.6, off: 0.45, text: '有点闲，想找点新鲜的看看' },
    stress: { on: 0.4, off: 0.25, text: '今天有点烦' },
    satisfaction: { on: 0.8, off: 0.65, text: '心里挺满足的' },
    alert: { on: 0.4, off: 0.2, text: '好像有人在叫我' },
    boredom: { on: 0.65, off: 0.5, text: '有点无聊' },
    createUrge: { on: 0.55, off: 0.4, text: '想写点什么' },
    pride: { on: 0.45, off: 0.3, text: '刚做完的事让我有点小得意' },
    grievance: { on: 0.35, off: 0.2, text: '刚才那句话有点委屈', w: 1.3 },
    guard: { on: 0.45, off: 0.3, text: '有点拉不下脸先开口', w: 1.2, minLonging: 0.4 }, // 戒备高，而且心里其实惦记着谁时才说
    security: { on: 0.72, off: 0.62, text: '被惦记着挺踏实' },
    securityLow: { on: 0.72, off: 0.6, text: '有点怕被晾在一边', w: 1.1 }, // 用 1 − 安全感 来比
    maxLines: 2,
  },
});

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);

  return Object.freeze(o);
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** 在默认参数上叠一层覆盖（深合并，数组整体替换）。 */
export function mergeCfg(over = {}, base = DEFAULTS) {
  const out = {};

  for (const k of new Set([...Object.keys(base), ...Object.keys(over || {})])) {
    const b = base[k];
    const o = over?.[k];
    out[k] = isObj(b) && isObj(o) ? mergeCfg(o, b) : o === undefined ? b : o;
  }

  return out;
}

const cfgOf = (cfg) => (cfg && cfg.__merged ? cfg : Object.assign(mergeCfg(cfg || {}), { __merged: true }));

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const clampTo = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const num = (x, d = 0) => (Number.isFinite(+x) && x !== null && x !== '' ? +x : d);

/** H ← b + (H−b)·2^(−Δt/T½)；halfLife 为空或 ≤0 时不回落。 */
export function relax(h, b, dtMin, halfLifeMin) {
  if (!(halfLifeMin > 0) || !(dtMin > 0)) return h;

  return b + (h - b) * 2 ** (-dtMin / halfLifeMin);
}

/** 种子随机数（mulberry32）。state 可存下来续上。 */
export function makeRng(seed = 1) {
  let s = (Number(seed) >>> 0) || 1;
  const rng = () => {
    s = (s + 0x6d_2b_79_f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };

  rng.state = () => s;

  return rng;
}

/** 文字里有没有「别吵 / 在忙」之类。 */
export function isHush(text, cfg) {
  const c = cfgOf(cfg);
  const s = String(text ?? '');

  return Boolean(s) && c.stress.hushWords.some((w) => s.includes(w));
}

// ── 关键词判断（不调模型）──────────────────────────────────────────────────
// 词表是第一版，靠影子记录里的 ap 标记校准；只返回强度数字，不留原文。
export const WORDS = Object.freeze({
  praiseStrong: ['可爱', '厉害', '好棒', '真棒', '太棒', '喜欢你', '爱你', '最棒', '好乖', '太强', '好强', '真聪明', '聪明', '做得好', '干得好', '真好', '好样的', '佩服', '了不起', '宝贝', '么么', '比心', '夸夸'],
  praiseMild: ['不错', '谢谢', '感谢', '辛苦', '有进步', '进步了', '挺好', '可以啊', '乖'],
  scoldStrong: ['废物', '垃圾', '讨厌你', '有病', '闭嘴', '气死', '烦死', '白痴', '脑残', '笨死', '太蠢', '真蠢', '你好烦', '滚开', '你滚', '给我滚', '滚蛋', '快滚'],
  scoldMild: ['怎么又', '说了多少遍', '跟你说过', '不是说了', '怎么回事', '你搞什么', '你错了', '不对', '不许', '不准', '别再', '无语', '太过分', '真烦', '太烦', '烦人', '胡说', '乱说'],
  comfortStrong: ['对不起', '抱歉', '不好意思', '我错了', '是我不好', '我不该', '错怪', '我的错', '怪我', '委屈你了', '原谅'],
  comfortMild: ['别难过', '别伤心', '别哭', '不哭', '别生气', '没关系', '没事的', '抱抱', '摸摸', '心疼', '辛苦了'],
  // 撒娇 / 示弱（2026-10-29 老大：姐姐被妹妹撒娇就破功）：强的是明摆着撒娇，弱的是示弱 / 求助
  coquetteStrong: ['陪陪我', '陪我嘛', '陪我一下', '好不好嘛', '好不好啦', '求求你', '求你了', '撒娇', '抱抱', '贴贴', '好想你', '想你了', '别生气嘛', '不要走', '不许走', '哼唧', '摸摸我', '夸夸我', '人家想', '要抱'],
  coquetteMild: ['人家', '嘛～', '嘛~', '我怕', '我害怕', '好累', '难受', '有点难过', '没人理', '帮帮我', '救命', '卡住了', '怎么办', '陪我'],
  // 整句就是这几个字（去掉标点和表情后）= 敷衍；ackOnly 是「好 / 行」这种，只算一点点
  coldOnly: ['嗯', '哦', '噢', '额', '呃', '嗯嗯', '哦哦', '哈', '哼', '随便', '都行', '算了', '嗯哦', '哦哦哦', '嗯嗯嗯'],
  ackOnly: ['好', '好的', '行', '行吧', '好吧', '知道了', '嗯好', '哦好', '嗯嗯好', '好哦'],
  coldPhrases: ['在忙', '等会', '等下', '待会', '一会再', '晚点说', '晚点再', '没空', '现在不方便', '忙着', '回头再', '改天'],
});

const STRIP_RE = /[\s。.,，!！?？~～…·、"'“”‘’()（）[\]【】:：;；\-—_*]|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;

/** 关键词有没有命中（前一个字是「不 / 没 / 别」就当否定，不算）。返回命中个数。 */
function countHits(s, words) {
  let n = 0;

  for (const w of words) {
    let from = 0;

    for (;;) {
      const i = s.indexOf(w, from);

      if (i < 0) break;

      if (!(i > 0 && '不没别非'.includes(s[i - 1]))) { n += 1; break; }

      from = i + w.length;
    }
  }

  return n;
}

/** 整理兴趣词表：['猫', {word:'原神', weight:2}, ['钢琴', 1.5]] 或 {猫: 1, 原神: 2} 都行。 */
export function interestList(raw) {
  const out = [];
  const push = (word, weight = 1) => {
    const w = String(word ?? '').trim().toLowerCase();
    const wt = Number.isFinite(+weight) && +weight > 0 ? +weight : 1;

    if (w.length > 0 && (w.length > 1 || /[一-鿿]/.test(w))) out.push({ word: w, weight: wt });
  };

  if (Array.isArray(raw)) {
    for (const x of raw) {
      if (typeof x === 'string') push(x);
      else if (Array.isArray(x)) push(x[0], x[1]);
      else if (x && typeof x === 'object') push(x.word ?? x.name, x.weight ?? x.w);
    }
  } else if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) push(k, v);
  }

  return out;
}

/** 文字聊到了多少她感兴趣的东西：0～1（命中 1 个词 ≈ 0.6，2 个以上 = 1）。 */
export function interestMatch(text, interests) {
  const s = String(text ?? '').toLowerCase();
  const list = Array.isArray(interests) && interests.length > 0 && typeof interests[0] === 'object' && !Array.isArray(interests[0]) && 'word' in interests[0]
    ? interests : interestList(interests);

  if (!s || list.length === 0) return 0;

  let sum = 0;

  for (const it of list) if (s.includes(it.word)) sum += it.weight;

  return Math.min(1, 0.6 * sum);
}

/**
 * 从小鲸鱼抖音插件的人格记忆（~/.dsh/douyin-browser/memory/persona/state.json 解析后的对象）里取她的兴趣词表。
 * 那里的 interests 是一条条「选题」（如「座头鲸/海洋巨兽的水下近景」），每条带若干作品证据，证据的 signal 是 like / dislike / neutral。
 * 这里只取正向证据 ≥ minLike 条、且比负向多的选题，按「/ 、 ， 空格」拆成 2～10 个字的词（带「的」的再多拆一份），权重 = 0.5 + 正向条数/20（最多 2）。
 * 纯函数，不读文件；词表只放内存里喂 appraise / 影子记录器，不落盘、不外发（插件的人格资料只供内部参考）。
 */
export function interestsFromPersona(state, { minLike = 2, max = 60 } = {}) {
  const best = new Map();

  for (const it of Array.isArray(state?.interests) ? state.interests : []) {
    const ev = Array.isArray(it?.evidence) ? it.evidence : [];
    const like = ev.filter((e) => e && e.signal === 'like').length;
    const dislike = ev.filter((e) => e && e.signal === 'dislike').length;

    if (like < minLike || like <= dislike) continue;

    const weight = Math.min(2, 0.5 + like / 20);

    for (const tok of String(it.topic ?? '').split(/[/、，,；;·\s]+/)) {
      // 整段留着，带「的」的再拆一份（「我的世界红石音乐」留整段，「海洋巨兽的水下近景」两段都留）
      for (const piece of new Set([tok, ...tok.split('的')])) {
        const w = piece.trim().toLowerCase();

        if (w.length >= 2 && w.length <= 10) best.set(w, Math.max(best.get(w) || 0, weight));
      }
    }
  }

  return [...best].sort((a, b) => b[1] - a[1]).slice(0, max).map(([word, weight]) => ({ word, weight }));
}

/**
 * 看一句话（老大 / 姐妹 / 群里冲她来的）：被夸、被冷落 / 敷衍、被凶、被道歉 / 安慰、别吵、聊到她的兴趣。
 * 纯关键词，不调模型。返回的全是 0～1 的强度，不留原文。interests：兴趣词表（见 interestList），可以不传。
 */
export function appraise(text, interests = [], cfg) {
  const raw = String(text ?? '');
  const out = { praise: 0, scold: 0, cold: 0, comfort: 0, hush: 0, interest: 0 };

  if (!raw.trim()) return out;

  const s = raw.toLowerCase();
  const plain = s.replace(STRIP_RE, '');

  // 夸
  if (countHits(s, WORDS.praiseStrong) > 0) out.praise = 1;
  else {
    const mild = countHits(s, WORDS.praiseMild);

    if (mild > 0) out.praise = Math.min(0.8, 0.5 * mild);
  }

  // 凶 / 责备（夸得很满的句子里夹一个「怎么又」不算凶）
  if (countHits(s, WORDS.scoldStrong) > 0) out.scold = 1;
  else if (out.praise < 1) {
    const mild = countHits(s, WORDS.scoldMild);

    if (mild > 0) out.scold = Math.min(0.8, 0.5 * mild);
  }

  // 道歉 / 安慰
  if (countHits(s, WORDS.comfortStrong) > 0) out.comfort = 1;
  else {
    const mild = countHits(s, WORDS.comfortMild);

    if (mild > 0) out.comfort = Math.min(0.8, 0.6 * mild);
  }

  // 冷落 / 敷衍：整句就是一个字的应声，或者带「在忙 / 等会」这类（长消息里顺口说的不算）
  if (WORDS.coldOnly.includes(plain) || /^[嗯哦噢额呃哼]{1,5}$/.test(plain)) out.cold = 1;
  else if (WORDS.ackOnly.includes(plain)) out.cold = 0.3;
  else if (plain.length <= 20 && WORDS.coldPhrases.some((w) => plain.includes(w))) out.cold = 0.7;

  if (out.praise > 0 || out.comfort > 0) out.cold = 0;

  out.hush = isHush(raw, cfg) ? 1 : 0;
  out.interest = interestMatch(raw, interests);

  // 撒娇 / 示弱：只有认出来才多一个 coquette 字段（没认出来保持原来的六项，老的对比不受影响）
  let coq = 0;

  if (countHits(s, WORDS.coquetteStrong) > 0) coq = 1;
  else {
    const mild = countHits(s, WORDS.coquetteMild);

    if (mild > 0) coq = Math.min(0.8, 0.4 * mild);
  }

  if (coq > 0 && out.scold < 1) { out.coquette = coq; out.cold = 0; }

  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;

  return out;
}

/** 天气描述 → 'rain' | 'clear' | 'cold' | 'hot' | 'gloom' | ''。 */
export function weatherKind(x) {
  const s = String(x ?? '');

  if (/rain|storm|snow|drizzle|雨|雷|雪/i.test(s)) return 'rain';
  if (/cold|freez|冷|寒|降温|霜|冰/i.test(s)) return 'cold';
  if (/hot|热|高温|闷|炎/i.test(s)) return 'hot';
  if (/clear|sun|晴/i.test(s)) return 'clear';
  if (/cloud|overcast|fog|haze|阴|云|雾|霾/i.test(s)) return 'gloom';

  return '';
}

// ── 昼夜项 ──────────────────────────────────────────────────────────────────
const localHour = (ms, c) => ((((ms + c.utcOffsetMin * MIN) % DAY) + DAY) % DAY) / HOUR;

/** 从最近 14 天的入睡 / 起床记录学睡眠中点（圆周平均）；不够就用默认。 */
export function midSleepHour(sleepLog, now, cfg) {
  const c = cfgOf(cfg);
  const s = c.sleepy;
  const mids = (sleepLog || [])
    .filter((e) => e && e.wake > e.sleep && now - e.wake <= s.learnDays * DAY && now >= e.wake)
    .filter((e) => (e.wake - e.sleep) >= s.mainSleepMinH * HOUR && (e.wake - e.sleep) <= s.mainSleepMaxH * HOUR)
    .map((e) => localHour(e.sleep + (e.wake - e.sleep) / 2, c));

  if (mids.length < s.minLearnNights) return { hour: s.defaultMidSleepHour, learned: false, nights: mids.length };

  let x = 0;
  let y = 0;

  for (const h of mids) { x += Math.cos((2 * Math.PI * h) / 24); y += Math.sin((2 * Math.PI * h) / 24); }

  const hour = ((Math.atan2(y, x) * 24) / (2 * Math.PI) + 24) % 24;

  return { hour, learned: true, nights: mids.length };
}

const smooth = (x) => { const t = clamp01(x); return t * t * (3 - 2 * t); };

/** 日出日落项：白天 −amp，夜里 +amp，日出 / 日落前后 rampMin 分钟平滑过渡。sun = { rise, set }（本地钟点）。 */
export function sunTerm(now, sun, cfg) {
  const c = cfgOf(cfg);

  if (!sun || !Number.isFinite(sun.rise) || !Number.isFinite(sun.set)) return 0;

  const h = localHour(now, c);
  const ramp = Math.max(0.05, c.sun.rampMin / 60);
  const day = smooth((h - sun.rise) / ramp + 0.5) * smooth((sun.set - h) / ramp + 0.5);

  return c.sun.amp * (1 - 2 * day);
}

/** 昼夜项：睡眠中点 +amp，相差 12 小时 −amp；有日出日落时再叠一层（夜里更困、白天更精神）。 */
export function circadian(now, sleepLog, cfg, sun = null) {
  const c = cfgOf(cfg);
  const mid = midSleepHour(sleepLog, now, c).hour;

  return c.sleepy.circadianAmp * Math.cos((2 * Math.PI * (localHour(now, c) - mid)) / 24) + sunTerm(now, sun, c);
}

// ── 状态 ────────────────────────────────────────────────────────────────────
const freshPeer = () => ({ lastContact: 0, lastRelief: 0, lastSent: 0, unanswered: 0, awaitSince: 0 });

const freshH = (c) => ({
  sleepPressure: c.sleepy.base,
  longingOwner: c.longing.base,
  longingSister: c.longing.base,
  curiositySlow: c.curiosity.base,
  curiosityImpulse: 0,
  stress: c.stress.base,
  satisfaction: c.satisfaction.base,
  alert: c.alert.base,
  boredom: c.boredom.base,
  createUrge: c.createUrge.base,
  pride: c.pride.base,
  grievance: c.grievance.base,
  security: c.security.home,
});

/**
 * 新状态。第二个参数可以是性格名字符串（'fish' | 'sister'），也可以是
 * { now: 起点时间, asleep: 起点是不是睡着, sleepHistory: [{sleep, wake}] 真实毫秒, persona: 'fish' | 'sister' }。
 */
export function createState(cfg, arg = {}) {
  const c = cfgOf(cfg);
  const o = typeof arg === 'string' ? { persona: arg } : (arg || {});
  const { now = Date.now(), asleep = false, sleepHistory = [], persona = 'default' } = o;

  return {
    v: 1,
    schema: SCHEMA,
    persona: c.personas[persona] ? persona : 'default',
    t: now,
    asleep: Boolean(asleep),
    sleepSince: asleep ? now : 0,
    h: freshH(c),
    slow: { secBase: c.security.home }, // 安全感的慢变基线
    moodNeg: 0,
    moodPos: 0,
    buzz: 0,
    routine: 0, // 重复感 0～1
    engage: 0, // 2026-10-29 来回互动 / 刚在写东西的热度 0～1（专注的输入，会衰减；老状态文件没有，当 0）
    weather: '',
    sun: null, // { rise, set } 本地钟点
    lastNovelty: now,
    hab: {}, // 适应：各类事件最近发生的「次数」（会衰减）
    peers: { owner: freshPeer(), sister: freshPeer() },
    lastGroupSent: 0,
    lastExplored: 0,
    last: {}, // 各行为上次真的做了的时间
    sleepLog: (sleepHistory || []).filter((e) => e && e.wake > e.sleep).map((e) => ({ sleep: +e.sleep, wake: +e.wake })).slice(-60),
    impulses: [], // 最近一小时的冲击 [{k, at, a}]，用来算每小时上限
  };
}

/**
 * 把老状态文件（第一期，没有新字段）补齐成 schema 2。就地修改并返回；缺的用默认值，已有的不动。
 * persona：老状态没记性格时用这个。
 */
export function upgradeState(st, cfg, persona) {
  const c = cfgOf(cfg);

  if (st.schema === SCHEMA && st.persona) return st;

  const fresh = freshH(c);
  st.v = 1;
  st.schema = SCHEMA;
  st.persona = st.persona || (persona && c.personas[persona] ? persona : 'default');
  st.h = st.h || {};

  for (const [k, d] of Object.entries(fresh)) if (!Number.isFinite(st.h[k])) st.h[k] = d;

  st.slow = { secBase: c.security.home, ...st.slow };
  st.moodNeg = num(st.moodNeg);
  st.moodPos = num(st.moodPos);
  st.buzz = num(st.buzz);
  st.routine = num(st.routine);
  st.engage = num(st.engage);
  st.weather = st.weather || '';
  st.sun = st.sun || null;
  st.lastNovelty = num(st.lastNovelty, st.t);
  st.hab = st.hab || {};
  st.peers = st.peers || {};

  for (const p of ['owner', 'sister']) st.peers[p] = { ...freshPeer(), ...st.peers[p] };

  st.lastGroupSent = num(st.lastGroupSent);
  st.lastExplored = num(st.lastExplored);
  st.last = st.last || {};
  st.sleepLog = st.sleepLog || [];
  st.impulses = st.impulses || [];

  return st;
}

/** 读状态前保证是 schema 2（老的拷一份补齐，不改传进来的）。 */
const ensure = (state, c) => (state.schema === SCHEMA && state.persona ? state : upgradeState(structuredClone(state), c));

/** 推导出来给人看 / 给发生率用的水平（都在 0～1）。 */
export function levels(state, cfg) {
  const c = cfgOf(cfg);
  const st = ensure(state, c);
  const {h} = st;
  const sleepy = clamp01(h.sleepPressure + circadian(st.t, st.sleepLog, c, st.sun));

  return {
    sleepy,
    longingOwner: clamp01(h.longingOwner),
    longingSister: clamp01(h.longingSister),
    curiosity: clamp01(h.curiositySlow + h.curiosityImpulse),
    curiositySlow: clamp01(h.curiositySlow),
    curiosityImpulse: clamp01(h.curiosityImpulse),
    stress: clamp01(h.stress),
    satisfaction: c.satisfaction.enabled ? clamp01(h.satisfaction) : c.satisfaction.base,
    alert: c.alert.enabled ? clamp01(h.alert) : c.alert.base,
    buzz: clamp01(st.buzz),
    boredom: clamp01(h.boredom),
    createUrge: clamp01(h.createUrge),
    pride: clamp01(h.pride),
    grievance: clamp01(h.grievance),
    security: clamp01(h.security),
    securityBase: clamp01(st.slow.secBase),
    guard: guardOf(st, c),
    focus: focusOf(st, c, true),
    driveOwner: driveOf(h.longingOwner, c),
    driveSister: driveOf(h.longingSister, c),
  };
}

// ── 2026-10-29 戒备 / 专注 / 凸驱力：都由已有激素推出来，不另存 ──
/** 戒备（面子 / 嘴硬）：委屈 + 安全感偏低 + 压力 的组合 × 性格。0～1。 */
function guardOf(st, c) {
  const g = c.guard;
  const {h} = st;
  const P = c.personas[st.persona] || c.personas.default || {};
  const mult = Number.isFinite(P.gain?.guard) ? P.gain.guard : (Number.isFinite(P.gain?.all) ? P.gain.all : 1);
  const raw = g.grievance * Math.max(0, h.grievance - c.grievance.base)
    + g.securityLow * Math.max(0, g.securityRef - h.security)
    + g.stress * Math.max(0, h.stress - c.stress.base);

  return clamp01(raw * mult);
}

/** 专注（沉浸）：警觉 + 好奇冲击部分 + 来回互动 / 刚在写东西的热度。withAlert=false 时不含警觉（群里发言用，被叫要正常回）。0～1。 */
function focusOf(st, c, withAlert = true) {
  const f = c.focus;
  const {h} = st;
  const a = withAlert && c.alert.enabled ? f.alert * Math.max(0, h.alert - c.alert.base) : 0;

  return clamp01(a + f.curiosityImpulse * h.curiosityImpulse + f.engage * num(st.engage));
}

/** 想念的凸驱力：离设定点越远越陡（稳态驱力）。0～1。 */
function driveOf(longing, c) {
  const d = c.drive;

  return clamp01((longing - d.setpoint) / Math.max(1e-6, 1 - d.setpoint)) ** d.exponent;
}

// ── 性格、互相影响、适应 ────────────────────────────────────────────────────
function personaOf(st, c) {
  const p = c.personas[st.persona] || c.personas.default || {};
  const pick = (tbl, k) => {
    const v = tbl?.[k];

    if (Number.isFinite(v)) return v;

    return Number.isFinite(tbl?.all) ? tbl.all : 1;
  };

  return {
    gain: (k) => pick(p.gain, k), hl: (k) => pick(p.halfLife, k), rate: (k) => pick(p.rate, k),
    sense: (k) => (Number.isFinite(p.sense?.[k]) ? p.sense[k] : 1),
    src: (who) => (Number.isFinite(p.source?.[who]) ? p.source[who] : 1),
    misc: (k) => (Number.isFinite(p.misc?.[k]) ? p.misc[k] : 1)
  };
}

/** 各激素偏离自己基线的量（互相影响用）。第二期的两项没启用就当没偏离。 */
function devs(st, c) {
  const {h} = st;

  return {
    stress: h.stress - c.stress.base,
    satisfaction: c.satisfaction.enabled ? h.satisfaction - c.satisfaction.base : 0,
    alert: c.alert.enabled ? h.alert - c.alert.base : 0,
    boredom: h.boredom - c.boredom.base,
    curiositySlow: h.curiositySlow - c.curiosity.base,
    curiosityImpulse: h.curiosityImpulse,
    createUrge: h.createUrge - c.createUrge.base,
    pride: h.pride - c.pride.base,
    grievance: h.grievance - c.grievance.base,
    security: h.security - st.slow.secBase,
    longingOwner: h.longingOwner - c.longing.base,
    longingSister: h.longingSister - c.longing.base,
  };
}

function gainMult(D, key, c) {
  const row = c.couple.enabled ? c.couple.gain[key] : null;

  if (!row) return 1;

  let m = 1;

  for (const [src, k] of Object.entries(row)) m += k * (D[src] || 0);

  return clampTo(m, c.couple.minMult, c.couple.maxMult);
}

function driftOf(D, key, c) {
  const row = c.couple.enabled ? c.couple.drift[key] : null;

  if (!row) return 0;

  let s = 0;

  for (const [src, k] of Object.entries(row)) s += k * (D[src] || 0);

  return s;
}

/** 适应：返回这一次的冲击倍数（×decay^最近次数，最低 floor），并记一次。 */
function habit(st, key, c) {
  if (!c.habit.enabled) return 1;

  const n = st.hab[key] || 0;
  st.hab[key] = n + 1;

  return Math.max(c.habit.floor, c.habit.decay ** n);
}

const weatherOf = (st, c) => ({ boredomRate: 0, securityShift: 0, ...c.weather[st.weather] });

/** 她发了没人回、等了多久 → 0～1（安全感的落点往下沉多少）。睡着时不算。 */
function neglectOf(st, to, c) {
  const p = st.peers.owner;

  if (!p.awaitSince || st.asleep) return 0;

  const n = c.security.neglect;

  return clamp01((to - p.awaitSince - n.graceMin * MIN) / (n.rampH * HOUR));
}

/** 连续部分的一小段：从 state.t 推进到 to（这段时间里睡 / 醒不变）。 */
function advanceOnce(st, to, c) {
  const dtMs = to - st.t;

  if (!(dtMs > 0)) return;

  const dtMin = dtMs / MIN;
  const dtH = dtMs / HOUR;
  const awakeH = st.asleep ? 0 : dtH;
  const {h} = st;
  const P = personaOf(st, c);
  const D = devs(st, c);
  const G = (k) => gainMult(D, k, c);
  const R = (k) => driftOf(D, k, c);
  const hl = (k, minutes) => minutes * P.hl(k);
  const W = weatherOf(st, c);

  // 困：醒着线性涨；睡着 2 小时半衰期回落到基线
  if (st.asleep) h.sleepPressure = relax(h.sleepPressure, c.sleepy.base, dtMin, c.sleepy.asleepHalfLifeMin);
  else h.sleepPressure += c.sleepy.awakePerHour * dtH;

  // 想念：对方开口后 graceMin 内不涨，之后每小时 +perHour（性格、满足、委屈会改涨速）
  for (const [k, peer] of [['longingOwner', st.peers.owner], ['longingSister', st.peers.sister]]) {
    const growFrom = Math.max(st.t, (peer.lastContact || 0) + c.longing.graceMin * P.misc('longingGrace') * MIN);
    const growH = Math.max(0, to - growFrom) / HOUR;
    h[k] += c.longing.perHour * P.rate('longing') * G(k) * growH * (st.asleep ? c.longing.asleepFactor : 1) + R(k) * awakeH;
  }

  // 好奇：缓升部分醒着慢慢涨（压力压住，无聊推高）；冲击部分 45 分钟半衰期回到 0
  if (!st.asleep) h.curiositySlow += (c.curiosity.boredPerHour * P.rate('curiosity') * G('curiositySlow') + R('curiositySlow')) * dtH;

  h.curiosityImpulse = relax(h.curiosityImpulse, 0, dtMin, hl('curiosityImpulse', c.curiosity.impulseHalfLifeMin));

  // 无聊：醒着涨（刚见过新东西慢、久没有快、重复的事多快、下雨快）；睡着回落
  if (st.asleep) h.boredom = relax(h.boredom, c.boredom.base, dtMin, hl('boredom', c.boredom.asleepHalfLifeMin));
  else {
    const ramp = c.boredom.noveltyRamp;
    const since = clamp01((st.t - (st.lastNovelty || st.t)) / HOUR / ramp.hours);
    const mult = (ramp.minMult + (ramp.maxMult - ramp.minMult) * since) * (1 + c.boredom.routineGain * clamp01(st.routine)) * Math.max(0, 1 + W.boredomRate);
    h.boredom += (c.boredom.perHour * P.rate('boredom') * mult + R('boredom')) * dtH;
  }

  st.routine = relax(st.routine, 0, dtMin, c.boredom.routineHalfLifeMin);
  st.engage = clamp01(relax(num(st.engage), 0, dtMin, c.focus.engageHalfLifeMin));

  // 创作冲动：醒着自己冒一点（无聊推高、压力压住），往「落点」回落；心情起伏大把落点抬高
  {
    let rise = (c.createUrge.perHour * P.rate('createUrge') * dtH + R('createUrge') * dtH) * (st.asleep ? 0 : 1);

    if (rise > 0) rise *= G('createUrge');

    h.createUrge += rise;
    const target = c.createUrge.base + c.createUrge.moodGain * Math.max(clamp01(st.moodPos), clamp01(st.moodNeg));
    h.createUrge = relax(h.createUrge, target, dtMin, hl('createUrge', c.createUrge.halfLifeMin));
  }

  // 压力：回落到（心情抬高过的）基线
  h.stress = relax(h.stress, c.stress.base + c.stress.moodBaseGain * clamp01(st.moodNeg), dtMin, hl('stress', c.stress.halfLifeMin));
  h.satisfaction = relax(h.satisfaction, c.satisfaction.base + c.satisfaction.moodGain * clamp01(st.moodPos), dtMin, hl('satisfaction', c.satisfaction.halfLifeMin));
  h.alert = relax(h.alert, c.alert.base, dtMin, hl('alert', c.alert.halfLifeMin));
  h.pride = relax(h.pride, c.pride.base, dtMin, hl('pride', c.pride.halfLifeMin));
  h.grievance = relax(h.grievance, c.grievance.base, dtMin, hl('grievance', c.grievance.halfLifeMin));
  st.buzz = relax(st.buzz, 0, dtMin, c.buzz.halfLifeMin);

  // 被在乎：短期部分往「落点」回落（基线 + 天气偏移 − 等不到回复时往下沉）；基线自己极慢地跟着走，有上下限
  {
    const sec = c.security;
    const target = st.slow.secBase + W.securityShift - sec.neglect.drop * neglectOf(st, to, c);
    h.security = relax(h.security, target, dtMin, hl('security', sec.halfLifeMin));
    // 基线跟着「去掉天气偏移以后的安全感」走：被冷落基线慢慢降，被好好对待慢慢升；很久没事再极慢地往老家靠
    const ema = 1 - 2 ** (-dtH / (sec.baseEmaHalfLifeH * P.hl('securityBase')));
    let base = st.slow.secBase + (h.security - W.securityShift - st.slow.secBase) * ema;
    base = relax(base, sec.home, dtMin, sec.homeHalfLifeDays * 1440 * P.hl('securityBase'));
    st.slow.secBase = clampTo(base, sec.min, sec.max);
  }

  // 适应：次数随时间衰减（久不发生就恢复）
  for (const k of Object.keys(st.hab)) {
    st.hab[k] = relax(st.hab[k], 0, dtMin, hl('habit', c.habit.halfLifeMin));

    if (st.hab[k] < 0.01) delete st.hab[k];
  }

  for (const k of Object.keys(h)) h[k] = clamp01(h[k]);

  st.t = to;
}

/** 推进到 to；太长就拆成小段，免得互相影响按开头的状态一口气算错。 */
function advance(st, to, c) {
  const total = to - st.t;

  if (!(total > 0)) return;

  const n = Math.min(c.maxSubsteps, Math.max(1, Math.ceil(total / (c.substepMin * MIN))));
  const seg = total / n;

  for (let i = 1; i <= n; i += 1) advanceOnce(st, i === n ? to : st.t + seg, c);
}

/**
 * 一次冲击：先乘性格（起伏大小），正向的再乘「互相影响」，再受单次上限 + 每小时同方向累计上限，截断到 [0,1]。
 * 返回实际加上的量。适应倍数由调用方先乘进 amount。
 */
function kick(st, key, amount, c) {
  if (!amount) return 0;

  const P = personaOf(st, c);
  let amt = amount * P.gain(key);

  if (amt > 0) amt *= gainMult(devs(st, c), key, c);

  const sign = Math.sign(amt);

  if (!sign) return 0;

  let a = sign * Math.min(Math.abs(amt), c.impulse.maxSingle);
  st.impulses = st.impulses.filter((x) => st.t - x.at < HOUR);
  const used = st.impulses.filter((x) => x.k === key && Math.sign(x.a) === sign).reduce((s, x) => s + Math.abs(x.a), 0);
  const room = Math.max(0, c.impulse.maxPerHour - used);
  a = sign * Math.min(Math.abs(a), room);

  if (!a) return 0;

  const before = st.h[key];
  st.h[key] = clamp01(before + a);
  st.impulses.push({ k: key, at: st.t, a });

  return st.h[key] - before;
}

/**
 * 她给某人发了消息：总是进冷却；「没回条数」只在这是她新起的一轮时 +1。
 * 不算新一轮：对方在她上次发之后开过口（这是在回话，ev.reply 也可以直接说明）；离上次发不到 sendBurstMin 分钟（同一轮分几条发）。
 */
function sent(peer, ev, c) {
  const now = ev.at;
  const replying = ev.reply === true || (peer.lastContact > 0 && peer.lastContact >= (peer.lastSent || 0));
  const sameBurst = peer.lastSent > 0 && now - peer.lastSent < c.longing.sendBurstMin * MIN;

  if (!replying && !sameBurst) {
    peer.unanswered += 1;

    if (!peer.awaitSince) peer.awaitSince = now; // 从这一轮开始等
  }

  peer.lastSent = now;
}

const sunHour = (v, c) => {
  const x = Number(v);

  if (!Number.isFinite(x)) return null;

  return x > 48 ? localHour(x, c) : ((x % 24) + 24) % 24;
};

function applyEvent(st, ev, c) {
  const E = EVENTS;
  const interests = ev.interests ? interestList(ev.interests) : [];
  const stamp = (name) => { st.last[name] = st.t; };

  // 别吵 / 在忙：压力 +，也有一点委屈
  const hushCheck = (text, ap) => {
    if (isHush(text, c) || ap?.hush) {
      kick(st, 'stress', c.stress.hushed * habit(st, 'hush', c), c);
      kick(st, 'grievance', c.grievance.hush, c);
    }
  };

  // 一类「察觉」的冲击：强度 × 来源分量 × 适应倍数
  const feel = (name, strength, who = 'owner', habKey = name) => {
    const s = clamp01(+strength);

    if (!(s > 0)) return;

    const table = c.appraisal.effects[name];

    if (!table) return;

    const Pf = personaOf(st, c);
    const m = s * (c.appraisal.source[who] ?? 1) * Pf.src(who) * habit(st, habKey, c) * Pf.sense(name); // sense：妹妹对冷落更敏感

    for (const [k, a] of Object.entries(table)) kick(st, k, a * m, c);
  };

  const feelAll = (ap, who) => {
    if (!ap) return;

    feel('praise', ap.praise, who);
    feel('scold', ap.scold, who);
    feel('cold', ap.cold, who);
    feel('comfort', ap.comfort, who);
    feel('interest', ap.interest, who);
    feel('coquette', ap.coquette, who);
  };

  const apOf = (ev2) => ev2.appraisal || (ev2.text ? appraise(ev2.text, interests, c) : null);

  const contact = (peerName, longKey) => {
    const peer = st.peers[peerName];

    if (!peer.lastRelief || st.t - peer.lastRelief >= c.longing.contactDedupMin * MIN) {
      kick(st, longKey, c.longing.contactRelief, c);
      kick(st, 'boredom', c.boredom.ownerChat, c);
      peer.lastRelief = st.t;
    }

    peer.lastContact = st.t;
    peer.unanswered = 0;
    peer.awaitSince = 0;
  };

  // 来回互动：对方刚回过 / 她刚发过（chatWindowMin 之内），热度 +chatKick；刚写完东西也升。只影响专注，不动别的激素
  const bumpEngage = (a) => { st.engage = clamp01(num(st.engage) + a); };
  const rally = (peer, key) => {
    if (peer[key] > 0 && st.t - peer[key] < c.focus.chatWindowMin * MIN) bumpEngage(c.focus.chatKick);
  };

  const strengthOf = (ev2, d = 1) => (Number.isFinite(+ev2.strength) ? clamp01(+ev2.strength) : d);
  const whoOf = (ev2) => (['owner', 'sister', 'group'].includes(ev2.from) ? ev2.from : 'owner');

  switch (ev.type) {
    case E.SLEEP: {
      if (!st.asleep) { st.asleep = true; st.sleepSince = st.t; }

      break;
    }

    case E.WAKE: {
      if (st.asleep) {
        if (st.sleepSince && st.t > st.sleepSince) {
          st.sleepLog.push({ sleep: st.sleepSince, wake: st.t });
          st.sleepLog = st.sleepLog.filter((e) => st.t - e.wake <= (c.sleepy.learnDays + 1) * DAY).slice(-60);

          // 睡不满主睡眠的下限 = 打了个盹（记冷却，睡眠压力不用另外降，睡着时已经在回落）
          if (st.t - st.sleepSince < c.sleepy.mainSleepMinH * HOUR) stamp('nap');
        }

        st.asleep = false;
        st.sleepSince = 0;
      }

      break;
    }

    case E.MSG_FROM_OWNER: {
      const peer = st.peers.owner;
      const fresh = !peer.lastRelief || st.t - peer.lastRelief >= c.longing.contactDedupMin * MIN;
      // 老大回她用了多久：调用方传 replyDelayMs；不传就按她上次发的时间推（她发了还没人回过）
      const delay = ev.replyDelayMs !== undefined && ev.replyDelayMs !== null && Number.isFinite(+ev.replyDelayMs) && +ev.replyDelayMs >= 0
        ? +ev.replyDelayMs
        : (peer.lastSent > 0 && peer.lastSent > peer.lastContact ? Math.max(0, st.t - peer.lastSent) : null);
      const initiated = typeof ev.initiated === 'boolean'
        ? ev.initiated
        : (delay === null && (!peer.lastSent || st.t - peer.lastSent >= c.security.initiatedAfterMin * MIN));
      const sec = c.security;
      const ap = apOf(ev);

      rally(peer, 'lastSent'); // 她刚发过、老大回了 = 有来有回
      contact('owner', 'longingOwner');

      if (c.satisfaction.enabled) kick(st, 'satisfaction', c.satisfaction.fromOwner, c);

      if (delay !== null) { // 回她的话：回得快、回得慢
        if (delay <= sec.fastReplyMin * MIN) {
          kick(st, 'security', sec.fastReply * habit(st, 'replyFast', c), c);
          if (c.satisfaction.enabled) kick(st, 'satisfaction', 0.03, c);
        } else if (delay >= sec.slowReplyH * HOUR) kick(st, 'security', sec.slowReply, c);
        else kick(st, 'security', sec.normalReply, c);
      } else if (initiated && fresh) { // 她没发，老大主动来找
        kick(st, 'security', sec.initiated * habit(st, 'initiated', c), c);
        if (c.satisfaction.enabled) kick(st, 'satisfaction', 0.04, c);
      }

      feelAll(ap, 'owner');
      hushCheck(ev.text, ap);
      break;
    }

    case E.MSG_FROM_SISTER: {
      const ap = apOf(ev);
      rally(st.peers.sister, 'lastSent');
      contact('sister', 'longingSister');
      feelAll(ap, 'sister');
      hushCheck(ev.text, ap);
      break;
    }

    case E.SENT_TO_OWNER: { // 防自激：她自己发的不让想念升
      rally(st.peers.owner, 'lastContact'); // 对方刚来过话、她在回 = 有来有回
      sent(st.peers.owner, ev, c);
      break;
    }

    case E.SENT_TO_SISTER: {
      rally(st.peers.sister, 'lastContact');
      sent(st.peers.sister, ev, c);
      break;
    }

    case E.GROUP_MSG: {
      const n = Number.isFinite(+ev.novelty) ? clamp01(+ev.novelty) : c.buzz.defaultNovelty;
      st.buzz = clamp01(st.buzz + c.buzz.gain * n);

      if (n < c.boredom.routineBelow) st.routine = clamp01(st.routine + c.boredom.routinePerMsg); // 又是老一套

      if (ev.toMe) {
        const ap = apOf(ev);
        feelAll(ap, 'group');
        hushCheck(ev.text, ap);
      }

      break;
    }

    case E.SENT_GROUP: {
      st.lastGroupSent = st.t;
      stamp('groupChat');
      break;
    }

    case E.MENTIONED: {
      if (c.alert.enabled) kick(st, 'alert', c.alert.mentioned * habit(st, 'mention', c), c);

      break;
    }

    case E.NOVELTY: {
      const k = strengthOf(ev);
      const m = Number.isFinite(+ev.interestMatch) && ev.interestMatch !== null
        ? clamp01(+ev.interestMatch)
        : (ev.text && interests.length > 0 ? interestMatch(ev.text, interests) : 0.5);
      const w = c.curiosity.noveltyWeight.min + (c.curiosity.noveltyWeight.max - c.curiosity.noveltyWeight.min) * m;
      const hab = habit(st, 'novelty', c);
      kick(st, 'curiosityImpulse', c.curiosity.novelty * k * w * hab, c);
      kick(st, 'curiositySlow', c.curiosity.noveltyEasesBoredom * k * hab, c);
      kick(st, 'boredom', c.boredom.novelty * k * w * hab, c);

      if (m > 0.5) kick(st, 'createUrge', c.createUrge.noveltyMatch * (m - 0.5) * 2 * k * hab, c);

      if (k >= 0.2) st.lastNovelty = st.t;

      break;
    }

    case E.EXPLORED: {
      st.lastExplored = st.t;
      stamp('explore');
      st.lastNovelty = st.t;
      kick(st, 'curiositySlow', c.curiosity.exploredSlow, c);
      kick(st, 'curiosityImpulse', c.curiosity.exploredImpulse, c);
      kick(st, 'boredom', c.boredom.explored, c);
      break;
    }

    case E.TOOL_FAIL:
    case E.SEND_FAIL: {
      kick(st, 'stress', c.stress.fail * habit(st, 'fail', c), c);
      break;
    }

    case E.HUSHED: {
      kick(st, 'stress', c.stress.hushed * habit(st, 'hush', c), c);
      kick(st, 'grievance', c.grievance.hush, c);
      break;
    }

    case E.MOOD: {
      st.moodNeg = clamp01(+ev.negative || 0);
      st.moodPos = clamp01(+ev.positive || 0);
      break;
    }

    case E.PLEASANT: {
      if (c.satisfaction.enabled) kick(st, 'satisfaction', c.satisfaction.pleasant * habit(st, 'pleasant', c), c);

      break;
    }

    case E.PRAISED: {
      feel('praise', strengthOf(ev), whoOf(ev));

      if (ev.about === 'work') feel('recognized', strengthOf(ev), whoOf(ev), 'recognized'); // 被认可

      break;
    }

    case E.SCOLDED: {
      feel('scold', strengthOf(ev), whoOf(ev));
      break;
    }

    case E.COMFORTED: {
      feel('comfort', strengthOf(ev), whoOf(ev));
      break;
    }

    case E.COLD: {
      feel('cold', strengthOf(ev), whoOf(ev));
      break;
    }

    case E.TOPIC: {
      feel('interest', Number.isFinite(+ev.match) ? +ev.match : strengthOf(ev), whoOf(ev));
      break;
    }

    case E.INTERRUPTED: {
      kick(st, 'grievance', c.grievance.interrupted * strengthOf(ev) * habit(st, 'interrupted', c), c);
      kick(st, 'stress', 0.04 * strengthOf(ev), c);
      break;
    }

    case E.MISUNDERSTOOD: {
      kick(st, 'grievance', c.grievance.misunderstood * strengthOf(ev) * habit(st, 'misunderstood', c), c);
      kick(st, 'security', -0.04 * strengthOf(ev), c);
      break;
    }

    case E.CREATED: {
      const kind = c.created[ev.kind] ? ev.kind : 'tidbit';
      const hab = habit(st, `created-${kind}`, c); // 一直在写同一种，成就感会慢慢淡

      for (const [k, a] of Object.entries(c.created[kind])) kick(st, k, k === 'pride' ? a * hab : a, c);

      bumpEngage(c.focus.created[kind] ?? 0); // 刚在写东西，人是进去了的

      if (kind === 'novel') stamp('novel');
      else if (kind === 'work') stamp('post');
      else stamp('journal');

      break;
    }

    case E.POSTED: {
      stamp('post');
      kick(st, 'pride', c.pride.posted * habit(st, 'posted', c), c);
      kick(st, 'createUrge', -0.15, c);
      break;
    }

    case E.STICKER_SENT: {
      stamp('sticker');
      break;
    }

    case E.PEEKED: {
      stamp('peekOwner');
      kick(st, 'longingOwner', c.longing.peekRelief, c);
      kick(st, 'boredom', c.boredom.peeked, c);
      break;
    }

    case E.NAPPED: {
      stamp('nap');
      kick(st, 'sleepPressure', c.sleepy.napRelief, c);
      kick(st, 'boredom', c.boredom.napped, c);
      break;
    }

    case E.MOVED: {
      kick(st, 'createUrge', c.createUrge.moved * strengthOf(ev) * habit(st, 'moved', c), c);
      break;
    }

    case E.READ_GOOD: {
      kick(st, 'createUrge', c.createUrge.readGood * strengthOf(ev) * habit(st, 'readGood', c), c);
      break;
    }

    case E.REPEATED: {
      st.routine = clamp01(st.routine + 0.1 * strengthOf(ev));
      break;
    }

    case E.WEATHER: {
      let kind = weatherKind(ev.kind ?? ev.text ?? ev.condition);
      const t = Number(ev.tempC);

      if ((!kind || kind === 'clear' || kind === 'gloom') && Number.isFinite(t)) {
        if (t <= c.weather.coldBelowC) kind = 'cold';
        else if (t >= c.weather.hotAboveC) kind = 'hot';
      }

      st.weather = kind;
      break;
    }

    case E.SUN: {
      const rise = sunHour(ev.sunrise, c);
      const set = sunHour(ev.sunset, c);
      st.sun = rise !== null && set !== null && rise < set ? { rise, set } : st.sun;
      break;
    }

    default: {
      break;
    } // 不认识的事件不管
  }
}

/**
 * 推进一步：把 events（按 at 排序，不填 at 就当 now）依次放进去，最后推进到 now。
 * 返回新状态，不改传进来的 state。早于 state.t 的事件按 state.t 算，晚于 now 的按 now 算。
 * 老状态（第一期）会先补齐。
 */
export function step(state, { now = Date.now(), events = [] } = {}, cfg) {
  const c = cfgOf(cfg);
  const st = upgradeState(structuredClone(state), c);
  const end = Math.max(st.t, now);
  const evs = (events || [])
    .filter((e) => e && e.type)
    .map((e, i) => ({ ...e, at: Math.min(end, Math.max(st.t, Number.isFinite(+e.at) ? +e.at : end)), i }))
    .sort((a, b) => a.at - b.at || a.i - b.i);

  for (const ev of evs) {
    advance(st, ev.at, c);
    applyEvent(st, ev, c);
  }

  advance(st, end, c);
  st.impulses = st.impulses.filter((x) => st.t - x.at < HOUR);

  return st;
}

// ── 行为发生率 ──────────────────────────────────────────────────────────────
function peerFactor(peer, hz, now, override = {}) {
  const lastSent = Math.max(peer.lastSent || 0, override.lastSent || 0);
  const unanswered = (peer.unanswered || 0) + (override.unanswered || 0);

  if (lastSent && now - lastSent < hz.cooldownMin * MIN) return { f: 0, why: 'cooldown' };
  if (unanswered >= hz.blockAt && lastSent && now - lastSent < hz.blockMaxH * HOUR) return { f: hz.blockedFactor, why: 'unanswered' };

  return { f: hz.unansweredBase ** unanswered, why: unanswered ? 'unanswered-soft' : '' };
}

const cooldownFactor = (last, min, now) => (last && now - last < min * MIN ? 0 : 1);

/** 某个行为上次真的做是什么时候（兼容第一期的 lastGroupSent / lastExplored）。 */
const lastDid = (st, name) => Math.max(st.last?.[name] || 0, name === 'groupChat' ? st.lastGroupSent || 0 : 0, name === 'explore' ? st.lastExplored || 0 : 0);

/**
 * 各行为的发生率和这一段时间里的触发概率 p = 1 − e^(−λΔt)。
 * ctx：{ dtMin = 1, groupTopic?（0～1，覆盖内部的群新话题程度）,
 *        virtual?: { ownerPing: {lastSent, unanswered}, sisterPing: {...}, groupChat: {last}, explore: {last}, journal: {last}, …… } }
 * virtual 给影子模式用：「本来会发」的那几次也算冷却，免得同一个冲动一分钟算一次。
 * 睡着时全部为 0（她自己约好的醒 / 睡由调用方优先处理，这里只管没约定时的自发冲动）。
 * 2026-10-29 借鉴积温后每个行为的发生率 = (基础项 × 戒备压低 × 专注压低 + 想念凸驱力加项) × 冷却 / 没回的限制：
 *   基础项 = λ0 × e^(Σ w×偏离)；戒备只压找老大 / 找姐妹；专注压「切换到别的主动行为」；
 *   凸驱力加项只给找老大 / 找姐妹，离设定点越远越陡、不被戒备和专注压住，另有 driveCooldownMin 的长冷却，睡着为 0。
 * 返回的 why：cooldown / unanswered / unanswered-soft（原有）、drive（驱力加项占了大头）、guard（被戒备压住大半）、focus（被专注压住大半）。
 * 每个行为都有冷却；发生率 = λ0 × e^(Σ w×偏离)，指数部分最多 hazardMaxLog（防几项叠加后刷屏）。
 */
export function hazards(state, ctx = {}, cfg) {
  const c = cfgOf(cfg);
  const st = ensure(state, c);
  const dtMin = Number.isFinite(+ctx.dtMin) && +ctx.dtMin > 0 ? +ctx.dtMin : 1;
  const now = st.t;
  const L = levels(st, c);
  const buzz = Number.isFinite(+ctx.groupTopic) ? clamp01(+ctx.groupTopic) : L.buzz;
  const v = ctx.virtual || {};
  const out = {};
  const put = (name, lambda, why = '') => {
    const lam = st.asleep ? 0 : Math.max(0, lambda);
    out[name] = { lambda: lam, p: 1 - Math.exp(-lam * dtMin), why: st.asleep ? 'asleep' : why };
  };

  const dev = {
    sleepy: L.sleepy - c.sleepy.base,
    stress: L.stress,
    satisfaction: L.satisfaction - c.satisfaction.base,
    curiosityImpulse: L.curiosityImpulse,
    curiosity: L.curiosity - c.curiosity.base,
    curiositySlow: L.curiositySlow - c.curiosity.base,
    alert: L.alert - c.alert.base,
    buzz,
    boredom: L.boredom - c.boredom.base,
    createUrge: L.createUrge - c.createUrge.base,
    pride: L.pride - c.pride.base,
    grievance: L.grievance - c.grievance.base,
    security: L.security - c.security.home,
  };

  for (const name of BEHAVIORS) {
    const hz = c.hazards[name];

    if (!hz) { put(name, 0, 'off'); continue; }

    const longing = name === 'sisterPing' ? L.longingSister - c.longing.base : L.longingOwner - c.longing.base;
    let x = 0;

    for (const [k, wk] of Object.entries(hz.w || {})) x += wk * (k === 'longing' ? longing : (dev[k] ?? 0));

    x = Math.min(x, c.hazardMaxLog);
    let f = 1;
    let why = '';
    const ownPeer = name === 'ownerPing' ? st.peers.owner : name === 'sisterPing' ? st.peers.sister : null;

    if (name === 'ownerPing' || name === 'sisterPing') {
      const pf = peerFactor(name === 'ownerPing' ? st.peers.owner : st.peers.sister, hz, now, v[name]);
      f = pf.f;
      why = pf.why;
    } else {
      f = cooldownFactor(Math.max(lastDid(st, name), v[name]?.last || 0), hz.cooldownMin, now);
      why = f ? '' : 'cooldown';
    }

    if (f && hz.minSleepy !== undefined && L.sleepy < hz.minSleepy) { f = 0; why = 'not-sleepy'; }

    // 戒备（面子）：只压找人；专注：压切换到别的主动行为（群里发言用不含警觉的专注，被叫照常回）
    const guardF = hz.guard ? 1 - (1 - c.guard.minFactor) * smooth((L.guard - c.guard.onset) / Math.max(1e-6, c.guard.full - c.guard.onset)) : 1;
    const focusLv = hz.focusNoAlert ? focusOf(st, c, false) : L.focus;
    const focusF = hz.focusDamp ? Math.max(c.focus.minFactor, 1 - hz.focusDamp * focusLv) : 1;
    const base = hz.lambda0PerMin * Math.exp(x) * guardF * focusF;
    // 想念的凸驱力加项（保底开口）：长冷却（从上次真的发 / 本来会发算起）
    let driveLam = 0;

    if (hz.drive && ownPeer) {
      const lastSent = Math.max(ownPeer.lastSent || 0, v[name]?.lastSent || 0);
      const longLv = name === 'sisterPing' ? L.driveSister : L.driveOwner;

      if (!(lastSent && now - lastSent < c.drive.driveCooldownMin * MIN)) driveLam = c.drive.maxPerMin * longLv;
    }

    const total = (base + driveLam) * f;

    if (!why && total > 0) {
      if (driveLam > base) why = 'drive';
      else if (guardF < 0.5) why = 'guard';
      else if (focusF < 0.5) why = 'focus';
    }

    put(name, total, why);
  }

  return out;
}

/** 用随机数抽一次：哪些行为「本来会触发」。 */
export function roll(hz, rng) {
  return BEHAVIORS.filter((b) => hz[b] && hz[b].p > 0 && rng() < hz[b].p);
}

// ── 感受句 ──────────────────────────────────────────────────────────────────
/**
 * 只在明显偏离基线时出最多两句家常话；带滞后（超过 on 才说，降到 off 以下才不说）。
 * prev：上一次的返回值（或 null）。opts.sisterName：「姐姐」/「妹妹」。
 * 返回 { line, active, shown }。睡着时不说。不出现数字，不是命令，不提钱。
 */
export function feltLine(state, prev, cfg, { sisterName = '姐妹' } = {}) {
  const c = cfgOf(cfg);

  if (state.asleep) return { line: '', active: [], shown: [] };

  const L = levels(state, c);
  const was = new Set(prev?.active || []);
  const wasShown = new Set(prev?.shown || []);
  const keys = Object.keys(c.felt).filter((k) => k !== 'maxLines');
  const maxLonging = Math.max(L.longingOwner, L.longingSister);
  const value = (k) => {
    if (k === 'securityLow') return 1 - L.security;
    if (k === 'guard') return maxLonging >= (c.felt.guard?.minLonging ?? 0) ? L.guard : 0; // 心里没惦记谁时，「拉不下脸先开口」没头没尾，不说

    return L[k];
  };
  const active = [];

  for (const k of keys) {
    const f = c.felt[k];

    if (k === 'satisfaction' && !c.satisfaction.enabled) continue;
    if (k === 'alert' && !c.alert.enabled) continue;
    if (!f) continue;

    const lv = value(k);

    if (!Number.isFinite(lv)) continue;

    if (was.has(k) ? lv >= f.off : lv >= f.on) {
      active.push({ k, score: ((lv - f.off) / Math.max(1e-6, 1 - f.off) + (wasShown.has(k) ? 0.2 : 0)) * (f.w || 1) });
    }
  }

  active.sort((a, b) => b.score - a.score);
  const shown = active.slice(0, c.felt.maxLines).map((a) => a.k);
  const line = shown.map((k) => `${c.felt[k].text.replace('{sister}', sisterName)}。`).join('');

  return { line, active: active.map((a) => a.k), shown };
}

// ── 2026-10-29 老大：「困」提前从影子模式放出来（只放这一项），和睡到自然醒 ──────────────────────

/** 困明显偏高时的身体感受（几种说法轮着来；不出数字，不是命令）。 */
export const SLEEPY_PHRASES = Object.freeze(['困意上来了', '眼皮有点沉', '有点犯困了']);

/**
 * 只看「困」：明显偏高（felt.sleepy.on，带滞后 off）时给一句身体感受，其它激素仍是影子，不在这里说。
 * prev：上一次的返回值（用 active 做滞后）；pick：几种说法里选哪一种（调用方传个小整数，比如按钟点）。睡着时不说。
 * 返回 { line, active }。
 */
export function sleepyFeel(state, prev, cfg, { pick = 0 } = {}) {
  const c = cfgOf(cfg);

  if (!state || state.asleep) return { line: '', active: false };

  const lv = levels(state, c).sleepy;
  const f = c.felt.sleepy;
  const active = prev?.active ? lv >= f.off : lv >= f.on;

  if (!active) return { line: '', active: false };

  const i = Math.abs(Math.floor(num(pick, 0))) % SLEEPY_PHRASES.length;

  return { line: `${SLEEPY_PHRASES[i]}。`, active: true };
}

/**
 * 睡到自然醒：现在该醒了吗？
 * state：激素状态（睡着期间一直在推进，睡眠压力在回落）；sleptMs：已经睡了多久（毫秒）。
 * 返回 { wake, why }：why = 'min'（还没睡满最短）| 'max'（睡满最长）| 'rested'（压力回落、不在深夜段）| 'tired'（压力还高）| 'night'（还在深夜段）。
 * state 为空（激素没开）时用 fallbackH 小时。
 */
export function naturalWakeDue(state, sleptMs, cfg) {
  const c = cfgOf(cfg);
  const n = c.naturalWake;
  const slept = num(sleptMs, 0);

  if (slept < n.minH * HOUR) return { wake: false, why: 'min' };
  if (slept >= n.maxH * HOUR) return { wake: true, why: 'max' };
  if (!state) return slept >= n.fallbackH * HOUR ? { wake: true, why: 'rested' } : { wake: false, why: 'tired' };

  const st = ensure(state, c);
  const circ = circadian(st.t, st.sleepLog, c, st.sun);
  const threshold = c.sleepy.base + n.margin + n.dayEase * Math.max(0, -circ);

  if (st.h.sleepPressure > threshold) return { wake: false, why: 'tired' };
  if (circ > c.sleepy.circadianAmp * n.deepFrac) return { wake: false, why: 'night' };

  return { wake: true, why: 'rested' };
}
