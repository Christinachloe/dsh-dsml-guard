# dsh-dsml-guard

![before and after](docs/preview.svg)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) bundle that repairs the assistant text stream before a mangled turn reaches the transcript.

If you reach DeepSeek through an OpenAI-compatible relay (a broker), you have probably seen these three failures. They are not model bugs you can prompt away — the broker loses information on the way out.

| What you see | What actually happened | What this bundle does |
|---|---|---|
| An answer ends with a stray `｜｜DSML｜｜ invoke>` / `｜｜DSML｜｜ calls>` tail, and no tool ever runs | The model emitted DeepSeek's tool-call marker tokens, the broker's chat template did not recognise them, so they arrived as plain text | With `leakAction: retry`, the step fails and DSH re-runs it in place |
| A long "answer" that is really the model's reasoning, cut off mid-thought | The broker copied the reasoning field into `content`, so DSH renders it as an answer | Held back until the leak is judged; logged as `reasoningCopy` |
| Visible English prose wrapped in `<thinking>` / `<analysis>` / `<preamble>`, with no collapsible thinking row | Upstream put an internal tag in the text channel; DSH has no reason to treat it as reasoning | Thinking tags move back to the reasoning channel (collapsible, and translatable); analysis/preamble/summary blocks are dropped |

## Install

Inside DSH, a bundle is just a package with a `dsh.bundle.patch`. Three routes:

1. **Local directory** — **Plugins** → **Add plugin**, then pick this folder. Best while iterating.
   Published name is the scope `@christinachloe/dsh-dsml-guard`; the unscoped `dsh-dsml-guard`
   on npm is a different plugin by another author.
2. **npm** — after publishing: `dsh plugin --profile <profile> add @christinachloe/dsh-dsml-guard`
3. **By hand** — point the profile's `cordis.patch.yml` at `index.js`:

   ```yaml
   - insert:
       - id: dsml-guard
         name: C:/path/to/dsml-guard/index.js
         config:
           enabled: true
           leakAction: retry
   ```

Restart DSH after the first install. The stream wrapper is registered at activation, so a running process keeps the old code.

**If you already mount this plugin by absolute path**, delete that row from the profile's
`cordis.patch.yml` before installing the bundle. Both rows use the id `dsml-guard`, so the second one
overwrites the first and the profile ends up pointing at a path that no longer exists.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` logs a boot line and detaches — nothing is rewritten |
| `leakAction` | `observe` in bare code, `retry` in this bundle's patch | `observe` only logs · `replace` swaps the text for a notice · `retry` fails the step so DSH re-runs it · `rescue` parses the leaked call and hands DSH a real tool call instead · `rescue-dry` parses and logs only, then still retries |
| `interceptText` | a Chinese "output was empty, please continue" notice | Text shown when `leakAction: replace` |
| `logFile` | `$DSH_HOME/logs/dsml-guard.log` (`~/.dsh/logs` when unset) | JSONL target; set it if you keep logs somewhere else |
| `intercept` | — | Legacy: `true` behaves like `leakAction: replace` |

`leakAction: retry` is the reason this exists: DSH's `dsh-llm-retry` re-runs a failed **step**, not the whole turn, so finished tool calls and their results stay. The leaked text never enters history — a failed attempt is recorded as `assistant/attempt`, not `assistant/message`.

## Rescue

`leakAction: rescue` is the only mode that *recovers* the call instead of discarding it. When a
text block ends with a DSML call fragment, the plugin parses it and emits the same block as
ordinary `tool-call` chunks: the prose goes out cleaned, and each `invoke` becomes
`{ type: 'tool-call', name, arguments }` with a `call-rescue-N` id. DSH's loop executes
whatever tool-call blocks it finds, so the step continues without a second request.

Why it beats `retry`:

- **No extra request, no cache miss.** `retry` re-sends the whole context and waits for the model
  to try again; with a broker that leaks deterministically that just burns the retry budget.
- **No duplicated side effects.** A re-run of the step re-executes anything the model already
  called; rescue executes the parsed call once.
- **It still runs the tool.** `retry` only helps if the retry happens to emit a proper call.

Safety boundary — it only rescues what it can prove:

- the tool name must appear in this request's `tools` (read from the stream options), otherwise the
  verdict falls back to `retry`;
- every `parameter` must be closed and re-serialise to valid JSON, otherwise fall back to `retry`;
- `string="false"` values are JSON-parsed (numbers, booleans, objects) instead of being sent as text;
- a leftover DSML marker in the recovered prose means an unpaired tag, so it falls back to `retry`.

### Trigger gate

Parsing only starts when the block text actually contains a bracketed marker (`hasDsmlTag`). v0.15
parsed every string block, so ordinary answers produced one `rescue-failed` / `no_tag` line each
(29 in a day, zero `rescued`). Without a marker the old path runs untouched and nothing is logged.

### `rescue-dry`

`leakAction: rescue-dry` logs what rescue would have done - one `rescue-would` line with the parsed
tool names and a 160-character prose sample - and then still fails the step, so behaviour is
identical to `retry`. Run it for a while to measure the parser's hit rate on your broker before
letting it execute anything.

Failures are logged as `rescue-failed` with a `reason` (`unknown_tool`, `unpaired`, `bad_args`, ...);
successes as `rescued` with the tool names and how much prose was kept; both carry a 160-character
sample. A `rescued-finish` line records the finish reason before and after rewriting (`was` / `now`),
which matters when a truncated (`max-tokens`) step is turned into `tool-calls`.

Since 0.19 every one of those lines also answers *what kind of breakage was this*:

- `format` — one short code: `empty`, `no_dsml`, `think_tag`, `single_pipe`, `param_without_invoke`,
  `closed_only`, `unclosed_invoke`, `tags_only`, `prose_plus_tags`. `single_pipe` means the DSML
  mark lost a pipe on one side (`｜DSML` / `DSML｜`) — the shape that slipped through before 0.13.
- `diag` (failures only) — `{at, tag, tokens, excerpt, openInvoke, openParam, tool, allowed, dsmlTags}`,
  i.e. the byte offset, the tag that tripped the parser, and a 40-character window around it.
  `no_tag` additionally records `dsmlTags`, the number of DSML marks present: 0 means the text really
  had no marks, `>0` means there were marks but the tag names were unknown.
- `lint` (successes only) — codes from the harness's own tool-call pitfall table, flagged at the moment
  the call lands: `removed_tool_name` (a removed `pwsh`/`read`/`grep`/`glob` alias), `recursive_grep_in_bash`,
  `shell_heredoc` (PowerShell has no heredoc), `literal_dsml_mark` (an argument containing a literal
  tag that this guard would itself truncate), `brace_glob` (unsupported glob braces), `proxy_noproxy_missing`.
  Lint never blocks anything — the call runs as parsed.
## Log

One JSON object per line:

- `boot` — version, pid, `enabled`, resolved `logFile`. Check this first when you wonder which build is actually running.
- `active` — the `leakAction` that took effect.
- `leak` — `snippet`, `textLength`, `replaced`, `reasoningCopy`.
- `intercepted` — `action`, `dropped`, `proseLength`, `format`.
- `rethink` — internal tag moved to reasoning or dropped: tag name, character counts, whether the stream closed, whether a tool call was present.
- `rescue-failed` — `reason`, `format`, `diag` (offset / tag / window / parsed stack).
- `rescued` — `calls`, `names`, `proseLength`, `dropped`, `format`, `lint`.
- `stream-error` — the wrapper failed and the raw stream was passed through untouched.

`observe` mode is the safe way to measure your own broker before letting anything be rewritten.

## Limits

- **It repairs the symptom, not the broker.** Nothing here makes the relay emit proper `tool_calls`. Fix the relay if you can; keep this as a net.
- **Heuristics can be wrong.** A block whose *first* characters are a thinking tag is treated as reasoning, and a closed internal-tag region of 40+ characters inside prose is treated as noise. Prose that deliberately opens with such a tag will be reclassified.
- **`retry` costs requests.** Each leaked step is re-sent, up to the provider's retry policy.
- **Text only.** Tool-call channels, attachments, and non-streaming responses are not inspected.
- **Reasoning is buffered in memory** while a text block is held (20,000 characters), to recognise "the answer is a copy of the thinking".
- **A dropped `analysis` block is gone** — this bundle deletes it instead of showing it. That is the intended behaviour, not a bug.

## Tests

```bash
node test.mjs            # 241 rule and stream cases
node verify_logging.mjs  # 16 logging checks
node scripts/report.mjs  # health report over the real log
```

`test.mjs` replays leaked turns; the two integration fixtures in `fixtures/` keep the shape of a live
leak (a full answer plus the trailing call fragment) with the prose replaced by synthetic text.

## Docs

- `docs/DETAIL.md` — the image shown on the bundle's detail page.
- `docs/MAINTENANCE.md` — **start here when something breaks**: what each `format` / `reason` /
  `lint` code means, which AGENTS.md tool-call rules can be checked statically (and which cannot),
  the iteration procedure, and the parts known to be dead ends.

## 中文说明

同一个插件的三类病灶，一句话各自对应：

1. **回答尾巴挂着工具调用残片**（`｜｜DSML｜｜ invoke>` 这类），工具却一个没调 → 中转的 chat template 不认识这组特殊 token，当正文透传了。
2. **一大段"回答"其实是思考，还断在半句** → 中转把 reasoning 复制进了 `content`。
3. **正文里出现 `<thinking>` / `<analysis>` / `<preamble>` 包裹的英文**，没有可折叠的思考行，翻译插件也够不着 → 上游把内部标签塞进了正文通道。

怎么处理：思考类标签**搬回 reasoning 通道**（变成下拉框里的思考行，能翻译）；`analysis` / `preamble` / `summary` 这类整理产物**整块丢掉**；DSML 残片按 `leakAction` 处理：`retry` 让这一步失败、由 DSH 原地重跑（**已完成的工作不丢**）；
`rescue`（v0.15）直接把残片里那次调用**解析回来真的执行**——不重发请求、不重跑已完成的副作用，
代价是只救「工具名在白名单里 + 参数能完整解析成 JSON」的调用，救不回来的一律回落 `retry`。
`rescue-dry`（v0.16）只观察：解析成功也只记一条 `rescue-would`（工具名 + 正文样本），不交出调用、照旧重跑，
用来先量解析成功率再决定要不要真的执行。v0.16 另加门槛：块文本里没有真的标签形态就不进解析器（0.15 曾因此
把每段正常回答都写成一条 `rescue-failed`）。

装上之后先看日志确认：

```bash
tail -3 ~/.dsh/logs/dsml-guard.log      # 或你在 config.logFile 里指定的路径
```

`{"kind":"boot","version":"0.16.0"}` + `{"kind":"active","action":"rescue"}`（或 `retry` / `rescue-dry`）两行出现，才算真的挂上了。

局限：它修的是症状，不改中转；判据是启发式的，正文**开头**就是思考标签的内容会被改判；`retry` 每次命中多花一次请求，`rescue` 只救能证明的调用。

## License

MIT © YG and Little Code Sauce