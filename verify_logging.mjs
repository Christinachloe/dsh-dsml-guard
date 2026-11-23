#!/usr/bin/env node
/**
 * 验证 dsml-guard 的日志落盘与「启动留痕」。
 *
 * 用法：
 *   node verify_logging.mjs [日志路径]
 *
 * 步骤：
 *   1. 清掉旧日志（如果存在）
 *   2. 直接调 apply() 注册监听（用一个假 ctx / 假 llm 服务）
 *   3. 断言日志里出现 kind=boot
 *   4. 灌一段「纯残片」的流，断言出现 kind=leak
 *   5. 灌一段正常文本，断言不产生新的 leak
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { apply, isPureDsmlFragment, chunkText } from './index.js';

const LOG = process.argv[2] || './logs/verify-dsml-guard.log';

if (existsSync(LOG)) rmSync(LOG);

const listeners = [];
const fakeCtx = {
  logger: {
    info: () => {},
    warn: () => {},
  },
  on(event, fn) {
    if (event === 'llm/stream') listeners.push(fn);
  },
};

// 注册
apply(fakeCtx, { enabled: true, logFile: LOG });

let pass = 0;
let fail = 0;
function check(label, ok) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}`);
  }
}

// 1. boot 留痕
const bootLines = existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n') : [];
const boot = bootLines.map((l) => JSON.parse(l)).find((r) => r.kind === 'boot');
check('apply() 写入 kind=boot', Boolean(boot));
check('boot 记录带 version', typeof boot?.version === 'string' && boot.version.length > 0);
check('boot 记录带 pid', typeof boot?.pid === 'number');
check('boot 记录 enabled=true', boot?.enabled === true);

// 2. 监听已注册
check('llm/stream 监听已注册', listeners.length === 1);

// 3. 残片流 → 记一条 leak
const leakChunks = [
  { type: 'text-delta', index: 0, text: '\n' },
  { type: 'text-delta', index: 0, text: '</｜｜DSML｜｜ invoke>' },
  { type: 'text-delta', index: 0, text: '\n</｜｜DSML｜｜ calls>' },
];
const makeStream = (chunks) => ({
  async *[Symbol.asyncIterator]() {
    for (const c of chunks) yield c;
  },
});

async function run(chunks, opts = { provider: 'relay-a', model: 'deepseek-v4.1-flash-1017' }) {
  const wrapped = listeners[0](opts, () => makeStream(chunks));
  const seen = [];
  for await (const c of wrapped) seen.push(c);
  return seen;
}

const seenLeak = await run(leakChunks);
check('残片流逐块透传（不吞不改）', JSON.stringify(seenLeak) === JSON.stringify(leakChunks));

const afterLeak = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const leaks = afterLeak.filter((r) => r.kind === 'leak');
check('残片流产生 1 条 kind=leak', leaks.length === 1);
check('leak 记录 provider', leaks[0]?.provider === 'relay-a');
check('leak 记录 model', leaks[0]?.model === 'deepseek-v4.1-flash-1017');
check('leak 记录 snippet', typeof leaks[0]?.snippet === 'string' && leaks[0].snippet.includes('DSML'));

// 4. 正常流不误报
const normalChunks = [
  { type: 'text-delta', index: 0, text: '我们今天讨论了' },
  { type: 'text-delta', index: 0, text: '｜｜DSML｜｜ 这个标记的来历。' },
];
const seenNormal = await run(normalChunks);
check('正常文本逐块透传', JSON.stringify(seenNormal) === JSON.stringify(normalChunks));
const afterNormal = readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
check('正常文本不新增 leak', afterNormal.filter((r) => r.kind === 'leak').length === 1);

// 5. 纯函数回归
check('isPureDsmlFragment 纯残片=true', isPureDsmlFragment('\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>'));
check('isPureDsmlFragment 正常文本=false', !isPureDsmlFragment('今天聊到 ｜｜DSML｜｜ 的来历'));
check('chunkText text-delta', chunkText({ type: 'text-delta', text: 'x' }) === 'x');
check('chunkText reasoning 不看', chunkText({ type: 'reasoning-delta', text: 'x' }) === null);

console.log(`\n${pass} passed, ${fail} failed`);
console.log(`日志文件: ${LOG}`);
if (existsSync(LOG)) {
  console.log('--- 日志内容 ---');
  console.log(readFileSync(LOG, 'utf8').trim());
}
process.exit(fail === 0 ? 0 : 1);
