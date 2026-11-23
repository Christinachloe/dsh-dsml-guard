# Changelog

Versions before 0.14 were developed as a private plugin mounted by absolute path;
the numbers below are the plugin's own `GUARD_VERSION`, which every boot line records.

## 0.22.0 — 2026-11-23

**为什么改：模型这一轮明明干了活（工具调用正常执行、结果正常），正文却被换成一句固定套话。**

现场（会话 `f7bf07df`，5 次）：content 是
`[text: "你好，我无法给到相关内容。"][reasoning: " "][tool-call: run_code …]` ——
**reasoning 只有一个空格**，但工具调用真的跑成功了。所以这不是「模型拒绝」，
是**正文被上游替换**：把 reasoning 摘走、塞一句拒绝语，调用照旧留下。

关键判断（推翻了最初的方案）：既然 reasoning 是空的，
「保留 reasoning 作为可见正文」在现场等于什么都不显示；
而「当作 `EMPTY_RESPONSE` 重取」会丢掉一次已经成功的工具调用、白等 30 秒。
所以取**按有无思考分流**：

1. **判据**（`index.js`，插在 `looksLikeReasoningCopy` 之前）：
   - `CANNED_REFUSALS` 7 条固定串（含这句、`抱歉，我无法提供…` 等）；
   - 泛化形状 `^(?:你好|抱歉|对不起)?[，,]?(?:我)?(?:无法|不能|不便|恕不)(?:给到|提供|回答|协助|满足|回应|帮助)[^。]{0,12}(?:内容|信息|请求|问题)?[。.]?# Changelog

Versions before 0.14 were developed as a private plugin mounted by absolute path;
the numbers below are the plugin's own `GUARD_VERSION`, which every boot line records.

，
     只在**去空白后 12–40 字**时生效（更短像语气词，更长像真解释）；
   - `isCannedRefusalPrefix()` 供流式提前扣住，避免半句先漏出去。
2. **「被替换」必须同时满足三条**：① 这一轮真有工具调用（`hasToolCall` 或 `rescuedCalls > 0`）；
   ② 正文去空白 ≤ 24 字；③ reasoning **不以**它开头（同源就不是替换）。
   三条缺一条都按「模型真拒绝」原样放行 —— **守卫不许替模型改口**。
3. **分流**（`finish` 里，放在 `rescuedCalls > 0` 分支之前）：
   - 有思考（`thought` 非空）→ 把思考当正文发出去，`reason` 改 `tool-calls`，
     日志 `shown:"reasoning"` / `action:"reasoning-as-text"`；
   - 没思考 → **一个字都不发**，日志 `shown:"nothing"` / `action:"suppressed-silent"`
     （总比让用户以为我真的拒绝了强）；
   - 不是替换 → 原样补发，日志 `shown:"passthrough"`。
4. **踩到的坑（重要）**：`hasToolCall` 原先只在 `block-start blockType==='tool-call'`
   或 `tool-call*` chunk 上置位，**实测上游可能只给 `block-end` 不给 `block-start`**
   （会话 `f7bf07df` 就是这样），于是「这一轮干了活」被误判成「没干活」，
   套话当成真拒绝放给用户。补一条 `block-end && block.type==='tool-call'` 即修复。

实测：`node test.mjs` 307 → **324 passed / 0 failed**（新增 17 条：a 有思考→换成思考、
b 空思考→一个字不发、c 没调用→原样放行、d 长拒绝不触发、e 三轮幂等、f 与副本判据互不干扰）；
`verify_logging.mjs` 16 passed；`指挥部/acceptance-dsml.sh` **27 通过 / 0 失败**；
`probe_holdback.mjs` 9 通过 / 0 失败。

同夹具对比（`leakAction` 两档都试）：

| 版本 | 正文 | 日志 |
|---|---|---|
| `dsml-guard` v0.16（deskweb 副本） | `你好，我无法给到相关内容。` | `boot, active` |
| `dsml-guard-rescue` v0.22 | `我先查一下这个会话的日志，再决定怎么回答他。` | `boot, active, canned-refusal` |

怎么读日志：**有 `canned-refusal` 且 `shown:"reasoning"`/`"nothing"` = 上游替换了正文；
没有这条 = 模型真的拒绝**（那就不该动它）。

## 0.21.0 — 2026-11-23

**为什么改：用户看到的「tool call 报错」，79% 不是他自己写错，是上游把思考复制进了正文。**

量化（2026-11-23，近 4 小时）：10 条 `rescue-failed` **全部**是 reasoning 副本，
与同刻 `leak` snippet 相似度 0.89–1.00、`Δt=0.0s`，没有一处有效载荷；全量 224 条
`intercepted` 里 **172 条 `reasoningCopy:true`（79%）**，累计丢 **273,944 字**，
全部落在 `khala/deepseek-v4.1-flash-1017`。

旧路径的后果：识别 → 截断 → `rescue` 解析失败 → **把半截正文吐给前端** → 整轮作废 → 重取。
用户看到的是「怎么又报错了」，实际是「上游污染 + 我们吐残渣」。

1. **纯副本不再吐半截正文**：`looksLikeReasoningCopy()`（已有判据，不新造启发式）判真、
   且 `classifyFormat()` 落在 `prose_plus_tags` / `param_without_invoke`
   这类「散文里散落标签」的形态时，整块直接抑制 —— 下游一个字都不拿到。
2. **复用既有重取通道**：不新起定时器、不自己重发 HTTP，走 `failureChunk()`
   的 `EMPTY_RESPONSE`（v0.12 就有的「这一步什么都没产出，重跑」那条路）。
3. **抑制点放在 `passText` 开头、`asm.push(text)` 之前**：块尾才知道全文，
   但那时半截正文已经发出去了，「不吐残句」就做不到。副本是**前缀重合**，
   第一批 delta 就能判；`asm` 里已含这段文本，push 之后再拼 `sofar` 会重复一遍、
   前缀比对必然失配（第一版就是这么没触发的）。
4. **混合内容不动**：正文里既有真话又夹副本片段的，判据给假，照旧走清洗，
   不许被新路径吞掉（有 fixture）。
5. **新增日志 `kind:"reasoningCopy-suppressed"`**：字段 `dropped` / `proseLength` /
   `format` / `diagTag` / `diagAt` / `looksLikeReasoningCopy` / `thoughtLength` /
   `action:"retry"` / `reason` / `hold`。**看 `kind` 就能分辨是谁的锅**：
   有这一条 = 上游污染；没有、只有 `rescue-failed` = 真 tool call 格式错。
   抑制路径**不写** `rescue-failed`（否则同一件事记两遍，反而看不出区别）。

实测：`node test.mjs` 291 → **307 passed / 0 failed**（新增 16 条：纯副本空输出 + 日志、
混合保留正文、正常调用不受影响、判据为假不误判、连续三轮幂等）；
`node verify_logging.mjs` **16 passed**；`bash 指挥部/acceptance-dsml.sh` **22/22**；
`node 指挥部/qa/probe_holdback.mjs` **9/9**。

## 0.20.1 — 2026-11-23

**为什么收紧：0.20.0 上线 31 分钟后，生产日志里 `unpaired` 类扣留是净亏。**
上线后两条 `holdback`（`where:"finish"`）把 **12,532 字**压到块尾才吐
（`held 2995 / 9537`；最大一块 10,466 字里压掉 9,537 = **91%**），同期 `rescued` 仍然是 **0**。
复盘 5,024 行日志里的 57 条 `unpaired*`：`diag.openInvoke` / `openParam` **57/57 为 `null`**，
失败点离文本末尾只有 21–134 字，撞的标签 21/21 是 `/parameter` ——
形态是「英文散文 + 末尾贴的闭合标签」，**没有一条是调用被切断**。

1. **判据改成「闭合标签本身不是调用证据，开标签才是」**：`riskAt()` 不再把孤立的
   闭合标签（`kind: 'unpaired'`）当风险点；只有缓冲区里真的开着一条 `invoke`/`parameter`
   才从开标签处扣留。真调用片段一定带未闭合开标签，那条路一点没松。
2. **下发前剥掉孤立闭合标签**（`stripCloserTags`）：不扣留不等于把 `</｜DSML｜ parameter>`
   甩给用户看。`drain()` 里的 `push()` 只剥完整闭合标签，散文一个字不动。
3. 跳过整条闭合标签而不是只跳过 `<`：标签内部自带 `｜DSML｜` 标记，只跳 `<`
   会在下一个竖线处再判出 `marker`，等于绕个弯又扣住（第一版就栽在这，4 条用例当场红）。

实测（`scratch` 复刻，已删）：21 条生产样本形态 422 字，旧规则从首个闭标签起扣 194 字、
新规则扣 0；复刻 02:08 那一块（`chunk.repeat(1229)` = 38,099 字 / 1,229 个闭标签），
新规则 `held=0`、`reasons={}`、下发 14,748 字（差值是剥掉的标签）、无竖线残留。
`node test.mjs` 272 → **291 passed / 0 failed**。

## 0.20.0 — 2026-11-23

**为什么改：`rescue` 从上线到 0.19 一共 99 次失败、0 次成功。** 原因不是解析器写错了，
而是它站错了位置：`unpaired_param`（35 条）的意思是「闭合标签来了，开标签不在这一段里」——
开标签早在上一块就发出去了。等整块结束再解析，注定只能看见半截。
`no_tag`（59 条）更直接：正文里根本没有标记。**要救回来，就得在流还活着的时候扣住。**

1. `StreamHoldback`：块边界把「可能成形的调用片段」扣住 —— 半截竖线（`｜`/`｜｜`）、
   `｜｜DSML`、`<｜｜DSML｜｜ …`、以及已经开出来还没闭合的 `invoke`/`parameter`。
   补齐了就送解析；到块尾还缺、或超过 `maxHold`（8192 字）就**原样放行**，绝不吞字。
   纯正文零延迟：`HOLDBACK_TAIL = 0`。
2. 跨块回溯：`endBlock()` 把尾巴交给 `takeCarry()`，下一块解析输入 = carry + `block.text`。
   开标签在上一块、闭合标签在下一块，这条以前必失败的路现在能救回。
3. 退化标签 `scanBareTags()`：`<` 和 DSML 字面都被 relay 吃掉时（`｜｜ invoke｜｜ name="…"`），
   只要元素名已知、两侧有竖线，照样认。
4. 工具名两头粘着的竖线会被剥掉再比白名单（`｜｜ invoke` → `invoke`），
   不因为标记没洗干净就落到 `unknown_tool`。
5. `observe` 档新增**影子救援**：只解析、只记 `{"kind":"rescued","dry":true}`，
   一个字节都不改流 —— 不配 rescue 也能量出「本来能救回多少」。
6. `rescued-noise`：`unpaired_param`/`closed_only` 这类「其实不是调用」的残片，
   剥掉标签后正文照发，不再让整轮落到失败分支。
7. 日志新增 `kind:"holdback"`（扣留统计）与 `rescued.dry/mode`；`diag` 沿用 v0.19。

实测（本机）：`node test.mjs` 241 → **272 passed / 0 failed**；`verify_logging.mjs` 0 failed；
`指挥部/acceptance-dsml.sh` **22/22**；总指挥独立探针 `qa/probe_holdback.mjs` **9/9**。

## 0.19.0 — 2026-11-23

**把「拦了一条」变成「这次是什么毛病」。** 日志里 95 条 `rescue-failed` 只有
`reason` + 正文前 160 字：`no_tag` 占 59 条，到底是「压根没有标记」还是「有标记但标签名
不认识」，翻日志看不出来；`unpaired_param` 占 32 条，撞在哪个标签、第几个字符上，
必须把整段正文拿回来重放才能定位。

三个新增，全部只记不改流：

1. `classifyFormat(text)` → 日志 `format` 字段，短码归因：
   `empty` / `no_dsml` / `think_tag` / `single_pipe` / `param_without_invoke` /
   `closed_only` / `unclosed_invoke` / `tags_only` / `prose_plus_tags`。
   `single_pipe` 专指竖线退化（`｜DSML` / `DSML｜`），这正是 v0.13 之前整条漏过的形态。
2. `parseLeakedCalls` 的失败带 `diag`：`{at, tag, tokens, excerpt, openInvoke, openParam, tool, allowed, dsmlTags}`。
   `no_tag` 顺手记 `dsmlTags`（正文里 DSML 标记的个数）——0 表示真的没有标记，
   >0 表示有标记但标签名不认识。
3. `lintToolCalls(calls)` → `rescued` 日志的 `lint` 字段：把 AGENTS.md
   「工具调用避错」表里**能静态看出来**的坑，在调用落地那一刻标出来。
   现有 10 条：`removed_tool_name`（pwsh/read/grep/glob 这些已移除的别名）、
   `recursive_grep_in_bash`、`shell_heredoc`、`literal_dsml_mark`、
   `brace_glob`、`proxy_noproxy_missing`、`broad_grep_path`（path 给到盘符根）、
   `grep_without_exclude`（没带排除 glob）、`ps_dollar_expansion`（`$_`/`$env:` 被 bash 先展开）、
   `runcode_toplevel_let`（run_code 顶层 let/const 重名）。
   只标不拦，调用照常执行。

测试 203 → 241 项（新增 38 项：归因码 9、失败定位 8、lint 15、端到端日志字段 6）。

**历史体检结论（改造前 4,870 行日志）：** `rescue-failed` 98 条、`rescued` **0 条** ——
rescue 上线以来一次都没成功救回，实际效果等于「带日志的 retry」。分布：
`no_tag` 59（正文压根没有标记，说明是普通文本被丢进解析器）、`unpaired_param` 35
（样本全是英文思考散文，即「正文=思考副本」+ 残片）。这条结论是 v0.19 加 `format`/`diag`
的直接原因：老日志看不出这些差别。

## 0.18.0 — 2026-11-22

**标签白名单改成反向规则。** 会话 `db4a9114` 又漏一条：正文以 `<quick_check>` 开头、1,213 字，
`tagKindOf` 不认识这个名字，整段当正文下发。这一天里陆续见到的名字还有 `remaining_text`、
`checkpoint`、`compression`、`success`、`agent`、`parameter name="…"` —— 每加一个新名字都要等
下一次漏出来。

现在反过来：正文块**开头**的 `<name>`，只要 `name` 不是已知 HTML 标签，就一律当内部标签，
搬进 reasoning 通道（不整块丢，思考内容用户还能展开看）。`<https://…>` 这类自动链接和
`<div>`/`<br>` 这些真 HTML 原样放行 —— 名字后面必须紧跟 `>`、空白或 `/` 才算标签。

用 20 个会话里捞到的 10 条真实样本回放：10/10 正文 0 字。测试 197 → 203 项。

## 0.17.1 — 2026-11-22

**块尾搬完思考，扣留缓冲又把它补发了一次。** delta 本身就超过 1,200 字扣留上限时，缓冲里已经
存着整段；`passBlockEnd` 把 `block.text` 搬进 reasoning 通道后没清缓冲，`finalize()` 结尾又把
缓冲当正文吐出去。用会话 `47055cea` 真实那 3,147 字回放，修复前 `proseOut: 3147 / closersOut: 114`，
修复后 `0 / 0`。修法是 think 与 draft 两个分支在 return 前清 `held`（`block.text` 才是权威副本）。
新增回归用例：400 字一片的 delta 洪水块必须产出 0 字正文。测试 194 → 197 项。

## 0.17.0 — 2026-11-22

**连发的游离闭合标签会让思考整段漏进正文。** 会话 `47055cea` 19:28:35 那条消息：
正文 3,147 字，开头是 `</thinking>` 连写 **114 次**、一个开标签都没有，后面接 1,756 字继续思考的
英文（"Plan: patch readiness check…"）。原因有两层：`probeInternalTag` 与 `splitBlockText` 的
`/<\s*([A-Za-z]…)/` 都要求 `<` 后面跟字母，而 `</thinking>` 的第二字符是 `/`，这类闭标签从来
没被认出来；等持有量超过 1,200 字上限时，放行前的两道检查（`looksLikeReasoningCopy`、
`isInternalTagSoup`）都不成立，于是整段按普通正文下发。

- 新增导出 `countStrayInternalClosers(text)` / `dropStrayInternalClosers(text)`：按标签族记开标签
  深度，找不到配对的闭标签算「游离」；后者把它们剥掉。
- `passText` 放行前增加闸门：持有文本里游离闭标签 ≥ `STRAY_CLOSER_MIN`（3）就继续扣住。
- `passBlockEnd` 先剥游离闭标签再切分；剥完剩下的正文也**按思考处理**（≥3 个游离闭标签时整块搬进
  reasoning 通道）——回答不会闭合一个从未打开过的标签。
- `noteRethink` 去重：同一个块只记一条 `rethink`。此前 `handleBlockEnd` 记一次、`finish` 又记一次，
  日志里成对出现（相差 1–2ms），看起来像「重复报 think」。
- 测试 175 → 194 项；新 fixture `fixtures/stray-closer-flood.json`（合成正文 + 114 个真闭标签）。

## 0.16.0 — 2026-11-22

**rescue 装着但从未生效。** 0.15 的 rescue 分支只看「块文本是字符串」，于是每一段正常正文也被
送进解析器：上线后 4456 行日志里 `rescued` **0** 条、`rescue-failed` 29 条且 reason 全是 `no_tag`
（textLength 多为 952–1684 字的正常回答）。真泄漏一次没救回来，日志倒是被噪声灌满。

- **触发门槛收紧**：只有块文本里真的存在一个尖括号包住的标记形态（新导出 `hasDsmlTag`）才进解析器；
  没有标签就直接走原有逻辑，不写日志。
- **新增 `rescue-dry` 档**：解析成功也只记一条 `rescue-would`（calls / names / 正文样本），
  不交出 tool-call，照旧让这一步重跑。用来在真实流量里量解析成功率而不改变任何可见行为。
  实现上有一处必须注意：dry 档解析成功后要**自己发 EMPTY_RESPONSE** —— `judge()` 对「正文 + 调用标签」
  这种形态本来就不判泄漏，落回普通分支会把标签原样写进历史。
- **日志补样本**：`rescued` / `rescue-failed` 都带 160 字样本，便于事后判断救回/失败的是什么内容。
- **新增 `rescued-finish`**：记录收尾由 `was` 改成 `now`。否则 max-tokens 被改写成 tool-calls 之后，
  事后完全看不出这次救回不是从完整回答里捞出来的。
- 测试 152 → 175 项（含「正常正文不写 rescue-failed」「dry 档不产出工具调用且仍 retry」等断言）。

## 0.15.0 — 2026-11-22

New `leakAction: rescue`: recover the leaked call instead of throwing the step away.

- New `parseLeakedCalls(text, allowedNames)` and `collectToolNames(options)`. A leaked block is
  parsed into `{ name, arguments }` pairs; `block.text` is the unit of truth because the argument
  JSON is only complete at `block-end`.
- In `rescue` mode a successful parse replaces the leaked block with a cleaned text block plus one
  `tool-call` block per `invoke` (`id` = `call-rescue-N`, indexes offset by 2000 so they never
  collide with the text block), and rewrites `finish.reason.kind` from `stop` to `tool-calls`.
  The agent loop executes on the presence of `tool-call` blocks, so the step continues with no
  second request and no replayed side effects.
- The allowlist comes from `options.tools` on the `llm/stream` waterfall; an unknown tool name, an
  unpaired `parameter`, unparseable JSON, or a leftover DSML marker all fall back to `retry`.
- `string="false"` parameters are JSON-parsed; HTML entities are decoded before parsing.
- Holding limit in `rescue` mode rises to 20,000 characters when the held text carries a DSML mark,
  so a full call is never flushed to the transcript mid-argument.
- Fixed a real leak in the fallback path: `acting` treated every non-`retry` mode as `replace`, so
  in `rescue` mode a failed parse let "prose + trailing fragment" through untouched. Rescue now
  follows retry semantics (drop the text, fail the step).
- The recovered prose reuses the original block index when nothing was emitted for that block,
  instead of opening a synthetic block and leaving an empty text block behind.
- Tests: 139 → 152 (13 new rescue cases across the parser and the stream wrapper).
## 0.14.0 — 2026-11-22

Packaging release, no rule changes.

- Package published as `@christinachloe/dsh-dsml-guard` (the unscoped `dsh-dsml-guard` name was
  already taken on npm by an unrelated plugin) and turned into a real bundle: `dsh.bundle.patch`,
  `locale/en.json`, `locale/zh.json`, `icon.svg`, `docs/DETAIL.md`, `LICENSE`, CI.
- Default log path is now `$DSH_HOME/logs/dsml-guard.log` (`~/.dsh/logs` when `DSH_HOME` is
  unset) instead of a path two directories above the plugin. The old default pointed into
  `<profile>/logs` once the bundle lives in a profile's `node_modules`.
- Fixed a silent logging failure introduced while moving to that path: `appendLine()` still
  called `dirname()`, whose import had been dropped, and its `try/catch` swallowed the
  `ReferenceError`, so no log line was written at all. `verify_logging.mjs` caught it.
- The two integration fixtures now carry synthetic prose with the real leak shape (a full answer plus
  the trailing call fragment); the captured turns they came from are no longer shipped.
- `scripts/check-manifest.mjs` validates the bundle contract before release: patch path, exports,
  `files`, locale metadata and detail document, the 36×36 icon, and the packed file list. CI runs it.
- Icon redrawn to the 36×36 canvas `references/artwork.md` asks for; the previous one was 64×64.
- README: note that an existing absolute-path row must be removed before installing the bundle, because
  both rows use the same id.

## 0.13.0 — 2026-11-22

- The DSML marker is matched with `[｜|]+` per side instead of one hard-coded double-bar
  string: a relay emitted single-bar tags (`｜｜DSML｜｜` with one bar each side) and the old
  check returned early, so the leak was not even logged.
- Tolerates spaces between the bars and the word, and fullwidth letters (`ＤＳＭＬ`).
- Added `fixtures/real-leaks-2026-11-22.json` with two captured leaks as regression input.

## 0.12.0 — 2026-11-21

- Treats a block that contains nothing but tag shells as noise (`isInternalTagSoup`).

## 0.11.0 — 2026-11-15

- Cleans `block-end.block.text`, not just the deltas. `BlockAssembler` takes the block's final
  `text` as authoritative, so a turn whose text arrived in one `block-end` (two characters of
  deltas, then 19,749 characters in the block) passed straight through 0.10's filters.

## 0.10.0 — 2026-11-15

- Internal tags are matched by prefix family, not by the literal `<thinking>`: `think`,
  `thought`, `reasoning`, `reflection` move to the reasoning channel; `analysis`, `preamble`,
  `summary`, `accepted`, `head`, `action` are dropped.
- Handles tags that omit the closing angle bracket (`<thinkingNo …`).

## 0.9.0 — 2026-11-14

- Text that opens with a literal `<thinking>` is moved to the reasoning channel, so DSH renders
  a collapsible thinking row and the translation plugin can reach it.
- Fixed chunk ordering: a queued `[text-delta, block-end]` pair was delivered reversed.

## 0.8.0 — 2026-11-14

- When the text channel is a copy of the reasoning channel, hold it instead of releasing it at
  the 1,200-character cap. Leaks that used to be visible for a moment before the retry are now
  withheld entirely.

## 0.7.0 — 2026-11-13

- A prose body followed by a trailing fragment counts as a leak, and retries. 0.6 only acted on
  a hollow fragment, so "half a sentence + tail tags" was passed through.

## 0.6.0 — 2026-11-13

- `leakAction`: `observe` (log only), `replace` (swap in a notice), `retry` (fail the step so the
  harness re-runs it in place, keeping finished tool results).

## 0.3.0 — 2026-11-10

- Judge whole assembled text instead of single chunks: a streamed fragment arrives as several
  `text-delta`s, and per-chunk checks counted one leak twice while missing "half a sentence +
  fragment" entirely.

## 0.1.0 — 2026-11-08

- First version: observe-only detection on the `llm/stream` waterfall.