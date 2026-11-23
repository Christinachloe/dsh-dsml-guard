# 维护手册 · dsml-guard

> 读者是「下一次被叫来修这个插件的人」（通常还是我）。
> 目标是：**不看代码也能判断这次是哪种毛病、该动哪一块**。
> 日志字段的权威定义在 `README.md`「Log」节；这里是判读与动作。

## 0. 三十秒上手

```bash
cd <plugin dir>
node test.mjs                       # 241 项，改完必须全绿
node verify_logging.mjs             # 16 项，日志写入链路
node scripts/report.mjs             # 体检：kind 分布 / 救回率 / 失败归因 / lint 命中
node scripts/report.mjs --full      # 附最近 15 条原始行
node --check index.js               # 语法
```

改完 `index.js` **不会**自动生效：插件在 DSH 启动时按绝对路径加载
（`~/.dsh/profiles/desktop/cordis.patch.yml` 的 `dsml-guard` 段）。
要重启 DSH 才行 —— 重启前先问本人（`~/.dsh/AGENTS.md` 的操作禁区）。
确认跑的是新版：看日志里最新一条 `boot` 的 `version` 字段，**不要**靠 mtime / pid 推。

## 1. 日志格式（v0.19 起）

每行一个 JSON。`kind` 七种：`boot` `active` `leak` `intercepted` `rethink`
`rescue-failed` `rescued`（另有 `rescued-finish` `stream-error`）。

| 字段 | 出现在 | 含义 |
|---|---|---|
| `format` | intercepted / rescue-failed / rescued | 格式坏法的短码，见 §2 |
| `diag` | rescue-failed | `{at, tag, tokens, excerpt, openInvoke, openParam, tool, allowed, dsmlTags}`：卡在第几个字符、哪个标签、前后 80 字现场 |
| `lint` | rescued | AGENTS.md 纪律命中码数组，见 §3 |
| `diag.dsmlTags` | no_tag 专用 | 0 = 正文真没有标记；>0 = 有标记但标签名不认识 |
| `reason` | rescue-failed | 解析器失败原因（15 种） |
| `proseLength` / `reasoningCopy` | intercepted | 0 = 空心残片；>0 = 正文+尾巴；true = 正文是思考副本 |

## 2. `format` 短码 → 怎么办

| 码 | 长这样 | 判读 | 动作 |
|---|---|---|---|
| `empty` | 空白 | 不该发生 | 看上游是不是发了空 delta |
| `no_dsml` | 普通正文 | 文本被误送进解析器 | 检查调用点是否漏了 `hasDsmlTag()` 门 |
| `think_tag` | `<thinking>…` | 上游把思考塞进正文通道 | v0.9 的 rethink 路径负责搬回 reasoning；若仍出现说明标签名不在白名单 |
| `single_pipe` | `｜DSML` / `DSML｜` | 竖线退化 | v0.13 起已容忍；此码只用于观测退化频率 |
| `param_without_invoke` | 只有 `<parameter>` | 残片从中间开始 | 救不回来，走 retry；重点看 `diag.at` 前面被截掉了什么 |
| `closed_only` | 只有 `</invoke></calls>` | 经典空心残片 | retry 正常 |
| `unclosed_invoke` | 有开无闭 | 流被 max-tokens 截断 | 检查 finish reason；可能要放宽 `max-tokens` |
| `tags_only` | 只有标签 | 空心 | 正常重试 |
| `prose_plus_tags` | 正文 + 尾巴标签 | v0.7 那类 | 若 `reasoningCopy` 为真，说明是思考副本，别当正文救 |

## 3. `lint` 码 × AGENTS.md 对照（查漏补缺表）

「能检出」= 静态看参数就能判；「不能」= 必须跑起来才知道，**不硬做**，留给报告。

| AGENTS.md 纪律 | 检出 | 码 |
|---|---|---|
| 已移除的工具名 pwsh/read/grep/glob | ✅ | `removed_tool_name` |
| 递归搜索只用 ops_grep（bash `grep -r` 会 120s 超时） | ✅ | `recursive_grep_in_bash` |
| ops_grep 的 `path` 只给一层，绝不给家目录/盘符根 | ✅ | `broad_grep_path` |
| 必带排除 glob（`!**/node_modules/**` 等） | ✅ | `grep_without_exclude` |
| ops_grep 不支持花括号 glob | ✅ | `brace_glob` |
| PowerShell 没有 heredoc（`python - <<'PY'` 解析期就死） | ✅ | `shell_heredoc` |
| 字面 DSML / 思考标记会被本插件截断 | ✅ | `literal_dsml_mark` |
| `$_` / `$env:` / `$()` 被 bash 先展开 → PS 报 Unexpected token | ✅ | `ps_dollar_expansion` |
| run_code 顶层 `let/const` 跨程序存活 → 重名整段不执行 | ✅ | `runcode_toplevel_let` |
| 测代理要 `--noproxy ''`，否则 curl 读 NO_PROXY 直连 | ✅ | `proxy_noproxy_missing` |
| argparse `unrecognized arguments` 先 `-h` | ❌ | 运行期才知道 |
| argparse 报错后「文件不存在/命令没生效」= 解析期错误整段没跑 | ❌ | 时序推理，静态无解 |
| ops_grep 0 命中要看 `skipReasons.pattern`（花括号假象） | 部分 | 花括号那条已由 `brace_glob` 提前拦 |
| 中文输出乱码（GBK 控制台） | ❌ | 输出编码问题，与调用参数无关 |
| 调用前三问（谁解释 / 有没有被吃掉的字符 / 输出上限） | ❌ | 人类检查项 |

**维护动作**：AGENTS.md 新增「工具调用避错」行时，先问「参数里看得出来吗」——
能，就加一条 `TOOLCALL_RULES` + `lintToolCalls` 分支 + 两条测试（命中/不命中）；
不能，就补进这张表的 ❌ 段，别硬造规则（误报会让人不再信 lint）。

## 4. 迭代流程（改代码时按这个顺序）

1. **先取证**：`node scripts/report.mjs --full`，看 `format` / `diag` / `reason` 的组合。
   只有 `reason` 没有 `format` 的行说明是 v0.18 及以前的老日志，别用来判新问题。
2. **定位**：`diag.at` 是失败点的字符偏移，`diag.excerpt` 是它前后各 40 字。
   把 sample（前 160 字）和 excerpt 一起看，多数时候真相就在这两段里。
3. **改判定**：只动 `classifyFormat` / `parseLeakedCalls` / `lintToolCalls` 这类纯函数，
   别碰流包装（`apply()` 里那段状态机是最脆的部分）。
4. **补测试**：`test.mjs` 里按 `v0.19` 段的风格加压测；**必须有一条端到端**（真跑
   `apply()` + 读日志文件断言字段存在），否则「字段写了但没进日志」这种错抓不到。
5. **改版本**：`GUARD_VERSION`、`package.json`、`CHANGELOG.md` 三处一起；CHANGELOG 写
   「为什么改」而不是「改了什么」——旧版本自己会说明改了什么。
6. **全量验证**：`node --check` + `node test.mjs` + `node verify_logging.mjs`
   + `node scripts/report.mjs`（对着真日志跑一遍，确认没把解析规则改崩）。
7. **告知重启**：代码生效要重启 DSH，先问本人。

## 5. 已知无效 / 已修复的部分

### 5.1 v0.20 填掉的坑

> 历史：v0.20 之前 **rescue 从未成功**（99 条 `rescue-failed`、0 条 `rescued`）——
> 不是解析器写错，而是「等整块结束再解析」这个位置注定只能看见半截。下面这几条是填坑记录。

- **「只剩闭合标签」现在能救回来了**（原 `unpaired_param` 35 条的主力形态）。
  v0.20 起 `StreamHoldback` 在块边界把「还没闭合的调用片段」整段扣住带进下一块，
  下一块的 `block.text` 拼上 carry 再解析 —— 开标签在上一块、闭合标签在下一块也能成。
  日志里新增 `kind: "holdback"`（扣了多少字、为什么扣、是补齐了还是放弃了）。
- **`<` 与 DSML 字面都丢了的退化标签**（`｜｜ invoke｜｜ name="…"`）也认了：
  `scanBareTags()` 只认已知元素名 + 两侧竖线，正文里的普通竖线不会误伤。
- **工具名上粘着的竖线**（`name="｜｜ invoke"`）会被两头剥掉再比白名单，
  不再因为标记没洗干净就判 `unknown_tool`。
- **`<` 后面直接跟竖线**（`<｜｜DSML｜｜ …`）曾被判成正文原样发出去 —— 用户那边看得见半个 `<｜`；
  现在按「标签前缀」扣住。

### 5.1.1 v0.20.1：`unpaired` 类扣留已取消

上线 31 分钟后按生产数据收紧：57 条 `unpaired*` 里 `openInvoke`/`openParam` 57/57 为 `null`、
救回 0 条，却把 12,532 字压到块尾（最大一块 91%）。
现在**闭合标签本身不是调用证据，开标签才是** —— 孤立闭标签按正文下发（下发前剥掉标签本身），
只有真的开着 invoke 才扣。判据在 `index.js` 的 `StreamHoldback.riskAt()`。

### 5.1.2 v0.21：纯副本抑制（上游污染 ≠ 你的调用写错）

生产证据（2026-11-23 近 4 小时）：10 条 `rescue-failed` 全是 reasoning 副本，
与同刻 `leak` snippet 相似度 0.89–1.00、`Δt=0.0s`；全量 224 条 `intercepted` 里
**172 条 `reasoningCopy:true`（79%）**，丢 **273,944 字**，全在
`khala/deepseek-v4.1-flash-1017`。旧路径会**先吐半截正文**再重取，用户看到的是「报错」。

四个改动点：
1. `COPY_FORMATS = new Set(['prose_plus_tags', 'param_without_invoke'])` —— 只有
   「散文里散落标签」才算副本形态；真调用被切断是 `unclosed_invoke`/`tags_only`，不在此列。
2. 抑制点放在 `passText` **开头、`asm.push(text)` 之前**：`sofar = asm.text() + text`。
   放块尾就晚了（半截正文已下发）；放 push 之后就错了（`asm` 已含这段，拼出来重复一遍，
   前缀比对永远失配 —— 第一版就是这么没触发）。
3. `suppressedCopy` 一旦置位，本块后续 delta 一律 `return []`；块尾写
   `kind:"reasoningCopy-suppressed"` 并 `return []`；`finish` 时若
   `suppressedCopy && rescuedCalls === 0` → `failureChunk()`（既有 `EMPTY_RESPONSE` 重取）。
4. 抑制路径**不写 `rescue-failed`**：同一件事写两条，反而看不出「是谁的锅」。

怎么读日志（这是本节最有用的一条）：
- 有 `reasoningCopy-suppressed` → **上游污染**，跟你写的调用无关，重取就行；
- 没有它、只有 `rescue-failed`（`reason` = `invoke_no_name` / `unknown_tool` / `bad_args` …）
  → **真 tool call 格式错**，去看 `diag.tag` + `diag.excerpt` 定位。

### 5.1.3 v0.22：正文被换成固定套话

现场（会话 `f7bf07df`，5 次）：`content` 是 `[text: 套话][reasoning: " "][tool-call: run_code]`。
reasoning **只有一个空格**，工具调用却真的执行成功了 —— 所以这不是拒绝，是**正文被替换**。

判据（三条同时满足才算「被替换」）：

| 条件 | 阈值 | 为什么 |
|---|---|---|
| 这一轮真有工具调用 | `hasToolCall` 或 `rescuedCalls > 0` | 真拒绝时模型不会去调工具 |
| 正文去空白后长度 | ≤ 24 字 | 套话都是短句；长文里的这句话是引用 |
| reasoning 是否以它开头 | 否 | 同源说明是模型自己在想这句话 |

形状：`CANNED_REFUSALS` 7 条固定串 + 一条泛化正则（去空白 12–40 字内生效）。

分流（`finish` 里）：有思考 → 把思考当正文发（`shown:"reasoning"`）；
没思考 → 一个字都不发（`shown:"nothing"`）；不是替换 → 原样放行（`shown:"passthrough"`）。
三种都写一条 `kind:"canned-refusal"`。

**坑**：上游可能只给 `block-end`（`block.type==='tool-call'`）不给 `block-start`，
只认 `block-start` 会把「干了活」误判成「没干活」，套话原样放给用户。

怎么读日志：**有 `canned-refusal` = 上游换正文；没有 = 模型真拒绝**（后者不要动）。

### 5.2 仍然是死胡同

- **`no_tag`（59 条）救不回来**：正文里根本没有标记，重建无从谈起。
  v0.19 的 `diag.dsmlTags` 能区分「真没有」和「有标记但标签名不认识」，前者直接放弃。
- **英文思考散文被复制进 content**（`unpaired_param` 样本里常见）：那不是调用，
  解析器判 `unpaired_param` 是对的。v0.20 对这类只做「剥标签后正文照发」（`rescued-noise`），
  不再把整轮判成失败。**v0.21 起升级为「纯副本抑制」**（见 §5.1.2）：
  `looksLikeReasoningCopy()` 判真 + 形态是 `prose_plus_tags`/`param_without_invoke`
  → 整块不下发一个字，走 `EMPTY_RESPONSE` 重取，日志写 `reasoningCopy-suppressed`。
  「散文 + 夹着的真话」属于混合内容，判据给假，照旧清洗 —— 抑制不许吞真回答。
- **`rethink` 的 tag 名白名单**永远追不上上游：v0.18 已改成反向规则（不认识的都当内部标签），
  再遇到新名字不用加白名单，先看是不是误伤真 HTML。
- **日志只留前 160 字**：`sample` 是给人扫一眼的，排障靠 `diag.excerpt`（v0.19 才有）。
  要更长的现场，临时把 `sample` 长度改大再复现，别指望历史日志。
- **`observe` 档不解救**：它只做「影子救援」记账（`kind:"rescued", dry:true`），
  一个字节都不改流。要真救回，必须 `leakAction: "rescue"`（profile 里就是这么配的）。
  所以看「能救回多少」看 dry 行，看「真救回没有」看非 dry 行。

## 6. 本机运维接线（2026-11-23 定案）

三个外部件把这套维护变成「有人替你盯着」，改动它们不属于插件源码，但会影响你能不能看到问题。

### 6.1 交付门（delivery-gate）

- 配置在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾：`- id: delivery-gate` +
  `enabled: true` / `scripts: ["指挥部/verify.ps1"]` / `maxRounds: 1` / `timeoutMs: 60000`。
- **为什么是 `verify.ps1` 而不是 `.sh`**：Windows 上 delivery-gate 走
  `spawn('pwsh', ['-NoProfile','-NonInteractive','-File', file])`，它不会用 bash 跑 `.sh`；
  `指挥部/verify.ps1` 只做一次转发（找 bash.exe → 跑 `acceptance-dsml.sh` → 原样 `exit $LASTEXITCODE`）。
- **为什么不是 `acceptance.sh`**：那条 51 项 / 34s，每回合跑一次会把对话拖死；
  `acceptance-dsml.sh` 22 项 / 3.0s（`pwsh -File` 实测 3.7s），只盯插件这一件事。
- 它只对本工作区生效：`findScript(cwd, scripts)` 找不到文件就跳过。改完必须重启 DSH 才生效。
- 系统提示里那句 `DELIVERY GATE:` 是无条件注册的段，所以**加这行不改变提示词文本**，不用重付前缀。

### 6.2 指挥部自动重连（HQ-Server-Watchdog）

- `指挥部/serve_detached.py` 用 `DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP` 起 `hq_server.py`，
  并尽力 `CREATE_BREAKAWAY_FROM_JOB` 脱离宿主 job（失败退回普通 detached）。
- 幂等判据是 `GET /api/queue` 且 `totals.overall_pct` 存在 —— **不能只看 `/api/state` 的 200**：
  旧版本进程也回 200，会判成「已经在跑」，然后每次重复拉进程（pid 一直变就是这个）。
- 计划任务 `HQ-Server-Watchdog`：`schtasks /sc minute /mo 2 /it`，跑 `指挥部/hq_watchdog.cmd`。
  验证方式是**杀掉进程再等 2 分钟**（实测 `Start-ScheduledTask` 后 0.5s 内 `/api/queue` 恢复 200），
  不要拿「注册成功」当验收。
- `hq_watchdog.cmd` 里的注释必须是纯 ASCII：GBK 控制台会把中文 `rem` 行当命令执行。

### 6.3 重启后怎么确认 v0.20 真的在跑

1. `grep '"kind":"boot"' <logFile> | tail -1` 看 `version` 是 `0.20.0`（别用文件 mtime 猜）。
2. 出现 `"kind":"holdback"` 行 = 扣留器在岗；`rescued` 非零 = 跨块救回真的成了。
3. `node scripts/report.mjs` 出救回率；救回率仍 0 且 `holdback.gaveUp` 高，说明 `HOLDBACK_MAX` 太小。
