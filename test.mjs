// 自测：不依赖 DSH 运行时，验证判定逻辑与流包装透传。
// 用法：node test.mjs

import { readFile } from 'node:fs/promises';
import {
  isPureDsmlFragment,
  chunkText,
  apply,
  looksLikeReasoningCopy,
  isInternalTagSoup,
  countStrayInternalClosers,
  dropStrayInternalClosers,
  hasDsmlTag,
  classifyFormat,
  parseLeakedCalls,
  lintToolCalls,
  TOOLCALL_RULES,
  StreamHoldback,
  scanBareTags,
  CALL_TAG_NAMES,
} from './index.js';

let pass = 0;
let fail = 0;

function check(name, cond) {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}`);
  }
}

// ── 判定规则 ──────────────────────────────────────────────
const REAL_FRAGMENT = '\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>';

check('真实残片命中', isPureDsmlFragment(REAL_FRAGMENT) === true);
check('带前导空格命中', isPureDsmlFragment('  \n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>\n') === true);
check('单个闭合标签命中', isPureDsmlFragment('</｜｜DSML｜｜ calls>') === true);

// 关键反例：正常对话里提到 DSML 不能误报
check('提到 DSML 不命中', isPureDsmlFragment('DSML 泄露有根本的解决办法吗？') === false);
check('普通正文不命中', isPureDsmlFragment('今天天气很好') === false);
check('空串不命中', isPureDsmlFragment('') === false);
check('纯空白不命中', isPureDsmlFragment('   \n ') === false);
check('非字符串不命中', isPureDsmlFragment(null) === false);

// v0.3 行为：残片粘着半句话也要能抓到（此前是「已知局限」，现在已修复）
check(
  '半句话+残片 命中',
  isPureDsmlFragment('我说完了</｜｜DSML｜｜ invoke>') === true,
);
check(
  '整段正文+闭合标签 命中',
  isPureDsmlFragment('那我去翻翻桌面。\n找到脚本再说，别急。\n</｜｜DSML｜｜ invoke>') === true,
);

// 但仍不能误报「正常讨论 DSML」：有闭合标签、但残留正文很长
const LONG_DISCUSSION =
  '这个 </｜｜DSML｜｜ invoke> 标签是中转层解析失败时吐出来的残片。' +
  '我们前天查过时间线，发现它和上下文压缩没有关系，更可能与 openai-completions ' +
  '协议的序列化有关。'.repeat(4);
check('长段正常讨论不命中', isPureDsmlFragment(LONG_DISCUSSION) === false);

// 只提到标签名字、没有闭合标签形态，也不算
check('只提 open 标签不命中', isPureDsmlFragment('标签 <｜｜DSML｜｜ invoke> 的开头') === false);

// ── chunkText 只收正文 ────────────────────────────────────
check('text-delta 取值', chunkText({ type: 'text-delta', index: 0, text: 'abc' }) === 'abc');
check(
  'block-end text 取值',
  chunkText({ type: 'block-end', block: { type: 'text', text: 'xyz' } }) === 'xyz',
);
check(
  'reasoning-delta 不取',
  chunkText({ type: 'reasoning-delta', index: 0, text: '思考' }) === null,
);
check(
  'block-end reasoning 不取',
  chunkText({ type: 'block-end', block: { type: 'reasoning', text: '思考' } }) === null,
);
check('tool-call-delta 不取', chunkText({ type: 'tool-call-delta', name: 'bash' }) === null);
check('null 不崩', chunkText(null) === null);

// ── 流包装：必须逐块原样透传 ──────────────────────────────
async function* fakeStream(chunks) {
  for (const c of chunks) yield c;
}

const originalChunks = [
  { type: 'text-delta', index: 0, text: '\n' },
  { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜' },
  { type: 'text-delta', index: 0, text: ' invoke' },
  { type: 'text-delta', index: 0, text: '>\n' },
  { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜' },
  { type: 'text-delta', index: 0, text: ' calls' },
  { type: 'text-delta', index: 0, text: '>' },
  { type: 'block-end', block: { type: 'text', text: REAL_FRAGMENT } },
];

// 模拟最小 ctx
const warnings = [];
const handlers = {};
const ctx = {
  logger: {
    info: () => {},
    warn: (m) => warnings.push(m),
  },
  on: (evt, fn) => {
    handlers[evt] = fn;
  },
  set: () => {},
};

apply(ctx, { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-main.log` });

check('挂上了 llm/stream', typeof handlers['llm/stream'] === 'function');

const listener = handlers['llm/stream'];
const wrapped = listener({ provider: 'relay', model: 'test' }, () => fakeStream(originalChunks));

const seen = [];
if (wrapped && typeof wrapped[Symbol.asyncIterator] === 'function') {
  for await (const c of wrapped) seen.push(c);
} else if (wrapped) {
  for (const c of wrapped) seen.push(c);
}

check('块数一致', seen.length === originalChunks.length);
check(
  '每块原样透传',
  JSON.stringify(seen) === JSON.stringify(originalChunks),
);

// 每个 delta 都不是纯残片，只有 block-end 那条是 → 恰好 1 条告警
check('命中 1 次告警', warnings.filter((w) => w.includes('DSML-LEAK')).length === 1);
check('告警带 provider', warnings.some((w) => w.includes('provider=relay')));

// v0.3：没有 block-end 的流（只有 delta）也必须在流结束时判定并报警
warnings.length = 0;
const deltaOnly = [
  { type: 'text-delta', index: 0, text: '\n' },
  { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ invoke>' },
  { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ calls>' },
];
const wrappedDelta = listener({ provider: 'relay', model: 'test' }, () => fakeStream(deltaOnly));
for await (const _ of wrappedDelta) {
  // consume
}
check(
  '纯 delta 流在结束时判定，恰好 1 条',
  warnings.filter((w) => w.includes('DSML-LEAK')).length === 1,
);

// v0.3：「半句话 + 残片」在流里也要能抓到
warnings.length = 0;
const halfSentence = [
  { type: 'text-delta', index: 0, text: '那我去翻翻桌面。找到脚本再说，别急。' },
  { type: 'text-delta', index: 0, text: '<' },
  { type: 'text-delta', index: 0, text: '/｜｜DSML｜｜ invoke>' },
];
const wrappedHalf = listener({ provider: 'relay', model: 'test' }, () => fakeStream(halfSentence));
for await (const _ of wrappedHalf) {
  // consume
}
check(
  '半句话+残片 恰好 1 条',
  warnings.filter((w) => w.includes('DSML-LEAK')).length === 1,
);

// ── 正常对话流不该告警 ────────────────────────────────────
warnings.length = 0;
const normalChunks = [
  { type: 'text-delta', index: 0, text: 'DSML ' },
  { type: 'text-delta', index: 0, text: '泄露怎么办' },
  { type: 'block-end', block: { type: 'text', text: 'DSML 泄露怎么办' } },
];
const wrapped2 = listener({ provider: 'relay', model: 'test' }, () => fakeStream(normalChunks));
for await (const _ of wrapped2) {
  // consume
}
check('正常流不告警', warnings.filter((w) => w.includes('DSML-LEAK')).length === 0);

// ── 错传流不该崩 ──────────────────────────────────────────
check('undefined 流不崩', listener({}, () => undefined) === undefined);
check('null 流不崩', listener({}, () => null) === null);

// ── 关闭开关不该挂监听 ────────────────────────────────────
// 注意：这里也必须传 logFile，否则 apply() 会往真实日志
// qqbot/logs/dsml-guard.log 里写一条 pid=测试进程 的 boot 行，污染后续排查。
const handlers2 = {};
apply(
  { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (handlers2[e] = f), set: () => {} },
  { enabled: false, logFile: `${process.env.TEMP || '.'}/dsml-test-disabled.log` },
);
check('enabled:false 不挂监听', handlers2['llm/stream'] === undefined);

// ── v0.4：上游异常必须原样透传，绝不能被 guard 吞掉 ──────────
// 依据 dsh-llm 约定：中间件失败要「继续抛出」，吞掉会让上层等不到终态 chunk。
const tmpLog = `${process.env.TEMP || '.'}/dsml-test-v04.log`;

async function* throwingStream(before, err) {
  for (const c of before) yield c;
  throw err;
}

// 1) next() 迭代中途抛错 → 异常原样到达消费者
{
  const boom = new Error('upstream exploded');
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: tmpLog },
  );
  const l = h['llm/stream'];
  const w = l({ provider: 'relay', model: 'test' }, () =>
    throwingStream([{ type: 'text-delta', index: 0, text: '正常正文' }], boom),
  );
  let caught = null;
  const got = [];
  try {
    for await (const c of w) got.push(c);
  } catch (e) {
    caught = e;
  }
  check('迭代异常原样抛出（同一对象）', caught === boom);
  check('异常前已收到的块仍透传', got.length === 1);
}

// 2) 抛错前已攒够残片 → 仍然先判定记录，再抛
{
  const boom2 = new Error('late failure');
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: tmpLog },
  );
  const l = h['llm/stream'];
  const w = l({ provider: 'relay', model: 'test' }, () =>
    throwingStream(
      [
        { type: 'text-delta', index: 0, text: '\n' },
        { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ invoke>' },
        { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ calls>' },
      ],
      boom2,
    ),
  );
  let caught2 = null;
  try {
    for await (const _ of w) {
      // consume
    }
  } catch (e) {
    caught2 = e;
  }
  check('异常前攒到的残片仍被记录', caught2 === boom2);
}

// 3) 消费者提前 return（用户中断）→ 不该把正常收尾变成异常
{
  async function* endless() {
    yield { type: 'text-delta', index: 0, text: '一' };
    yield { type: 'text-delta', index: 0, text: '二' };
    yield { type: 'text-delta', index: 0, text: '三' };
  }
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: tmpLog },
  );
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => endless());
  let ok = true;
  try {
    for await (const c of w) {
      if (c.text === '一') break;
    }
  } catch {
    ok = false;
  }
  check('消费者提前 break 不抛异常', ok === true);
}

// 4) 上游 throw() 语义：wrapper 必须把异常转到内层流
{
  const boom3 = new Error('consumer abort');
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: tmpLog },
  );
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () =>
    throwingStream([{ type: 'text-delta', index: 0, text: 'x' }], boom3),
  );
  const it = w[Symbol.asyncIterator]();
  await it.next();
  let caught3 = null;
  try {
    await it.next();
  } catch (e) {
    caught3 = e;
  }
  check('手动迭代时异常同样透传', caught3 === boom3);
}

// ── v0.6：retry 档 —— 命中残片时发失败分片，让 DSH 自己重跑这一步 ────
// 依据 dsh-llm：终态失败分片的形状是
//   { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
// `EMPTY_RESPONSE` 在 DEFAULT_RETRYABLE_CODES 里，重试器会接管。
{
  const retryLog = `${process.env.TEMP || '.'}/dsml-test-v06.log`;
  const h = {};
  const warns = [];
  apply(
    { logger: { info: () => {}, warn: (m) => warns.push(m) }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: retryLog, leakAction: 'retry' },
  );
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(originalChunks));
  const got = [];
  for await (const c of w) got.push(c);

  check('retry 档：只发出 1 个 chunk', got.length === 1);
  check('retry 档：发的是 finish', got[0]?.type === 'finish');
  check('retry 档：reason.kind 是 error', got[0]?.reason?.kind === 'error');
  check('retry 档：失败码是 EMPTY_RESPONSE', got[0]?.reason?.failure?.code === 'EMPTY_RESPONSE');
  check('retry 档：失败信息非空', typeof got[0]?.reason?.failure?.message === 'string' && got[0].reason.failure.message.length > 0);
  // 最关键：残片正文一个字都不能漏到下游
  // 注意判据用真正的标签串（`｜｜DSML｜｜`），不能用 'DSML' ——
  // 失败分片里的说明文字本身也含 DSML 三个字母。
  const leakedTag = JSON.stringify(got).includes('｜｜DSML｜｜');
  const hasTextDelta = got.some((c) => c.type === 'text-delta');
  check('retry 档：残片标签没有漏出去', leakedTag === false);
  check('retry 档：没有任何正文分片', hasTextDelta === false);
  check('retry 档：仍然记了告警', warns.filter((m) => m.includes('DSML-LEAK')).length === 1);
}

// retry 档的第二个条件：正常正文必须一字不改地放行（扣留之后要补发）
{
  const retryLog2 = `${process.env.TEMP || '.'}/dsml-test-v06b.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: retryLog2, leakAction: 'retry' },
  );
  const normal = [
    { type: 'text-delta', index: 0, text: '好的，' },
    { type: 'text-delta', index: 0, text: '我去看看日志。' },
    { type: 'block-end', block: { type: 'text', text: '好的，我去看看日志。' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(normal));
  const got = [];
  for await (const c of w) got.push(c);
  const joined = got
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('');
  check('retry 档：正常正文完整放行', joined === '好的，我去看看日志。');
  check('retry 档：正常流不发失败分片', got.some((c) => c.type === 'finish') === false);
}

// v0.7：「正文 + 尾巴残片」在 retry 档也要重跑 —— 这正是 2026-11-13 13:35 那次的形态。
// 旧行为（v0.5-v0.6）只认空心残片，这种形态被原样放行，残片就写进了历史。
{
  const retryLog3 = `${process.env.TEMP || '.'}/dsml-test-v07a.log`;
  const h = {};
  const warns = [];
  apply(
    { logger: { info: () => {}, warn: (m) => warns.push(m) }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: retryLog3, leakAction: 'retry' },
  );
  const proseThenTags = [
    { type: 'text-delta', index: 0, text: '那我去翻翻桌面。找到脚本再说，别急。' },
    { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ parameter name="command">' },
    { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ invoke>' },
    { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ calls>' },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(proseThenTags));
  const got = [];
  for await (const c of w) got.push(c);
  check('v0.7 正文+尾巴残片：发失败分片', got.length === 1 && got[0]?.type === 'finish');
  check(
    'v0.7 正文+尾巴残片：失败码 EMPTY_RESPONSE',
    got[0]?.reason?.failure?.code === 'EMPTY_RESPONSE',
  );
  check(
    'v0.7 正文+尾巴残片：正文和标签都没漏出去',
    JSON.stringify(got).includes('翻翻桌面') === false &&
      JSON.stringify(got).includes('｜｜DSML｜｜') === false,
  );
  check('v0.7 正文+尾巴残片：记了告警', warns.filter((m) => m.includes('DSML-LEAK')).length === 1);
}

// v0.7：被截断在**开标签**上也要认（旧判据要求至少一个闭合标签，这种形态会漏）
{
  const retryLog4 = `${process.env.TEMP || '.'}/dsml-test-v07b.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: retryLog4, leakAction: 'retry' },
  );
  const openTail = [
    { type: 'text-delta', index: 0, text: '先看一眼配置。' },
    { type: 'text-delta', index: 0, text: '<｜｜DSML｜｜ parameter name="path">' },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(openTail));
  const got = [];
  for await (const c of w) got.push(c);
  check('v0.7 开标签结尾：发失败分片', got.length === 1 && got[0]?.type === 'finish');
}

// v0.7：正文里**引用**残片（行内代码 / 围栏代码块）不能误判成泄露
{
  const retryLog5 = `${process.env.TEMP || '.'}/dsml-test-v07c.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: retryLog5, leakAction: 'retry' },
  );

  const inlineQuote = [
    { type: 'text-delta', index: 0, text: '日志里就是 `</｜｜DSML｜｜ invoke>`' },
  ];
  const w1 = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(inlineQuote));
  const got1 = [];
  for await (const c of w1) got1.push(c);
  check('v0.7 行内代码引用：不发失败分片', got1.some((c) => c.type === 'finish') === false);
  check(
    'v0.7 行内代码引用：原文放行',
    got1.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') ===
      '日志里就是 `</｜｜DSML｜｜ invoke>`',
  );

  const fencedQuote = [
    { type: 'text-delta', index: 0, text: '复现长这样：\n```\n</｜｜DSML｜｜ invoke>\n```' },
  ];
  const w2 = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(fencedQuote));
  const got2 = [];
  for await (const c of w2) got2.push(c);
  check('v0.7 围栏代码块引用：不发失败分片', got2.some((c) => c.type === 'finish') === false);
}

// v0.7：replace 档仍然只换空心残片 —— 有正文时不能把正文换成提示语
{
  const repLog = `${process.env.TEMP || '.'}/dsml-test-v07d.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: repLog, leakAction: 'replace' },
  );
  const proseThenTags = [
    { type: 'text-delta', index: 0, text: '我去看看日志。' },
    { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ invoke>' },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(proseThenTags));
  const got = [];
  for await (const c of w) got.push(c);
  const joined = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.7 replace 档：有正文时不替换', joined.includes('我去看看日志。') === true);
  check('v0.7 replace 档：没塞提示语', joined.includes('本轮输出异常') === false);
}

// v0.7：超长正文（超过 INTERCEPT_HOLD_MAX=1200）也不能漏 —— 07:58 那次真实泄露 3191 字。
// 机制：超过 1200 就把已攒的正文提前放出去并重置缓冲；残片到达后单独成段，
// 到 block-end 时「最后一个标签之后没内容」仍然成立 → 照样 retry。
{
  const retryLog6 = `${process.env.TEMP || '.'}/dsml-test-v07e.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: retryLog6, leakAction: 'retry' },
  );
  const longProse = '先说明一下现状。'.repeat(200); // 1600 字，越过 hold 上限
  const longCase = [
    { type: 'text-delta', index: 0, text: longProse.slice(0, 800) },
    { type: 'text-delta', index: 0, text: longProse.slice(800) },
    { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ invoke>' },
    { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ calls>' },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(longCase));
  const got = [];
  for await (const c of w) got.push(c);
  check('v0.7 超长正文+残片：最后一块是失败分片', got[got.length - 1]?.type === 'finish');
  check(
    'v0.7 超长正文+残片：失败码 EMPTY_RESPONSE',
    got[got.length - 1]?.reason?.failure?.code === 'EMPTY_RESPONSE',
  );
  check(
    'v0.7 超长正文+残片：残片标签没有漏出去',
    JSON.stringify(got).includes('｜｜DSML｜｜') === false,
  );
}

// 兼容老配置：intercept:true 且没写 leakAction → 仍走 replace，不能变成 retry
{
  const legacyLog = `${process.env.TEMP || '.'}/dsml-test-v06d.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: legacyLog, intercept: true },
  );
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(originalChunks));
  const got = [];
  for await (const c of w) got.push(c);
  check('老配置 intercept:true 仍走 replace（不发失败分片）', got.some((c) => c.type === 'finish') === false);
  check(
    '老配置 intercept:true 换成了提示语',
    got.some((c) => c.type === 'text-delta' && c.text.includes('本轮输出异常')),
  );
}

// ── v0.8：正文是「思考副本」时必须一直扣住，不能超过 1200 字就放行 ────────
// 依据：某会话的 11 次失败尝试里 text 与 reasoning 逐字相同（最长 3667 字）；
// 中转把 reasoning_content 复制进了 content，前端看到的「垃圾」就是它。
const COPY_THOUGHT = '我需要先确认这个会话里到底有多少次重试，然后再看每次重试的文本是不是同一份。'.repeat(40); // ~1600 字

check('v0.8 副本判据：逐字相同 → true', looksLikeReasoningCopy(COPY_THOUGHT, COPY_THOUGHT) === true);
check(
  'v0.8 副本判据：正文是思考的前缀 → true',
  looksLikeReasoningCopy(COPY_THOUGHT.slice(0, 1500), COPY_THOUGHT) === true,
);
check(
  'v0.8 副本判据：正文比思考长（流式顺序反了）→ true',
  looksLikeReasoningCopy(COPY_THOUGHT + '后面还有一点', COPY_THOUGHT) === true,
);
check('v0.8 副本判据：短文本不比 → false', looksLikeReasoningCopy('我需要先确认', '我需要先确认') === false);
check('v0.8 副本判据：两段不同内容 → false', looksLikeReasoningCopy(COPY_THOUGHT, '完全不一样的另一段思考内容'.repeat(40)) === false);
check('v0.8 副本判据：空值不崩', looksLikeReasoningCopy(COPY_THOUGHT, '') === false && looksLikeReasoningCopy(null, null) === false);

// 流级验证：思考副本 + 尾巴残片，全程不该有正文字符漏给前端
{
  const copyLog = `${process.env.TEMP || '.'}/dsml-test-v08a.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: copyLog, leakAction: 'retry' },
  );
  const chunks = [
    // 上游先流推理，再流一份一模一样的正文（中转的复制行为）
    { type: 'reasoning-delta', index: 0, text: COPY_THOUGHT.slice(0, 800) },
    { type: 'reasoning-delta', index: 0, text: COPY_THOUGHT.slice(800) },
    { type: 'block-end', block: { type: 'reasoning', text: COPY_THOUGHT } },
    { type: 'text-delta', index: 0, text: COPY_THOUGHT.slice(0, 800) },
    { type: 'text-delta', index: 0, text: COPY_THOUGHT.slice(800) },
    { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ parameter>' },
    { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ invoke>' },
    { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ calls>' },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(chunks));
  const got = [];
  for await (const c of w) got.push(c);
  const leakedProse = got
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('');
  check('v0.8 副本：最后一块是失败分片', got[got.length - 1]?.type === 'finish');
  check(
    'v0.8 副本：失败码 EMPTY_RESPONSE',
    got[got.length - 1]?.reason?.failure?.code === 'EMPTY_RESPONSE',
  );
  check('v0.8 副本：正文一个字都没漏给前端', leakedProse.length === 0);
  check('v0.8 副本：推理块原样透传', got.some((c) => c.type === 'reasoning-delta'));
}

// 对照：同样超长、但**不是**思考副本的正常正文 → 仍按老规矩提前放行（不能把正常回复也扣住）
{
  const normalLog = `${process.env.TEMP || '.'}/dsml-test-v08b.log`;
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: normalLog, leakAction: 'retry' },
  );
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: COPY_THOUGHT },
    { type: 'block-end', block: { type: 'reasoning', text: COPY_THOUGHT } },
    { type: 'text-delta', index: 0, text: '这是一段完全正常的回答，和上面的思考内容没有任何关系。'.repeat(40) },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(chunks));
  const got = [];
  for await (const c of w) got.push(c);
  const prose = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.8 非副本：超长正常正文照样放行', prose.includes('完全正常的回答'));
  check('v0.8 非副本：不发失败分片', got.some((c) => c.type === 'finish') === false);
}

// ── v0.9：思考被塞进正文通道（字面 `<thinking>`）时搬回 reasoning ──────
// 依据：实测某次会话里 19/33 条正文是纯思考、套着 <thinking> 标签，
// DSH 按普通正文渲染，翻译插件够不着 → 用户看到整段没翻译的英文。
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v09a.log`, leakAction: 'retry' },
  );
  const thinkingInContent = [
    { type: 'reasoning-delta', index: 0, text: 'real reasoning' },
    { type: 'block-end', block: { type: 'reasoning', text: 'real reasoning' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    // 标签被拆成两个 delta —— 上游确实会这么切
    { type: 'text-delta', index: 1, text: '<thin' },
    { type: 'text-delta', index: 1, text: 'king>Now the picture is clear. ' },
    { type: 'text-delta', index: 1, text: 'Let me check the logs.</thinking>' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '<thinking>Now the picture is clear. Let me check the logs.</thinking>' } },
    { type: 'tool-call-delta', index: 2, id: 'c1', name: 'bash', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(thinkingInContent));
  const got = [];
  for await (const c of w) got.push(c);

  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  const reasoning = got.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  const starts = got.filter((c) => c.type === 'block-start' && c.index === 1);
  const ends = got.filter((c) => c.type === 'block-end' && c.index === 1);

  check('v0.9 思考进正文：正文通道一个字都没有', text.length === 0);
  check('v0.9 思考进正文：内容搬进 reasoning', reasoning.includes('Now the picture is clear'));
  check('v0.9 思考进正文：块头改成 reasoning', starts.length === 1 && starts[0].blockType === 'reasoning');
  check('v0.9 思考进正文：块尾改成 reasoning', ends.length === 1 && ends[0].block.type === 'reasoning');
  check('v0.9 思考进正文：标签本身被剥掉', !reasoning.includes('<thinking>') && !reasoning.includes('</thinking>'));
  check('v0.9 思考进正文：有工具调用就不重试', got.some((c) => c.type === 'finish' && c.reason?.failure) === false);
  check('v0.9 思考进正文：finish 正常透传', got[got.length - 1]?.type === 'finish');
}

// 对照组一：正常正文开头不是 <thinking> → 一个字都不许改
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v09b.log`, leakAction: 'retry' },
  );
  const normal = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '我看了一下 ' },
    { type: 'text-delta', index: 0, text: '<thinking> 这个标签是上游漏出来的。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '我看了一下 <thinking> 这个标签是上游漏出来的。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(normal));
  const got = [];
  for await (const c of w) got.push(c);
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.9 正常正文：开头不是标签就原样放行', text === '我看了一下 <thinking> 这个标签是上游漏出来的。');
  check('v0.9 正常正文：块头仍是 text', got.some((c) => c.type === 'block-start' && c.blockType === 'text'));
  check('v0.9 正常正文：没有搬去 reasoning', got.some((c) => c.type === 'reasoning-delta') === false);
}

// 对照组二：形似但不是标签（`<thin` 后面接了别的东西）→ 不能误判
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v09c.log`, leakAction: 'retry' },
  );
  /**
   * v0.16 起「不在 HTML 表里的 `<name>`」一律算内部标签，所以 `<thingk>` 这种
   * 拼错的思考标签**会被搬走**（这是有意的：宁可把思考藏进折叠行，也不能让它
   * 出现在正文里）。这里改成断言它进了 reasoning 通道、正文 0 字。
   */
  const nearMiss = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thin' },
    { type: 'text-delta', index: 0, text: 'gk about it' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thingk about it' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(nearMiss));
  const got = [];
  for await (const c of w) got.push(c);
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.16 拼错的思考标签：不再出现在正文', text.trim().length === 0);
  check(
    'v0.16 拼错的思考标签：搬进了 reasoning',
    got.some((c) => c.type === 'reasoning-delta' && (c.text || '').includes('about it')),
  );
}

// ── v0.16：HTML 标签与自动链接必须原样放行 ────────────────
{
  const cases = [
    ['<div align="center">标题</div>', 'HTML div'],
    ['<https://example.com/x> 这个链接', '自动链接'],
    ['<br>', '单标签'],
  ];
  for (const [body, label] of cases) {
    const h = {};
    apply(
      { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
      {
        enabled: true,
        logFile: `${process.env.TEMP || '.'}/dsml-test-v016-${label}.log`,
        leakAction: 'retry',
      },
    );
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: body },
      { type: 'block-end', index: 0, block: { type: 'text', text: body } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const out = [];
    for await (const c of h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(chunks))) {
      out.push(c);
    }
    const seen = out.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    check(`v0.16 ${label}：原样放行`, seen.includes(body) || body === seen);
  }
}

// ── v0.16：上游新造的词（quick_check / remaining_text …）也要拦住 ──
{
  const body =
    '<quick_check>Interesting: `_keep_rank` returns 1 for qq缓存 but 全部 also returns 1.\n' +
    'So in tests under %TEMP%, all are cache → ordering falls to parts then lexicographic.\n'.repeat(4);
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v016-qc.log`, leakAction: 'retry' },
  );
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: body },
    { type: 'block-end', index: 0, block: { type: 'text', text: body } },
    { type: 'tool-call-delta', index: 1, name: 'bash', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'toolUse' } },
  ];
  const out = [];
  for await (const c of h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(chunks))) {
    out.push(c);
  }
  const prose = out
    .filter((c) => c.type === 'text-delta' || (c.type === 'block-end' && c.block?.type === 'text'))
    .map((c) => c.text || c.block?.text || '')
    .join('');
  check('v0.16 quick_check：一个字节都不进正文', prose.length === 0);
  check('v0.16 quick_check：没有标签字样', !prose.includes('quick_check'));
}

// 对照组三：整条只有思考、没有正文也没有工具调用 → 发 EMPTY_RESPONSE 重跑这一步
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v09d.log`, leakAction: 'retry' },
  );
  const onlyThinking = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>I should look at the config first.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>I should look at the config first.' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(onlyThinking));
  const got = [];
  for await (const c of w) got.push(c);
  check('v0.9 只有思考：最后发失败分片', got[got.length - 1]?.type === 'finish');
  check(
    'v0.9 只有思考：失败码 EMPTY_RESPONSE',
    got[got.length - 1]?.reason?.failure?.code === 'EMPTY_RESPONSE',
  );
  check(
    'v0.9 只有思考：思考原文不当下发正文',
    got.filter((c) => c.type === 'text-delta').length === 0,
  );
}

// ── v0.10：标签族与「整理类直接丢掉」 ──────────────────────
function runV10(chunks, logTag) {
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-${logTag}.log`, leakAction: 'retry' },
  );
  return (async () => {
    const out = [];
    const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(chunks));
    for await (const c of w) out.push(c);
    return out;
  })();
}

// 1) `<analysis>` 整块丢掉：正文通道一个字都没有，块头块尾也不发
{
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<analysis>Internal notes: ' },
      { type: 'text-delta', index: 0, text: 'the user wants X.</analysis>' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<analysis>Internal notes: the user wants X.</analysis>' } },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v10a',
  );
  check('v0.10 analysis：正文一个字都不发', got.filter((c) => c.type === 'text-delta').length === 0);
  check('v0.10 analysis：这个块连块头都不发', got.filter((c) => c.type === 'block-start').length === 0);
  check('v0.10 analysis：有工具调用就不重试', !got.some((c) => c.reason?.failure));
}

// 2) `<preamble>` 后面跟真回答 → 只丢前言，回答照常当正文（用户看到的那条）
{
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<preamble>Setting the stage.' },
      { type: 'text-delta', index: 0, text: '</preamble>Now the real answer: ' },
      { type: 'text-delta', index: 0, text: 'we should restart the bridge.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '<preamble>Setting the stage.</preamble>Now the real answer: we should restart the bridge.' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v10b',
  );
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.10 preamble：前言被丢掉', !text.includes('Setting the stage'));
  check('v0.10 preamble：真回答保留', text.includes('we should restart the bridge'));
  check('v0.10 preamble：块头照常是 text', got.some((c) => c.type === 'block-start' && c.blockType === 'text'));
}

// 3) 标签漏了闭合尖括号（`<thinkingNo …`）也要认
{
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinkingNo translation files anywhere ' },
      { type: 'text-delta', index: 0, text: 'so it must be the plugin.</thinking>' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v10c',
  );
  const reasoning = got.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  check('v0.10 漏尖括号：照样搬进 reasoning', reasoning.includes('translation files anywhere'));
  check('v0.10 漏尖括号：正文通道没有它', got.filter((c) => c.type === 'text-delta').length === 0);
  check('v0.10 漏尖括号：块头改成 reasoning', got.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'));
}

// 4) 一段里连着两个整理块（`</analysis><summary>`）→ 都丢掉
{
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<analysis>AAATOKEN</analysis><summary>BBBTOKEN</summary>' },
      { type: 'text-delta', index: 0, text: 'tail answer' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v10d',
  );
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.10 连块：两个整理块都丢掉', !text.includes('AAATOKEN') && !text.includes('BBBTOKEN'));
  check('v0.10 连块：后面的正文档保留', text.includes('tail answer'));
}

// 5) `<thinking>` 闭合后跟真回答 → 回答不能跟着被藏进下拉框（v0.9 的隐患）
{
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>pondering</thinking>' },
      { type: 'text-delta', index: 0, text: 'Here is the answer.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v10e',
  );
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.10 闭合后跟回答：回答留在正文通道', text.includes('Here is the answer'));
  check('v0.10 闭合后跟回答：回答单独成块', got.some((c) => c.type === 'block-start' && c.blockType === 'text'));
  check(
    'v0.10 闭合后跟回答：思考块仍以 reasoning 闭合',
    got.some((c) => c.type === 'block-end' && c.block?.type === 'reasoning'),
  );
}

// 6) 只有整理产物、没有工具调用 → 让 DSH 重跑这一步
{
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<summary>1. Primary Request and Intent: ...' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v10f',
  );
  check('v0.10 只有整理：最后发失败分片', got[got.length - 1]?.type === 'finish');
  check(
    'v0.10 只有整理：失败码 EMPTY_RESPONSE',
    got[got.length - 1]?.reason?.failure?.code === 'EMPTY_RESPONSE',
  );
}

// 7) 形似但不是标签的正常正文，一个字都不许改
{
  const plain = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'The <thinking> tag is what the upstream ' },
    { type: 'text-delta', index: 0, text: 'leaks, so we strip it.' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'x' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const got = await runV10(plain, 'v10g');
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.10 正文中间的标签不动', text.startsWith('The <thinking> tag is what the upstream'));
  check('v0.10 正常正文不产生 reasoning', got.filter((c) => c.type === 'reasoning-delta').length === 0);
}

// 8) observe 档不许改流：`<thinking>` 块也一个字都不许动
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v10h.log`, leakAction: 'observe' },
  );
  const src = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>draft text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>draft text' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const got = [];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(src));
  for await (const c of w) got.push(c);
  check('v0.10 observe 档：一个 chunk 都不多不少', got.length === src.length);
  check('v0.10 observe 档：正文原样下发', got[1]?.type === 'text-delta' && got[1].text === '<thinking>draft text');
  check('v0.10 observe 档：不产生 reasoning', got.filter((c) => c.type === 'reasoning-delta').length === 0);
}


// ── v0.11：正文可能整段塞在 block-end 的 block.text 里 ────────────
// 依据：2026-11-15 22:30 / 22:56 两条 22,039 / 19,749 字的 <analysis> 泄露，
// 会话 dump 里 text-chunks 只有 2 个字符，全文都在 block-end.block.text 上，
// 而 BlockAssembler 以 block.text 为准 —— 只过滤 delta 等于没过滤。
{
  // 1) 整块整理产物，delta 只有两个换行 → 一个字都不该发出去
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '\n\n' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '<analysis>SECRETPLAN</analysis><summary>FAKESUMMARY</summary>' },
      },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v11a',
  );
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.11 整块 analysis：正文一个字都不发', text.trim().length === 0);
  check('v0.11 整块 analysis：没有泄露关键词', !JSON.stringify(got).includes('SECRETPLAN'));
  check('v0.11 整块 analysis：连块头都不发', !got.some((c) => c.type === 'block-start' && c.blockType === 'text'));
}

{
  // 2) 整块是思考 → 搬进 reasoning 通道
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '<thinking>I need to check the logs first.</thinking>' },
      },
      { type: 'tool-call-delta', index: 1, id: 'c1', name: 'bash', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v11b',
  );
  const reasoning = got.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('');
  check('v0.11 整块 thinking：内容搬进 reasoning', reasoning.includes('check the logs first'));
  check('v0.11 整块 thinking：正文通道没有它', got.filter((c) => c.type === 'text-delta').length === 0);
  check('v0.11 整块 thinking：块头是 reasoning', got.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'));
  check(
    'v0.11 整块 thinking：块尾以 reasoning 闭合',
    got.some((c) => c.type === 'block-end' && c.block?.type === 'reasoning'),
  );
}

{
  // 3) 思考 + 后面的真回答 → 回答必须留在正文通道
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: '<analysis>notes</analysis><thinking>pondering</thinking>ANSWERTOKEN here.' },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v11c',
  );
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.11 思考后跟回答：回答保留', text.includes('ANSWERTOKEN'));
  check('v0.11 思考后跟回答：整理产物丢掉', !JSON.stringify(got).includes('notes'));
}

{
  // 4) 普通正文：delta 没给全时用 block.text 补齐，且只补一次
  const got = await runV10(
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '前半句' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '前半句，后半句。' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    'v11d',
  );
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.11 补齐：整段完整且不重复', text === '前半句，后半句。');
}

// ── v0.12：只剩标签壳子的噪声（2026-11-21 用户截图：一屏 </thinking> 加 <parameter>）──
const SOUP = Array.from({ length: 20 }, () => '</thinking>').join(' ') + ' <parameter> </parameter>';

check('v0.12 标签噪声：用户那屏命中', isInternalTagSoup(SOUP) === true);
check('v0.12 标签噪声：单个标签不算（至少两个）', isInternalTagSoup('</thinking>') === false);
check('v0.12 标签噪声：正常正文不误杀', isInternalTagSoup('我看了一下 <thinking> 这个标签是上游漏出来的') === false);
check('v0.12 标签噪声：空 HTML 不误杀（名字不在内部族里）', isInternalTagSoup('<b></b><i></i>') === false);
check('v0.12 标签噪声：夹了正文就不算', isInternalTagSoup('</thinking> 结论是重启桥 </parameter>') === false);

// 集成：噪声进流 → 必须发 EMPTY_RESPONSE 重跑，且一个字都不下发
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v12a.log`, leakAction: 'retry' },
  );
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: SOUP.slice(0, 120) },
    { type: 'text-delta', index: 0, text: SOUP.slice(120) },
    { type: 'block-end', index: 0, block: { type: 'text', text: SOUP } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(stream));
  const got = [];
  for await (const c of w) got.push(c);
  check('v0.12 集成：一个字节正文都不下发', got.filter((c) => c.type === 'text-delta').length === 0);
  check('v0.12 集成：发的是 EMPTY_RESPONSE 失败分片', got.some((c) => c.type === 'finish' && c.reason?.failure?.code === 'EMPTY_RESPONSE'));
  check('v0.12 集成：末条也是失败分片', got[got.length - 1]?.reason?.failure?.code === 'EMPTY_RESPONSE');
}

// 对照：正常正文里提了一句标签名，行为不变
{
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v12b.log`, leakAction: 'retry' },
  );
  const sentence = '结论：桥是好的，只是 parameter 这个标签名不常见。';
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: sentence },
    { type: 'block-end', index: 0, block: { type: 'text', text: sentence } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(stream));
  const got = [];
  for await (const c of w) got.push(c);
  const text = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.12 对照：正常正文原样下发', text === sentence);
  check('v0.12 对照：没有误报重试', got.some((c) => c.reason?.failure) === false);
}

// ── v0.13：竖线根数不再固定 ────────────────────────────────
// 依据：2026-11-22 08:57:41（1,962 字）与 08:59:51（3,825 字）两条真实泄露，
// 标签是**单根**竖线（全角竖线 U+FF5C 只出现一次）；旧正则要求两根 →
// 判据一开始就判否 → judge() 直接 return null，连一条日志都不记。
// 下面用 String.fromCharCode(0xFF5C) 拼标签，避免源码里出现成对竖线造成阅读歧义。
const BAR = String.fromCharCode(0xff5c);
const tag = (name, attrs = '') => `</${BAR}DSML${BAR} ${name}${attrs}>`;

// 判据单测：单根竖线与双根必须同样命中
check('v0.13 单根竖线残片命中', isPureDsmlFragment('\n' + tag('invoke') + '\n' + tag('calls')) === true);
check('v0.13 单根竖线半句话+残片命中', isPureDsmlFragment('我说完了' + tag('invoke')) === true);
check('v0.13 夹空格也命中', isPureDsmlFragment('</' + BAR + ' DSML ' + BAR + ' invoke>') === true);
check('v0.13 半角竖线也命中', isPureDsmlFragment('</|DSML| invoke>') === true);
check(
  'v0.13 全角字母也命中',
  isPureDsmlFragment('</' + BAR + '\uff24\uff33\uff2d\uff2c' + BAR + ' invoke>') === true,
);
check(
  'v0.13 单根竖线正常讨论不误判',
  isPureDsmlFragment('这个 ' + tag('invoke') + ' 标签是残片，后面还有话要说。') === false,
);

// 集成：两条 fixture（结构与真实泄露一致：一整段正文 + 尾部残留的调用标签，
// 内容已脱敏），走 retry 档必须 0 字下发、并发 EMPTY_RESPONSE 让 DSH 重跑这一步。
const leakFixture = JSON.parse(
  await readFile(new URL('./fixtures/synthetic-leaks.json', import.meta.url), 'utf8'),
);
check('v0.13 fixture 有两条', Array.isArray(leakFixture) && leakFixture.length === 2);
for (const [i, item] of leakFixture.entries()) {
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    {
      enabled: true,
      logFile: `${process.env.TEMP || '.'}/dsml-test-v13-${i}.log`,
      leakAction: 'retry',
    },
  );
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '\n\n' },
    { type: 'block-end', index: 0, block: { type: 'text', text: item.text } },
    { type: 'tool-call-delta', index: 1, name: 'bash' },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(stream));
  const got = [];
  for await (const c of w) got.push(c);
  const outText = got
    .filter((c) => c.type === 'text-delta')
    .map((c) => c.text)
    .join('');
  const stopped = got.some(
    (c) => c.type === 'finish' && c.reason?.failure?.code === 'EMPTY_RESPONSE',
  );
  check(`v0.13 fixture#${i + 1}（${item.text.length} 字）0 字下发`, outText.length === 0);
  check(`v0.13 fixture#${i + 1} 发 EMPTY_RESPONSE`, stopped);
  check(`v0.13 fixture#${i + 1} 没有把标签漏出去`, JSON.stringify(got).includes('DSML' + BAR) === false);
}

// ── v0.15 rescue：把泄漏的工具调用救回来 ──────────────────
{
  const B = '｜';
  const D = '｜DSML｜';
  const tag = (s) => '<' + B + D + B + s + '>';
  const close = (s) => '</' + B + D + B + s + '>';
  const tmp = (n) => (process.env.TEMP || '.') + '/' + n;
  const wrap = (invokes) =>
    '我先看一眼。\n' + tag('tool_calls') + '\n' + invokes.join('\n') + '\n' + close('tool_calls');
  const par = (n, v, t) =>
    tag('parameter name="' + n + '"' + (t === undefined ? '' : ' string="' + t + '"')) + v + close('parameter');
  const inv = (name, params) => tag('invoke name="' + name + '"') + params.join('') + close('invoke');

  const one = inv('Bash', [par('command', 'ls -1', 'true'), par('timeout', '30000', 'false')]);
  const two = inv('Bash', [par('command', 'pwd')]) + '\n' + inv('Read', [par('path', '/tmp/a')]);
  const mkH = () => {
    const h = {};
    const lg = tmp('dsml-v15-' + Math.random().toString(36).slice(2) + '.log');
    apply({ logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
      { enabled: true, logFile: lg, leakAction: 'rescue' });
    return h;
  };
  const drain = async (w) => { const g = []; for await (const c of w) g.push(c); return g; };
  const leakText = wrap([one]);
  const leakStream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    // v0.20：delta 必须是 block.text 的前缀（真实流就是这样）。旧 fixture 少了「我」，
    // 旧代码因为整块缓冲看不出来；v0.20 逐块放行，前缀对不上就无法扣掉重复部分。
    { type: 'text-delta', index: 0, text: '我先看一眼。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: leakText } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const gotA = await drain(mkH()['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Bash' }] }, () => fakeStream(leakStream)));
  const callEnd = gotA.find((c) => c.type === 'block-end' && c.block && c.block.type === 'tool-call');
  const textOut = gotA.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.15 流级：救回 1 个工具调用', gotA.filter((c) => c.block && c.block.type === 'tool-call').length === 1);
  check('v0.15 流级：工具名 Bash', Boolean(callEnd) && callEnd.block.name === 'Bash');
  check('v0.15 流级：参数合法', (() => { try { return JSON.parse(callEnd.block.arguments).command === 'ls -1'; } catch { return false; } })());
  check('v0.15 流级：正文洗净', textOut === '我先看一眼。');
  check('v0.15 流级：标签没漏出去', JSON.stringify(gotA).indexOf(B + D + B) === -1);
  check('v0.15 流级：finish 改写成 tool-calls', gotA.find((c) => c.type === 'finish').reason.kind === 'tool-calls');
  check('v0.15 流级：无 EMPTY_RESPONSE', gotA.every((c) => !(c.reason && c.reason.failure)));
  check('v0.15 流级：id 带 rescue 前缀', String(callEnd.block.id).indexOf('call-rescue-') === 0);
  const gotB = await drain(mkH()['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Read' }] }, () => fakeStream(leakStream)));
  const fbB = gotB.filter((c) => c.reason && c.reason.failure && c.reason.failure.code === 'EMPTY_RESPONSE');
  check('v0.15 流级：白名单外回落 retry', fbB.length === 1 && gotB.every((c) => !(c.block && c.block.type === 'tool-call')));
  const gotC = await drain(mkH()['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(leakStream)));
  const fbC = gotC.filter((c) => c.reason && c.reason.failure && c.reason.failure.code === 'EMPTY_RESPONSE');
  check('v0.15 流级：无工具表回落 retry', fbC.length === 1 && gotC.every((c) => !(c.block && c.block.type === 'tool-call')));
  const normalStream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '好的，' },
    { type: 'text-delta', index: 0, text: '我去看看日志。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '好的，我去看看日志。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const gotD = await drain(mkH()['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Bash' }] }, () => fakeStream(normalStream)));
  check('v0.15 流级：正常正文原样放行', gotD.filter((c) => c.type === 'text-delta').map((c) => c.text).join('') === '好的，我去看看日志。');
  check('v0.15 流级：正常流不发工具调用', gotD.every((c) => !(c.block && c.block.type === 'tool-call')));
  check('v0.15 流级：正常流 finish 保持 stop', gotD.find((c) => c.type === 'finish').reason.kind === 'stop');
}

// ── v0.16 rescue 门槛收紧、rescue-dry、日志补样本 ──────────
{
  const B2 = String.fromCharCode(0xFF5C);
  const M2 = 'DSML';
  const op = (s) => '<' + B2 + M2 + B2 + s + '>';
  const cl = (s) => '</' + B2 + M2 + B2 + s + '>';
  const par2 = (n, v, t) =>
    op('parameter name="' + n + '"' + (t === undefined ? '' : ' string="' + t + '"')) + v + cl('parameter');
  const inv2 = (name, params) => op('invoke name="' + name + '"') + params.join('') + cl('invoke');
  const leakText2 =
    '我先看一眼。\n' + op('tool_calls') + '\n' + inv2('Bash', [par2('command', 'ls -1', 'true')]) + '\n' + cl('tool_calls');
  const leakStream2 = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '我先看一眼。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: leakText2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const normalStream2 = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '好的，我去看看日志。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '好的，我去看看日志。' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const mkH2 = (action) => {
    const h = {};
    const lg = (process.env.TEMP || '.') + '/dsml-v16-' + Math.random().toString(36).slice(2) + '.log';
    apply(
      { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
      { enabled: true, logFile: lg, leakAction: action },
    );
    return { h, lg };
  };
  const linesOf = async (p) => {
    const raw = await readFile(p, 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  };
  const drain2 = async (w) => { const g = []; for await (const c of w) g.push(c); return g; };

  check('v0.16 hasDsmlTag 命中整标签', hasDsmlTag(op('invoke name="Bash"')) === true);
  check('v0.16 hasDsmlTag 命中闭合标签', hasDsmlTag(cl('tool_calls')) === true);
  check('v0.16 hasDsmlTag 命中零竖线退化形态', hasDsmlTag('<' + M2 + 'invoke>') === true);
  check('v0.16 hasDsmlTag 正常正文不命中', hasDsmlTag('好的，我去看看日志。') === false);
  check('v0.16 hasDsmlTag 提到名字不命中', hasDsmlTag('泄露的标记长这样，但没有尖括号包住。') === false);
  check('v0.16 hasDsmlTag 空串不命中', hasDsmlTag('') === false);
  check('v0.16 hasDsmlTag 非字符串不命中', hasDsmlTag(null) === false);

  // 正常正文进 rescue 模式：不许写 rescue-failed 噪声
  {
    const { h, lg } = mkH2('rescue');
    await drain2(h['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Bash' }] }, () => fakeStream(normalStream2)));
    const lines = await linesOf(lg);
    check('v0.16 正常正文不写 rescue-failed', lines.every((l) => l.kind !== 'rescue-failed'));
    check('v0.16 正常正文不写 rescue-would', lines.every((l) => l.kind !== 'rescue-would'));
    check('v0.16 正常正文不写 rescued', lines.every((l) => l.kind !== 'rescued'));
  }

  // rescue-dry：只记日志，不交出工具调用，仍然 retry
  {
    const { h, lg } = mkH2('rescue-dry');
    const got = await drain2(h['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Bash' }] }, () => fakeStream(leakStream2)));
    const lines = await linesOf(lg);
    const would = lines.filter((l) => l.kind === 'rescue-would');
    check('v0.16 dry 档不产出工具调用', got.every((c) => !(c.block && c.block.type === 'tool-call')));
    check('v0.16 dry 档仍然 retry', got.some((c) => c.reason && c.reason.failure && c.reason.failure.code === 'EMPTY_RESPONSE'));
    check('v0.16 dry 档记一条 rescue-would', would.length === 1);
    check('v0.16 dry 档日志里有 calls/names', would.length === 1 && would[0].calls === 1 && JSON.stringify(would[0].names) === JSON.stringify(['Bash']));
    check('v0.16 dry 档日志里有正文样本', would.length === 1 && typeof would[0].sample === 'string' && would[0].sample.length > 0);
  }

  // rescue 成功：日志带样本，收尾记 was/now
  {
    const { h, lg } = mkH2('rescue');
    const got = await drain2(h['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Bash' }] }, () => fakeStream(leakStream2)));
    const lines = await linesOf(lg);
    const rescued = lines.filter((l) => l.kind === 'rescued');
    const fin = lines.filter((l) => l.kind === 'rescued-finish');
    check('v0.16 rescue 成功记一条 rescued', rescued.length === 1);
    check('v0.16 rescued 日志带正文样本', rescued.length === 1 && typeof rescued[0].sample === 'string' && rescued[0].sample.indexOf('看一眼') >= 0);
    check('v0.16 rescued-finish 记录 was=stop', fin.length === 1 && fin[0].was === 'stop');
    check('v0.16 rescued-finish 记录 now=tool-calls', fin.length === 1 && fin[0].now === 'tool-calls');
    check('v0.16 rescue 成功仍有工具调用', got.some((c) => c.block && c.block.type === 'tool-call'));
    check('v0.16 rescue 成功不写 rescue-failed', lines.every((l) => l.kind !== 'rescue-failed'));
  }

  // 解析失败（有标签但白名单外）：仍要写 rescue-failed，且带样本
  {
    const { h, lg } = mkH2('rescue');
    await drain2(h['llm/stream']({ provider: 'relay', model: 'test', tools: [{ name: 'Read' }] }, () => fakeStream(leakStream2)));
    const lines = await linesOf(lg);
    const failed = lines.filter((l) => l.kind === 'rescue-failed');
    check('v0.16 白名单外写一条 rescue-failed', failed.length === 1);
    check('v0.16 rescue-failed 带样本', failed.length === 1 && typeof failed[0].sample === 'string' && failed[0].sample.length > 0);
  }
}

// ── v0.15：连发的游离闭合标签（会话 47055cea 的形态）────────────
check('v0.15 游离闭合标签：两个连着就数两个', countStrayInternalClosers('</thinking>\n\n</thinking>') === 2);
check('v0.15 游离闭合标签：配对的不算', countStrayInternalClosers('<thinking>x</thinking>') === 0);
check('v0.15 游离闭合标签：多出来的那个才算', countStrayInternalClosers('<thinking>x</thinking>y</thinking>') === 1);
check('v0.15 游离闭合标签：非内部族不数', countStrayInternalClosers('</div></p>') === 0);
check(
  'v0.15 剥掉后正文还在',
  dropStrayInternalClosers('a</thinking>\n\n</thinking>b').replace(/\s+/g, '') === 'ab',
);
check('v0.15 配对闭合不被剥', dropStrayInternalClosers('<thinking>x</thinking>') === '<thinking>x</thinking>');

const STRAY_FLOOD =
  Array.from({ length: 114 }, () => '</thinking>').join('\n\n') +
  '\n\nPlan: patch readiness check, rerun commit with 2 files.\n\nWait — I should re-read the script.\n\nThen';
const FLOOD_BLOCK =
  '<thinking>Files ARE staged, the readiness check required n>0 — wrong condition.</thinking>' +
  STRAY_FLOOD;

{
  const h = {};
  const logFile = `${process.env.TEMP || '.'}/dsml-test-v15-flood-${Date.now()}.log`;
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile, leakAction: 'retry' },
  );
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '\n\n' },
    { type: 'block-end', index: 0, block: { type: 'text', text: FLOOD_BLOCK } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(stream));
  const got = [];
  for await (const c of w) got.push(c);
  const all = JSON.stringify(got);
  check('v0.15 残片洪水：一个字节正文都不下发', got.filter((c) => c.type === 'text-delta').length === 0);
  check('v0.15 残片洪水：没有闭合标签漏出去', all.includes('</thinking>') === false);
  check('v0.15 残片洪水：思考内容搬进 reasoning', got.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'));
  check(
    'v0.15 残片洪水：没有正文和工具调用 → 发 EMPTY_RESPONSE',
    got.some((c) => c.type === 'finish' && c.reason?.failure?.code === 'EMPTY_RESPONSE'),
  );
  const lines = (await readFile(logFile, 'utf8')).split('\n').filter((l) => l.includes('"kind":"rethink"'));
  check('v0.15 残片洪水：rethink 只记一条（不再重复报）', lines.length === 1);
}

{
  // 对照：正常的「先思考再回答」，闭合标签只有一个，回答必须保留
  const h = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile: `${process.env.TEMP || '.'}/dsml-test-v15-ok.log`, leakAction: 'retry' },
  );
  const text = '<thinking>hmm</thinking>ANSWERTOKEN';
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
  ];
  const w = h['llm/stream']({ provider: 'relay', model: 'test' }, () => fakeStream(stream));
  const got = [];
  for await (const c of w) got.push(c);
  const out = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  check('v0.15 对照：回答保留', out.includes('ANSWERTOKEN'));
  check('v0.15 对照：没有误判重试', got.some((c) => c.reason?.failure) === false);
}

// ── v0.15：真实数据（会话 47055cea 19:28:35 的文本块）──────────
{
  const floodFixture = JSON.parse(
    await readFile(new URL('./fixtures/stray-closer-flood.json', import.meta.url), 'utf8'),
  );
  check('v0.15 fixture 有一条', Array.isArray(floodFixture) && floodFixture.length === 1);
  const item = floodFixture[0];
  check('v0.15 fixture 确实是 114 个游离闭合标签', countStrayInternalClosers(item.text) === 114);
  const h = {};
  const logFile = `${process.env.TEMP || '.'}/dsml-test-v15-real-${Date.now()}.log`;
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
    { enabled: true, logFile, leakAction: 'retry' },
  );
  const stream = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '\n\n' },
    { type: 'block-end', index: 0, block: { type: 'text', text: item.text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const w = h['llm/stream']({ provider: 'khala', model: 'deepseek-v4.1-flash-1017' }, () => fakeStream(stream));
  const got = [];
  for await (const c of w) got.push(c);
  const out = got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  const all = JSON.stringify(got);
  check('v0.15 真实泄露：0 字正文下发', out.length === 0);
  check('v0.15 真实泄露：没有闭合标签漏出去', all.includes('</thinking>') === false);
  check('v0.15 真实泄露：整块进 reasoning', got.some((c) => c.type === 'block-start' && c.blockType === 'reasoning'));
  check(
    'v0.15 真实泄露：发 EMPTY_RESPONSE 让 DSH 重跑',
    got.some((c) => c.type === 'finish' && c.reason?.failure?.code === 'EMPTY_RESPONSE'),
  );
}

// ── v0.17.1：整段思考在 delta 里就超过扣留上限时，块尾搬完不能又被补发回去 ──
{
  const flood = JSON.parse(
    await readFile(new URL('./fixtures/stray-closer-flood.json', import.meta.url), 'utf8'),
  );
  const body = Array.isArray(flood) ? flood[0].text : flood.text;
  const handlers2 = {};
  const ctx2 = {
    logger: { info: () => {}, warn: () => {} },
    on: (e, f) => { handlers2[e] = f; },
    set: () => {},
  };
  apply(ctx2, {
    enabled: true,
    leakAction: 'retry',
    logFile: `${process.env.TEMP || '.'}/dsml-v0171-${Date.now()}.log`,
  });
  async function* bigDeltas() {
    yield { type: 'block-start', index: 0, blockType: 'reasoning' };
    yield { type: 'reasoning-delta', index: 0, text: 'thinking' };
    yield { type: 'block-start', index: 1, blockType: 'text' };
    const step = 400;
    for (let i = 0; i < body.length; i += step) {
      yield { type: 'text-delta', index: 1, text: body.slice(i, i + step) };
    }
    yield { type: 'block-end', index: 1, block: { type: 'text', text: body } };
    yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const out2 = [];
  for await (const c of handlers2['llm/stream'](
    { provider: 'relay', model: 'flood' },
    () => bigDeltas(),
  )) {
    out2.push(c);
  }
  const prose = out2.filter((c) => c.type === 'text-delta').map((c) => c.text || '').join('');
  const blockEndProse = out2
    .filter((c) => c.type === 'block-end' && c.block?.type === 'text')
    .map((c) => c.block.text || '')
    .join('');
  check('v0.17.1 超长思考副本：正文 delta 一个字节都不发', prose.length === 0);
  check('v0.17.1 超长思考副本：块尾也不留带标签的正文', blockEndProse.length === 0);
  check(
    'v0.17.1 超长思考副本：思考搬到了 reasoning 通道',
    out2.some((c) => c.type === 'reasoning-delta' && (c.text || '').includes('thinking')),
  );
}

// ── v0.19：格式归因 + 失败定位 + 工具调用 lint ─────────────
{
  const M = '\uFF5C' + 'DSML' + '\uFF5C';
  const T = (s) => `<${M} ${s}>`;
  const TC = (s) => `</${M} ${s}>`;
  const ALLOW = ['ops_bash', 'ops_grep'];

  // classifyFormat：一眼看出这次是哪种毛病
  check('v0.19 format: 空', classifyFormat('   ') === 'empty');
  check('v0.19 format: 普通正文', classifyFormat('今天天气不错') === 'no_dsml');
  check('v0.19 format: 字面思考标签', classifyFormat('想了想</thinking>') === 'think_tag');
  check('v0.19 format: 只有闭合标签', classifyFormat(`\n${TC('invoke')}\n${TC('calls')}`) === 'closed_only');
  check('v0.19 format: 只有标签', classifyFormat(`${T('invoke name="a"')}${TC('invoke')}`) === 'tags_only');
  check('v0.19 format: 正文+标签', classifyFormat(`先看一眼\n${TC('invoke')}`) === 'prose_plus_tags');
  check(
    'v0.19 format: 参数值不算正文',
    classifyFormat(`${T('parameter name="x"')}value${TC('parameter')}`) === 'param_without_invoke',
  );
  check('v0.19 format: 竖线退化', classifyFormat(`<|DSML invoke>` ) === 'single_pipe');
  check('v0.19 format: 未闭合 invoke', classifyFormat(`${T('invoke name="a"')}`) === 'unclosed_invoke');

  // parseLeakedCalls：失败要能定位
  const okCall = parseLeakedCalls(
    `${T('invoke name="ops_grep"')}${T('parameter name="q"')}x${TC('parameter')}${TC('invoke')}`,
    ALLOW,
  );
  check('v0.19 rescue: 解析成功', okCall.ok === true && okCall.calls.length === 1);
  check('v0.19 rescue: 带 format', okCall.format === 'tags_only');
  check('v0.19 rescue: 带 lint 数组', Array.isArray(okCall.lint) && okCall.lint.length === 0);

  const bad1 = parseLeakedCalls(`随便说说 ${TC('parameter')}`, ALLOW);
  check('v0.19 diag: unpaired_param', bad1.reason === 'unpaired_param');
  check('v0.19 diag: 记了偏移', typeof bad1.diag?.at === 'number' && bad1.diag.at > 0);
  check('v0.19 diag: 记了标签名', bad1.diag?.tag === '/parameter');
  check('v0.19 diag: 记了现场', String(bad1.diag?.excerpt || '').includes('随便说说'));
  check('v0.19 diag: format 同步', bad1.format === 'prose_plus_tags');

  const bad2 = parseLeakedCalls('<hello></hello>', ALLOW);
  check('v0.19 diag: no_tag 记 dsmlTags=0', bad2.reason === 'no_tag' && bad2.diag?.dsmlTags === 0);

  const bad3 = parseLeakedCalls(`${T('invoke name="nope"')}${TC('invoke')}`, ALLOW);
  check('v0.19 diag: unknown_tool 记工具名', bad3.reason === 'unknown_tool' && bad3.diag?.tool === 'nope');
  check('v0.19 diag: unknown_tool 记白名单', bad3.diag?.allowed === 2);

  // lintToolCalls：AGENTS.md 里能静态看出来的坑
  const l1 = lintToolCalls([{ name: 'read', arguments: '{"path":"a"}' }]);
  check('v0.19 lint: 已移除工具名', l1[0]?.code === 'removed_tool_name' && /ops_inspect_local_file/.test(l1[0].detail));
  check(
    'v0.19 lint: bash 递归 grep',
    lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: 'grep -rn "x" /c/Users/a' }) }])
      .some((h) => h.code === 'recursive_grep_in_bash'),
  );
  check(
    'v0.19 lint: heredoc',
    lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: "python - <<'PY'\nprint(1)\nPY" }) }])
      .some((h) => h.code === 'shell_heredoc'),
  );
  check(
    'v0.19 lint: 花括号 glob',
    lintToolCalls([{ name: 'ops_grep', arguments: JSON.stringify({ glob: ['**/*.{js,ts}'] }) }])
      .some((h) => h.code === 'brace_glob'),
  );
  check(
    'v0.19 lint: 代理缺 --noproxy',
    lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: 'curl -x http://127.0.0.1:8866 http://e.com' }) }])
      .some((h) => h.code === 'proxy_noproxy_missing'),
  );
  check(
    'v0.19 lint: 带了 --noproxy 不报',
    lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: 'curl --noproxy "" -x http://127.0.0.1:8866 http://e.com' }) }])
      .every((h) => h.code !== 'proxy_noproxy_missing'),
  );
  check(
    'v0.19 lint: 字面思考标签',
    lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: 'echo ' + '<' + 'thinking>' }) }])
      .some((h) => h.code === 'literal_dsml_mark'),
  );
  check('v0.19 lint: 干净调用零命中', lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: 'ls' }) }]).length === 0);
  check('v0.19 lint: 规则表十条', Object.keys(TOOLCALL_RULES).length === 10);
  check(
    'v0.19 lint: ops_grep 不给 path 不误报',
    lintToolCalls([{ name: 'ops_grep', arguments: JSON.stringify({ pattern: 'x' }) }]).length === 0,
  );
  check(
    'v0.19 lint: ops_grep path 给到根',
    lintToolCalls([{ name: 'ops_grep', arguments: JSON.stringify({ pattern: 'x', path: '/c/Users/a' }) }])
      .some((h) => h.code === 'broad_grep_path'),
  );
  check(
    'v0.19 lint: ops_grep 无排除 glob',
    lintToolCalls([{ name: 'ops_grep', arguments: JSON.stringify({ pattern: 'x', path: 'src', glob: ['**/*.js'] }) }])
      .some((h) => h.code === 'grep_without_exclude'),
  );
  check(
    'v0.19 lint: ops_grep 带排除不报',
    lintToolCalls([{ name: 'ops_grep', arguments: JSON.stringify({ pattern: 'x', path: 'src', glob: ['**/*.js', '!**/node_modules/**'] }) }])
      .every((h) => h.code !== 'grep_without_exclude'),
  );
  check(
    'v0.19 lint: PS 里 $env: 会被 bash 吃掉',
    lintToolCalls([{ name: 'ops_bash', arguments: JSON.stringify({ command: "powershell -Command 'echo $env:PATH'" }) }])
      .some((h) => h.code === 'ps_dollar_expansion'),
  );
  check(
    'v0.19 lint: run_code 顶层 let',
    lintToolCalls([{ name: 'run_code', arguments: JSON.stringify({ code: 'let x = 1;\nconsole.log(x);' }) }])
      .some((h) => h.code === 'runcode_toplevel_let'),
  );

  // 端到端：日志里必须真的出现 format / diag / lint
  const e2eLog = `${process.env.TEMP || '.'}/dsml-v019-test-${Date.now()}.log`;
  const leakBody = `${T('invoke name="ops_bash"')}${T('parameter name="command"')}ls${TC('parameter')}${TC('invoke')}`;
  const handlers3 = {};
  apply(
    { logger: { info: () => {}, warn: () => {} }, on: (e, f) => { handlers3[e] = f; }, set: () => {} },
    { enabled: true, leakAction: 'rescue', logFile: e2eLog },
  );
  async function* leakStream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: leakBody };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: leakBody } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const out3 = [];
  for await (const c of handlers3['llm/stream']({ provider: 'relay', model: 'v019', tools: [{ name: 'ops_bash' }] }, leakStream)) {
    out3.push(c);
  }
  check('v0.19 e2e: 救回工具调用', out3.some((c) => c.type === 'block-end' && c.block?.type === 'tool-call'));
  const rows = (await readFile(e2eLog, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const rescuedRow = rows.find((r) => r.kind === 'rescued');
  check('v0.19 e2e: rescued 带 format', rescuedRow?.format === 'tags_only');
  check('v0.19 e2e: rescued 带 lint', Array.isArray(rescuedRow?.lint));
}


// ── v0.20 holdback：流式扣留 / 跨块回溯 ──────────────────
{
  const B = '｜';
  const M = B + 'DSML' + B;
  const tag = (s) => '<' + M + ' ' + s + '>';
  const close = (s) => '</' + M + ' ' + s + '>';
  const tmp = (n) => (process.env.TEMP || '.') + '/' + n;
  const mkH = (cfg) => {
    const h = {};
    const lg = tmp('dsml-v20-' + Math.random().toString(36).slice(2) + '.log');
    apply(
      { logger: { info: () => {}, warn: () => {} }, on: (e, f) => (h[e] = f), set: () => {} },
      { enabled: true, logFile: lg, ...cfg },
    );
    return { h, lg };
  };
  const drain = async (w) => { const g = []; for await (const c of w) g.push(c); return g; };
  const callsOf = (got) => got.filter((c) => c.block && c.block.type === 'tool-call');
  const textOf = (got) => got.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');

  const body =
    '这是回答。\n' +
    tag('invoke name="read" string="true"') + '\n' +
    tag('parameter name="path" string="true"') + 'a.txt' + close('parameter') + '\n' +
    close('invoke') + '\n' + close('calls');

  // 1) 单测：StreamHoldback 纯文本零扣留、零延迟
  {
    const hb = new StreamHoldback();
    const out = hb.feed('你好，我去看看日志。');
    check('v0.20 扣留：纯正文立刻下发', out.join('') === '你好，我去看看日志。');
    check('v0.20 扣留：纯正文不记账', hb.stats().held === 0 && hb.stats().gaveUp === 0);
  }

  // 2) 单测：半截标记先扣住，补齐后放行
  {
    const hb = new StreamHoldback();
    const first = hb.feed('说到这' + B);
    check('v0.20 扣留：半截竖线先不发', first.join('') === '说到这');
    const rest = hb.feed(B + 'DSML' + B + ' invoke name="read">');
    check('v0.20 扣留：补齐后仍扣着（可能是调用）', rest.join('') === '');
    const tail = hb.flush(true).join('');
    check('v0.20 扣留：收口时原样吐出，不吞字', tail.includes(M) && tail.includes('name="read"'));
  }

  // 3) 单测：超上限一律放行（有界，不吞内容）
  {
    const hb = new StreamHoldback({ maxHold: 64 });
    const out = hb.feed(B + B + 'DSML' + B + ' invoke name="read">' + 'x'.repeat(200)).join('');
    check('v0.20 扣留：超 maxHold 放行', out.length > 64 && hb.stats().gaveUp >= 1);
  }

  // 4) 单测：块边界只携带「像调用」的尾巴
  {
    const hb = new StreamHoldback();
    // 只有竖线时也可能正在成形（`｜｜` + 下一块的 `DSML`）——先扣住，
    // 到块尾仍不成形就原样放行，正文最多晚一个 chunk。
    const before = hb.feed('正文结尾' + B + B);
    check('v0.20 扣留：竖线尾巴先不发', before.join('') === '正文结尾');
    check('v0.20 扣留：DSML 补齐后仍扣着', hb.feed('DSML').join('') === '');
    const r = hb.endBlock();
    check('v0.20 扣留：标记尾巴带进下一块', r.carried === B + B + 'DSML');
    check('v0.20 扣留：takeCarry 取走一次', hb.takeCarry() === B + B + 'DSML' && hb.takeCarry() === '');
    const hb2 = new StreamHoldback();
    hb2.feed('正文 <');
    check('v0.20 扣留：孤立尖括号不携带', hb2.endBlock().carried === '');
  }

  // 5) 跨块实证：旧行为必失败（闭合标签单独解析）
  {
    const cut = body.indexOf(close('parameter'));
    const first = body.slice(0, cut);
    const second = body.slice(cut);
    const old = parseLeakedCalls(second, ['read']);
    check('v0.20 跨块：旧行为单独解析失败', old.ok === false);
    check('v0.20 跨块：旧行为失败原因 unpaired_param', old.reason === 'unpaired_param');
    const merged = parseLeakedCalls(first + second, ['read']);
    check('v0.20 跨块：拼回完整后能解析', merged.ok === true && merged.calls.length === 1);
  }

  // 6) 端到端：块边界切开，新代码救回调用且正文不重复
  {
    const cut = body.indexOf(close('parameter'));
    const first = body.slice(0, cut);
    const second = body.slice(cut);
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: first },
      { type: 'block-end', index: 0, block: { type: 'text', text: first } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: second },
      { type: 'block-end', index: 1, block: { type: 'text', text: second } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v020', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    const calls = callsOf(got);
    check('v0.20 e2e：跨块切开仍救回 1 个调用', calls.length === 1);
    check('v0.20 e2e：工具名 read', calls[0] && calls[0].block.name === 'read');
    check('v0.20 e2e：参数 path=a.txt', (() => {
      try { return JSON.parse(calls[0].block.arguments).path === 'a.txt'; } catch { return false; }
    })());
    check('v0.20 e2e：正文只出现一次', (textOf(got).match(/这是回答。/g) ?? []).length === 1);
    check('v0.20 e2e：没有竖线残留', textOf(got).includes(B) === false);
    check('v0.20 e2e：finish 改写成 tool-calls', got.find((c) => c.type === 'finish').reason.kind === 'tool-calls');
  }

  // 7) 端到端：纯文本逐块透传（不慢、不变形、块数不减）
  {
    const chunks = ['好的，', '我去', '看看日志。'];
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...chunks.map((t) => ({ type: 'text-delta', index: 0, text: t })),
      { type: 'block-end', index: 0, block: { type: 'text', text: chunks.join('') } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v020', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.20 e2e：纯文本一字不差', textOf(got) === '好的，我去看看日志。');
    check('v0.20 e2e：纯文本块数不减', got.filter((c) => c.type === 'text-delta').length === 3);
    check('v0.20 e2e：纯文本不产调用', callsOf(got).length === 0);
  }

  // 8) 退化形态：`<` 与 DSML 字面都丢了，只剩竖线包元素名
  {
    const degraded =
      B + B + ' invoke' + B + B + ' name="' + B + B + ' read" string="true"' + B + B + '>' + '\n' +
      B + B + ' parameter' + B + B + ' name="path" string="true">b.txt' + B + B + '/parameter' + B + B + '>' + '\n' +
      B + B + '/invoke' + B + B + '>';
    check('v0.20 退化：能扫出标签', scanBareTags(degraded, CALL_TAG_NAMES).length === 4);
    const parsed = parseLeakedCalls(degraded, ['read']);
    check('v0.20 退化：解析成功', parsed.ok === true && parsed.calls.length === 1);
    check('v0.20 退化：工具名两头竖线被剥掉', parsed.ok === true && parsed.calls[0].name === 'read');
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: degraded },
      { type: 'block-end', index: 0, block: { type: 'text', text: degraded } },
    ];
    const { h } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v020', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.20 退化：端到端也救回', callsOf(got).length === 1);
  }

  // 10) v0.20.1：闭合标签本身不是调用证据，不再触发扣留
  {
    const prose = '我先看日志。</' + M + ' parameter>';
    const clean = '我先看日志。';
    const hb = new StreamHoldback();
    const out = hb.feed(prose);
    check('v0.20.1 闭合标签：正文立刻下发（标签被剥掉）', out.join('') === clean);
    check('v0.20.1 闭合标签：不构成风险点', hb.riskAt() === null);
    check('v0.20.1 闭合标签：不留 carry', hb.endBlock().carried === '');
    check('v0.20.1 闭合标签：reasons 里没有 unpaired', hb.stats().reasons.unpaired === undefined);
  }

  // 11) v0.20.1：开标签仍然扣（回归保护 —— 别把该等的那一半也放掉）
  {
    const open = '<' + M + ' invoke name="read">';
    const hb = new StreamHoldback();
    const out = hb.feed(open + '\n' + 'a.txt');
    check('v0.20.1 开标签：仍然扣住', out.join('') === '');
    check('v0.20.1 开标签：风险点是 tag', hb.riskAt() !== null && hb.riskAt().kind === 'tag');
    const drained = hb.drain(true);
    check('v0.20.1 开标签：final 原样放行不吞字', out.join('') + drained.join('') === open + '\n' + 'a.txt');
  }

  // 12) v0.20.1：散文里夹孤立闭合标签 + 真调用，端到端不因闭合标签多扣
  {
    const prose = '先看一眼。' + close('parameter') + ' 然后跑测试。';
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: prose },
      { type: 'block-end', index: 0, block: { type: 'text', text: prose } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v0201', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.20.1 e2e：正文照常下发（孤立闭合标签被剥掉）', textOf(got) === '先看一眼。 然后跑测试。');
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const held = rows.filter((r) => r.kind === 'holdback' && (r.held ?? 0) > 0);
    check('v0.20.1 e2e：没有因闭合标签扣字', held.length === 0);
  }

  // 13) v0.20.1-b：开标签在上一块、闭合在下一块 —— 回归底线，必须仍救回
  {
    const first = '这是回答。\n' + tag('invoke name="read" string="true"') + '\n' + tag('parameter name="path" string="true"') + 'a.t';
    const second = 'xt' + close('parameter') + '\n' + close('invoke') + '\n' + close('calls');
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: first },
      { type: 'block-end', index: 0, block: { type: 'text', text: first } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: second },
      { type: 'block-end', index: 1, block: { type: 'text', text: second } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v0201b', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    const calls = callsOf(got);
    check('v0.20.1-b 跨块：仍救回 1 个调用', calls.length === 1 && calls[0].block.name === 'read');
    check('v0.20.1-b 跨块：参数完整', (() => { try { return JSON.parse(calls[0].block.arguments).path === 'a.txt'; } catch { return false; } })());
    check('v0.20.1-b 跨块：正文不重复', (textOf(got).match(/这是回答。/g) ?? []).length === 1);
  }

  // 14) v0.20.1-c：开标签与闭合在同一块、中间隔着散文 —— 仍救回
  {
    const one = '这是回答。\n' + tag('invoke name="read" string="true"') + '\n中间还夹了一句散文。\n' +
      tag('parameter name="path" string="true"') + 'b.txt' + close('parameter') + '\n' + close('invoke') + '\n' + close('calls');
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: one },
      { type: 'block-end', index: 0, block: { type: 'text', text: one } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v0201c', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    const calls = callsOf(got);
    check('v0.20.1-c 同块：救回 1 个调用', calls.length === 1);
    check('v0.20.1-c 同块：参数 b.txt', (() => { try { return JSON.parse(calls[0].block.arguments).path === 'b.txt'; } catch { return false; } })());
    check('v0.20.1-c 同块：没有竖线残留', textOf(got).includes(B) === false);
  }

  // 15) v0.20.1-d：纯正文里的「小于号」是普通字符，不许当标签扣
  {
    const plain = '如果 a < b 就交换，n < 10 同理。';
    const hb = new StreamHoldback();
    const out = hb.feed(plain);
    check('v0.20.1-d 小于号：零扣留', out.join('') === plain);
    check('v0.20.1-d 小于号：零丢失', hb.stats().held === 0);
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: plain },
      { type: 'block-end', index: 0, block: { type: 'text', text: plain } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v0201d', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.20.1-d 小于号：端到端一字不差', textOf(got) === plain);
    check('v0.20.1-d 小于号：不触发 holdback', rows.filter((r) => r.kind === 'holdback' && (r.held ?? 0) > 0).length === 0);
  }

  // 16) v0.21-a：纯 reasoning 副本 → 下游一个字都不拿到，记 suppressed，整轮重取
  {
    const thought = '我先把日志读一遍，再决定改哪一行。这段思考足够长，能越过六十个字符的判据门槛。顺便把时间戳、provider、model 都对齐一遍，避免再看错行。这里再多写两句，确保长度稳稳超过六十个字符。';
    const leaked = thought + close('parameter') + close('invoke');
    const stream = [
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: leaked },
      { type: 'block-end', index: 0, block: { type: 'text', text: leaked } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v021a', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.21-a 纯副本：下游正文为空', textOf(got) === '');
    check('v0.21-a 纯副本：没有产出调用', callsOf(got).length === 0);
    check('v0.21-a 纯副本：终态是重取', (() => {
      const f = got.find((c) => c.type === 'finish');
      return Boolean(f && f.reason && f.reason.kind === 'error' && f.reason.failure && f.reason.failure.code === 'EMPTY_RESPONSE');
    })());
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const sup = rows.find((r) => r.kind === 'reasoningCopy-suppressed');
    check('v0.21-a 纯副本：有 suppressed 日志', Boolean(sup));
    check('v0.21-a 纯副本：日志字段齐', Boolean(sup) && sup.dropped === leaked.length && sup.format === 'prose_plus_tags'
      && sup.looksLikeReasoningCopy === true && typeof sup.proseLength === 'number' && sup.provider === 'khala');
    check('v0.21-a 纯副本：不写 rescue-failed', rows.filter((r) => r.kind === 'rescue-failed').length === 0);
  }

  // 17) v0.21-b：正文 + 副本片段混合 → 保留正文，不抑制
  {
    const thought = '我先把日志读一遍，再决定改哪一行。这段思考足够长，能越过六十个字符的判据门槛。顺便把时间戳、provider、model 都对齐一遍，避免再看错行。这里再多写两句，确保长度稳稳超过六十个字符。';
    const mixed = '这是真正的回答，跟思考没关系。\n' + thought + '（这一段是被复制进来的思考尾巴）';
    const stream = [
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: mixed },
      { type: 'block-end', index: 0, block: { type: 'text', text: mixed } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v021b', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.21-b 混合：正文保留', textOf(got).includes('这是真正的回答'));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.21-b 混合：不走抑制', rows.filter((r) => r.kind === 'reasoningCopy-suppressed').length === 0);
  }

  // 18) v0.21-c：正常调用不受影响
  {
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: body },
      { type: 'block-end', index: 0, block: { type: 'text', text: body } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v021c', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.21-c 正常调用：仍救回 1 个', callsOf(got).length === 1);
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.21-c 正常调用：不抑制', rows.filter((r) => r.kind === 'reasoningCopy-suppressed').length === 0);
    check('v0.21-c 正常调用：有 rescued 行', rows.filter((r) => r.kind === 'rescued' && r.dry !== true).length === 1);
  }

  // 19) v0.21-d：looksLikeReasoningCopy 为假 → 不误判（正文与思考完全不同）
  {
    const thought = '这是另一段完全不相干的思考内容，开头就对不上，长度也够但前缀不重合，所以判据必须给假。';
    const leaked = '完全不同的正文开头，和上面那段思考一个字都不重合，长度也够六十个字符了，这里再多写一些。' + close('parameter');
    const stream = [
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: leaked },
      { type: 'block-end', index: 0, block: { type: 'text', text: leaked } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v021d', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.21-d 非副本：正文不丢', textOf(got).includes('完全不同的正文开头'));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.21-d 非副本：不抑制', rows.filter((r) => r.kind === 'reasoningCopy-suppressed').length === 0);
  }

  // 20) v0.21-e：连续三轮同样输入 —— 每轮都抑制，输出恒定（幂等，不累积状态）
  {
    const thought = '我先把日志读一遍，再决定改哪一行。这段思考足够长，能越过六十个字符的判据门槛。顺便把时间戳、provider、model 都对齐一遍，避免再看错行。这里再多写两句，确保长度稳稳超过六十个字符。';
    const leaked = thought + close('parameter');
    const mk = () => [
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: leaked },
      { type: 'block-end', index: 0, block: { type: 'text', text: leaked } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push(await drain(h['llm/stream']({ provider: 'khala', model: 'v021e', tools: [{ name: 'read' }] }, () => fakeStream(mk()))));
    }
    check('v0.21-e 三轮：每轮正文都为空', runs.every((r) => textOf(r) === ''));
    check('v0.21-e 三轮：每轮都判重取', runs.every((r) => {
      const f = r.find((c) => c.type === 'finish');
      return Boolean(f && f.reason && f.reason.failure && f.reason.failure.code === 'EMPTY_RESPONSE');
    }));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.21-e 三轮：日志恰好 3 条', rows.filter((r) => r.kind === 'reasoningCopy-suppressed').length === 3);
  }

  // 21) v0.22-a：套话 + 工具调用 + 有思考 → 正文换成思考
  {
    const kan = '你好，我无法给到相关内容。';
    const think = '我先查一下这个会话的日志，再决定怎么回答他。';
    const stream = [
      { type: 'reasoning-delta', index: 0, text: think },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: kan },
      { type: 'block-end', index: 0, block: { type: 'text', text: kan } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{"code":"1"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v022a', tools: [{ name: 'run_code' }] }, () => fakeStream(stream)));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const cr = rows.find((r) => r.kind === 'canned-refusal');
    check('v0.22-a 套话：正文换成思考', textOf(got).trim() === think);
    check('v0.22-a 套话：套话没泄出去', !textOf(got).includes('无法给到'));
    check('v0.22-a 套话：日志 shown=reasoning', cr?.shown === 'reasoning' && cr?.action === 'reasoning-as-text');
    check('v0.22-a 套话：工具调用没丢', callsOf(got).length === 1);
    check('v0.22-a 套话：收尾改成 tool-calls', got.find((c) => c.type === 'finish')?.reason?.kind === 'tool-calls');
  }

  // 22) v0.22-b：套话 + 工具调用 + 思考是空的（生产现场就是 `" "`）→ 一个字都不给
  {
    const kan = '你好，我无法给到相关内容。';
    const stream = [
      { type: 'reasoning-delta', index: 0, text: ' ' },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: kan },
      { type: 'block-end', index: 0, block: { type: 'text', text: kan } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c2', name: 'run_code', arguments: '{"code":"2"}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v022b', tools: [{ name: 'run_code' }] }, () => fakeStream(stream)));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const cr = rows.find((r) => r.kind === 'canned-refusal');
    check('v0.22-b 空思考：正文为空', textOf(got).trim() === '');
    check('v0.22-b 空思考：日志 shown=nothing', cr?.shown === 'nothing' && cr?.action === 'suppressed-silent');
    check('v0.22-b 空思考：工具调用保留', callsOf(got).length === 1);
  }

  // 23) v0.22-c：套话但这一轮没干活 → 原样放行（真拒绝不许我们改口）
  {
    const kan = '你好，我无法给到相关内容。';
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: kan },
      { type: 'block-end', index: 0, block: { type: 'text', text: kan } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v022c', tools: [{ name: 'run_code' }] }, () => fakeStream(stream)));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const cr = rows.find((r) => r.kind === 'canned-refusal');
    check('v0.22-c 真拒绝：原文放行', textOf(got).trim() === kan);
    check('v0.22-c 真拒绝：日志 shown=passthrough', cr?.shown === 'passthrough' && cr?.action === 'passthrough');
  }

  // 24) v0.22-d：带解释的长拒绝（>40 字）→ 不触发
  {
    const long = '抱歉，我确实没法帮你把这段付费课程的文字完整转录出来，因为那会侵犯作者的著作权；不过我可以给你讲讲它的整体结构，或者帮你找公开的替代材料。';
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: long },
      { type: 'block-end', index: 0, block: { type: 'text', text: long } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c4', name: 'run_code', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v022d', tools: [{ name: 'run_code' }] }, () => fakeStream(stream)));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.22-d 长拒绝：正文原样', textOf(got).includes('付费课程'));
    check('v0.22-d 长拒绝：不记 canned-refusal', rows.filter((r) => r.kind === 'canned-refusal').length === 0);
  }

  // 25) v0.22-e：连续三轮幂等（每轮都换成思考，日志正好 3 条）
  {
    const kan = '\n你好，我无法给到相关内容。';
    const think = '这一轮我先确认一下文件在不在。';
    const mk = () => [
      { type: 'reasoning-delta', index: 0, text: think },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: kan },
      { type: 'block-end', index: 0, block: { type: 'text', text: kan } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c5', name: 'run_code', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const runs = [];
    for (let i = 0; i < 3; i += 1) {
      runs.push(await drain(h['llm/stream']({ provider: 'khala', model: 'v022e', tools: [{ name: 'run_code' }] }, () => fakeStream(mk()))));
    }
    check('v0.22-e 三轮：每轮都换成思考', runs.every((r) => textOf(r).trim() === think));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.22-e 三轮：日志恰好 3 条', rows.filter((r) => r.kind === 'canned-refusal').length === 3);
    check('v0.22-e 三轮：每轮 shown 都是 reasoning', rows.filter((r) => r.kind === 'canned-refusal').every((r) => r.shown === 'reasoning'));
  }

  // 26) v0.22-f：与副本判据无关（正文不是思考的前缀也一样换）
  {
    const kan = '我无法提供相关内容';
    const think = '完全不同的思考内容，和那句套话一个字都不重合。';
    const stream = [
      { type: 'reasoning-delta', index: 0, text: think },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: kan },
      { type: 'block-end', index: 0, block: { type: 'text', text: kan } },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c6', name: 'run_code', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ];
    const { h, lg } = mkH({ leakAction: 'rescue' });
    const got = await drain(h['llm/stream']({ provider: 'khala', model: 'v022f', tools: [{ name: 'run_code' }] }, () => fakeStream(stream)));
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    check('v0.22-f 与副本判据无关：仍换', textOf(got).trim() === think);
    check('v0.22-f 与副本判据无关：有 canned-refusal', rows.some((r) => r.kind === 'canned-refusal'));
  }

  // 9) observe 档：影子救援只记账，不改流
  {
    const stream = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: body },
      { type: 'block-end', index: 0, block: { type: 'text', text: body } },
    ];
    const { h, lg } = mkH({});
    const got = await drain(h['llm/stream']({ provider: 'relay', model: 'v020', tools: [{ name: 'read' }] }, () => fakeStream(stream)));
    check('v0.20 observe：不产出 tool-call', callsOf(got).length === 0);
    check('v0.20 observe：正文原样下发', textOf(got) === body);
    const rows = (await readFile(lg, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    const shadow = rows.find((r) => r.kind === 'rescued' && r.dry === true);
    check('v0.20 observe：记了 dry rescued', Boolean(shadow));
    check('v0.20 observe：dry 行带 names', Boolean(shadow) && shadow.names.includes('read'));
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
