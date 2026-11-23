/**
 * dsml-guard — 检测 assistant 流里泄漏的 DSML 残片。
 *
 * 背景：中转用 `openai-completions` 协议，模型偶尔会在本该发起工具调用
 * 的位置只吐出闭合标签（例如 `\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`），
 * 中转解析不出 tool_call，就当普通文本透传，DSH 照单全收写进会话历史。
 * 残片一旦进了历史，下一轮模型会看到自己这么写过而继续模仿。
 *
 * 本插件挂在 `llm/stream` waterfall 上（dsh-llm 的公开扩展点，
 * 见 lib/index.js `streamWithRegistration`）。
 * 默认（observe 档）只观察、不改流；`replace` / `retry` 档才会扣留正文
 * （见文末 `leakAction` 说明）。
 *
 * v0.3 改动 —— 从「按 chunk 判断」改成「按整条响应对齐后判断」：
 *
 *   流式下一条残片会被切成多个 text-delta：
 *       "\n" / "</｜｜DSML｜｜ invoke>" / "\n</｜｜DSML｜｜ calls>"
 *   逐 chunk 判断会把一次泄露记成两次；而「半句话 + 残片」的形态
 *   （`那我去看看</｜｜DSML｜｜ invoke>`）又完全抓不到。
 *
 *   现在为每个流维护一份正文缓冲，在下列时机对**整段文本**做一次判定：
 *     · 收到 `block-end` 且 block.type === 'text'（一块正文结束）
 *     · 流结束（iterator 返回 done）
 *     · 下一块正文开始时，重置缓冲
 *   一次泄露只记一条，且能识别「半句话 + 残片」形态。
 *
 * 日志去向：
 *   DSH 的 stdout/stderr 在桌面端被丢弃，`ctx.logger` 的输出无处可看。
 *   所以除了 logger，还**追加写到固定文件**：
 *       $DSH_HOME/logs/dsml-guard.log（未设 DSH_HOME 时落 ~/.dsh/logs/）
 *   也可用 config.logFile 覆盖（本机就把这条指到 qqbot/logs/dsml-guard.log）。
 *   文件每行一个 JSON 对象。
 *
 * v0.8（2026-11-14）—— 治「正文其实是思考的副本」：
 *   v0.7 已经能拦住「正文 + 尾巴残片」并且照样重试，但**拦得晚**：
 *   扣留上限固定 1200 字（INTERCEPT_HOLD_MAX），超过就整段放行给前端，
 *   用户于是先看到一大段垃圾、然后才等到重试。实测今天全站 15 次可见的泄露
 *   全部长这样（最小可见 1235 字，最大不可见 989 字，分界线与 1200 完全吻合）。
 *
 *   而这段「正文」根本不是正文：中转会把 reasoning 原样复制进 content，
 *   某会话的 11 次失败尝试里 text 与 reasoning 逐字相同（最长 3667 字）。
 *   所以现在同时记住本路的推理内容，一旦认定正文是它的副本，就放开 1200 的限制、
 *   一直扣到判定为止（硬上限 REASONING_HOLD_MAX = 20000 只为防内存无界）。
 *   前端不会再看到「先漏一段再重试」，日志里用 `reasoningCopy` 字段标记这种形态。
 *
 * v0.9（2026-11-14）—— 治「思考被塞进正文通道」：
 *   v0.8 只认得两种病害（DSML 残片、正文=思考副本），但用户发现第三条路：
 *   上游偶尔把思考**当成正文**吐出来，还套着字面 `<thinking>` / `</thinking>`。
 *   DSH 于是按普通正文渲染——没有可折叠的思考行，顶上的翻译插件也够不着它，
 *   用户看到的就是一整段没翻译的英文「回答」。
 *   查 某会话 的 258 条 assistant/message：33 条带正文，
 *   其中 19 条（58%）正文以字面 `<thinking>` 开头、共 37,555 字，
 *   且 0 条在闭合标签后跟着真回答——它们是纯思考。这类消息在 v0.8 的日志里一条都没有。
 *
 *   所以现在：正文块的最开头若出现 `<thinking>`，就把这一块**改回 reasoning 通道**
 *   （块头 blockType 一起改成 reasoning，标签本身剥掉），DSH 会渲染成可折叠的
 *   思考行，翻译插件随即覆盖到它。判据刻意收窄：只认块的最开头，
 *   正文中间出现的 `<thinking>`（引用、示例）一律不动。
 *   若整条消息搬完之后既没有正文也没有工具调用，就发 EMPTY_RESPONSE 让它重跑这一步。
 *   日志里用 `kind: "rethink"` 记录（只记字数，不记正文）。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * 插件版本，写进 boot 日志行。
 * 改完代码想确认「运行中的到底是不是新版」，看日志里的 version 字段，
 * 不要靠文件 mtime 和 pid 推。
 */
const GUARD_VERSION = '0.22.0';

/**
 * DSML 标记。全角竖线是 DeepSeek 的标记字符。
 *
 * v0.13（2026-11-22）：**不再数竖线根数**。标准写法是 `｜｜DSML｜｜`（两根），但模型/中转
 * 退化时会漏成 `｜DSML｜`（单根）。实测某次会话 2026-11-22（1,962 字）
 * 与 08:59:51（3,825 字）两条泄露都是单根，而旧正则只认两根 → `isDsmlTailFragment()`
 * 一开始 `includes('｜｜DSML｜｜')` 就判否 → `judge()` 直接 `return null`，连一条日志都不记。
 *
 * 顺带容忍：夹空格（`｜ DSML ｜`）、半角竖线（`|DSML|`）、全角字母（`ＤＳＭＬ`）、大小写。
 */
const DSML_MARK = '[｜|]+\\s*[DdＤｄ][SsＳｓ][MmＭｍ][LlＬｌ]\\s*[｜|]+';
const DSML_TAG_SRC = `</?\\s*${DSML_MARK}\\s*[^>]*>`;
/** 匹配单个 DSML 标签（全局，只用于剥离；replace 会重置 lastIndex）。 */
const DSML_TAG = new RegExp(DSML_TAG_SRC, 'gi');
/** 文本里是否存在 DSML 标记（无 `g`，可安全反复 test）。 */
const DSML_MARK_RE = new RegExp(DSML_MARK, 'i');

/**
 * `replace` 档允许「连坐」替换的前缀长度。
 *
 * v0.5 起改成 **0**：只有「去标签后一个字都不剩」才换掉。
 *
 * 为什么收回 40 字：
 *   测试里那句「这个标签是中转层解析失败时吐出来的残片，我们查过时间线，
 *   和压缩没关系」去掉标签后才 35 字，落到 40 以内就被整段替换了。
 *   正常讨论 DSML 的段落本来就常常不长，靠长度猜必然误伤。
 *   而真实残片（`\n</｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`）去掉标签后
 *   就是空的——这个判据零误伤，代价只是「半句话 + 残片」不再被拦。
 *   那半句话至少可读，留着比误杀强。
 *
 * v0.7（2026-11-13）—— 这条门槛只留给 `replace` 了：
 *   实测泄露经常是「整段正文 + 尾巴挂着一串残片」（13:35 那次 838 字，
 *   正文完整、最后一句后面直接跟 `</｜｜DSML｜｜ parameter>…`），
 *   而 `replace` 把正文换成一句提示语等于**删掉真内容**，所以它仍然只认空心残片。
 *   `retry` 不同：它只是把这一步重跑一遍，正文会被重新生成，不算丢，
 *   所以 retry 档不再看这个门槛（见 `judge()`）。
 */
const INTERCEPT_PREFIX_MAX = 0;

/**
 * 拦截模式下正文的扣留上限。
 *
 * 超过这个长度就不可能是残片，立刻放行，避免把整篇正常回复压在内存里
 * 直到 block-end 才吐出去。
 */
const INTERCEPT_HOLD_MAX = 1200;

/**
 * v0.8：确认「正文就是推理内容副本」时的扣留上限（比 INTERCEPT_HOLD_MAX 高得多）。
 *
 * 为什么需要第二条上限（2026-11-14 定）：
 *   中转会把 `reasoning_content` 原样复制进 `content`，某会话的 11 次
 *   失败尝试里 text 与 reasoning **逐字相同**（最长 3667 字）。这种正文一个字都不是
 *   新内容，1200 字就开始放行等于把整段垃圾亮给前端（今天全站 15 次可见全来自这里）。
 *   所以只要能证明「这段正文 = 已经看过的思考」，就一直扣到判定为止。
 *   留一个硬上限只是防内存无界增长，不是判定门槛。
 */
const REASONING_HOLD_MAX = 20000;

/** 副本判据至少要重合多少个字符，防止短句误撞（正文/思考都从同一句开头极常见）。 */
const REASONING_COPY_MIN_OVERLAP = 60;

/**
 * v0.10：上游把「内部草稿」塞进 `content` 时自带的标签族。
 *
 * 为什么从 v0.9 的单个 `<thinking>` 扩成两族（2026-11-15 定）：
 *   用户报 `另一次会话` 里「分析和整理的内容被当正文暴露了，没有思考可选项」。
 *   把该会话 122 条带正文消息按开头标签分类：plain 93、thinking 17、preamble 5、
 *   analysis 4（长度 18,642 / 20,287 / 27,557 / 29,154 字）、thinkingNow 1、accepted 1、head 1。
 *   再扫最近 8 个会话，还见到 think / thought / thinkg / thinkTapping / thinkingNo /
 *   thinkingThe / thinkingLet / thinkingThis / action。
 *   其中 `thinkingNo` 这类是**标签漏了闭合尖括号**（`<thinking` 直接接第一个词），
 *   v0.9 要求严格等于 `<thinking>`，全部漏判。
 *
 * 两类分开处理：
 *   think —— 思考本身，搬进 reasoning 通道（进下拉框，翻译插件才覆盖得到）；
 *   draft —— 分析/摘要/前言这类整理产物，用户 2026-11-15 拍板「丢掉」：
 *            它们本质是模型自己编的压缩摘要，留着只会让它下一轮继续模仿这个格式。
 *
 * 判据仍然很窄：**只在正文块的最开头**（以及草稿段闭合之后）认，
 * 正文中间出现的 `<thinking>` 是引用/示例，一律不动。
 */
const THINK_TAG_PREFIXES = ['think', 'thought', 'reasoning', 'reflection'];
const DRAFT_TAG_PREFIXES = ['analysis', 'preamble', 'summary', 'accepted', 'head', 'action'];
/** 探测标签名时最多攒这么多字符（`<thinkingNo` 这种漏尖括号的最长见过 12 字）。 */
/**
 * v0.16：**已知 HTML 标签**——出现在正文开头时不能当内部草稿标签。
 *
 * 为什么要留这张表：默认规则反过来（见 `tagKindOf`）——凡是不在表里的 `<name>`
 * 都当内部标签。上游造词没有上限，白名单永远追不上：11-22 又冒出
 * `<quick_check>`、`<remaining_text>`、`<checkpoint>`、`<compression>`、`<success>`、
 * `<agent>`、`<parameter name="…">` 七种。所以改成「除 HTML 之外一律算内部标签」，
 * 只有这张表里的名字才老老实实当正文放行。
 */
const HTML_TAG_NAMES = new Set(["rt", "caption", "iframe", "math", "bdi", "optgroup", "nav", "datalist", "select", "style", "dl", "meta", "figcaption", "line", "pre", "legend", "blockquote", "footer", "param", "bdo", "a", "h5", "kbd", "summary", "meter", "dt", "hr", "object", "var", "span", "abbr", "menu", "aside", "noscript", "u", "svg", "figure", "main", "circle", "source", "slot", "rect", "cite", "g", "script", "section", "del", "option", "h6", "samp", "label", "th", "div", "ol", "ul", "wbr", "header", "output", "time", "q", "mark", "h2", "data", "ruby", "input", "br", "tr", "em", "track", "h4", "tfoot", "table", "audio", "base", "progress", "tspan", "h3", "fieldset", "link", "canvas", "article", "text", "polyline", "sup", "textarea", "dialog", "tbody", "li", "i", "title", "body", "video", "p", "form", "col", "template", "code", "dfn", "img", "rp", "head", "s", "defs", "td", "polygon", "ins", "button", "map", "colgroup", "picture", "b", "path", "details", "html", "strong", "thead", "sub", "small", "embed", "h1", "dd"]);

const TAG_PROBE_MAX = 24;
/** 闭合标签后面剩下的真正文放到这个偏移量的新块里（同一个 index 不能既 reasoning 又 text）。 */
const SYNTH_INDEX_OFFSET = 1000;

/**
 * v0.15（rescue 分支）：救回来的工具调用分片用的 index 偏移。
 *
 * 为什么另开一段而不是复用 SYNTH_INDEX_OFFSET：
 *   同一个 index 不能既是 text 又是 tool-call（assembler 的 ensure() 会按
 *   第一次见到的类型建 partial，之后类型就定了）。正文合成块占 1000 段，
 *   工具调用占 2000 段，互不相撞。
 */
const RESCUE_INDEX_OFFSET = 2000;

/**
 * v0.15：rescue 模式下正文的扣留上限。
 *
 * 为什么比 INTERCEPT_HOLD_MAX（1200）高一个量级：
 *   要救回一个工具调用，必须拿到**完整的** `invoke` 与它所有 `parameter`，
 *   否则参数 JSON 是半截的，只能回落重跑。真实泄漏正文常见 2–4k 字。
 *   这条上限只是防内存无界增长，不是判定门槛。
 */
const RESCUE_HOLD_MAX = 20000;

/** v0.15：救回来的 tool-call id 前缀（可审计：一看就知道是插件造的）。 */
const RESCUE_ID_PREFIX = 'call-rescue-';

/**
 * v0.15：rescue 用的宽口径标记。
 *
 * 与 DSML_MARK 的差别是**允许零竖线**：模型退化时会漏成 `｜DSML｜invoke`
 * （两根竖线全丢），DSML_MARK 要求至少一根，会整段漏判。
 * 宽口径只用在「已经确认这段正文该救」的解析里，不参与日常判定，误伤面极小。
 */
const RESCUE_MARK_SRC = '[｜|]*\\s*[DdＤｄ][SsＳｓ][MmＭｍ][LlＬｌ]\\s*[｜|]*';

/**
 * v0.16：判断这一段里是否真的存在一个 DSML 标签。
 *
 * 为什么需要：v0.15 的 rescue 分支只要块文本是字符串就丢进解析器，正常正文
 * 也会走到 no_tag 失败并写一条日志 —— 实测一天 29 条全是这种噪声。
 * 没有标签就不进解析器，也不写日志。
 */
const RESCUE_TAG_PROBE = new RegExp('<\\s*\\/?\\s*(?:' + RESCUE_MARK_SRC + ')\\s*[^<>]*>', 'i');

/** v0.16：这一段里有没有真标签（尖括号包住标记名的形态）。 */
export function hasDsmlTag(text) {
  return typeof text === 'string' && RESCUE_TAG_PROBE.test(text);
}

/**
 * v0.15：连发的**游离闭合标签**当成噪声（2026-11-22 定）。
 *
 * 怎么发现的（会话 47055cea 最后一条，19:28:35）：
 *   正文块里是 `\n\n</thinking>\n\n</thinking>…` 连了 **114 次**，一个开标签都没有，
 *   后面 ~1,900 字是继续思考的正文（"Plan: patch readiness check…"、"Wait — I should re-read…"）。
 *   guard 把开头的 `<thinking>…`（1,064 字）搬进 reasoning 之后，剩下的 `</thinking>` 一律
 *   按普通正文放行 —— 因为 `probeInternalTag`/`splitBlockText` 的标签正则都要求 `<` 后面
 *   紧跟**字母**，`</thinking>` 的第二个字符是 `/`，压根认不出来。
 *   结果：114 个闭合标签 + 一段思考跑进正文，前端看到的是「思考泄露 + 满屏 think」。
 *
 * 判据：一个正文块里「闭合了但没有对应开标签」的内部标签 ≥ STRAY_CLOSER_MIN 个，
 * 视为上游状态机错乱的产物。两条处置：
 *   ① 游离闭合标签一律剥掉（它们绝不属于正文）；
 *   ② 若这一块开头**本来就有**开标签（thinkingChars > 0），把剩下的文字也算思考，
 *      整块搬回 reasoning —— 连发 100 多个闭合标签的块不可能是回答。
 */
const STRAY_CLOSER_MIN = 3;

/** 扫描器：`<name>` / `</name>`，允许属性段但排除尖括号。 */
const INTERNAL_TAG_ANY = /<(\/?)\s*([A-Za-z][A-Za-z0-9_-]*)[^<>]*>/g;

/**
 * 数一段文字里「没有配对开标签」的内部闭合标签。
 *
 * @param {string} text
 * @returns {number}
 */
export function countStrayInternalClosers(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const depth = new Map();
  let stray = 0;
  INTERNAL_TAG_ANY.lastIndex = 0;
  let m;
  while ((m = INTERNAL_TAG_ANY.exec(text)) !== null) {
    const kind = tagKindOf(m[2]);
    if (kind === null) continue;
    if (m[1] === '/') {
      const open = depth.get(kind) ?? 0;
      if (open > 0) depth.set(kind, open - 1);
      else stray += 1;
    } else {
      depth.set(kind, (depth.get(kind) ?? 0) + 1);
    }
  }
  return stray;
}

/**
 * 剥掉所有游离的内部闭合标签（配对的那份留着，交给正常的分块逻辑）。
 *
 * @param {string} text
 * @returns {string}
 */
export function dropStrayInternalClosers(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  const depth = new Map();
  let out = '';
  let pos = 0;
  INTERNAL_TAG_ANY.lastIndex = 0;
  let m;
  while ((m = INTERNAL_TAG_ANY.exec(text)) !== null) {
    const kind = tagKindOf(m[2]);
    if (kind === null) continue;
    if (m[1] === '/') {
      const open = depth.get(kind) ?? 0;
      if (open > 0) depth.set(kind, open - 1);
      else {
        out += text.slice(pos, m.index);
        pos = m.index + m[0].length;
      }
    } else {
      depth.set(kind, (depth.get(kind) ?? 0) + 1);
    }
  }
  return out + text.slice(pos);
}

/** 标签族 → 'think' | 'draft' | null。 */
export function tagKindOf(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.length === 0) return null;
  if (THINK_TAG_PREFIXES.some((p) => n.startsWith(p))) return 'think';
  if (DRAFT_TAG_PREFIXES.some((p) => n.startsWith(p))) return 'draft';
  /**
   * v0.16：白名单之外的 `<name>` 一律算「思考」。
   *
   * 为什么不继续往两张前缀表里加名字：实测 8 个会话里已经出现
   * thinking / thought / analysis / preamble / summary / accepted / head / action /
   * quick_check / remaining_text / checkpoint / compression / success / agent /
   * parameter ……，而每加一个新名字都要等下一次漏出来才补。反过来定规则：
   * 只有 HTML 标签是「合法的正文开头」，其余都是上游塞进来的内部标签。
   *
   * 搬进 reasoning 而不是整块丢掉：这些内容（思考、自查、草稿）对用户仍有价值，
   * 折叠起来+翻译就够；丢掉万一误判就再也找不回来。
   */
  if (HTML_TAG_NAMES.has(n)) return null;
  return 'think';
}

/**
 * 看一段正文开头是不是内部草稿标签。
 *
 * @returns {'wait'|'none'|{kind:'think'|'draft',name:string}}
 *   'wait' = 还判断不出（名字可能还没收全），继续攒
 *   'none' = 不是已知标签，按普通正文放行
 */
export function probeInternalTag(text, max = TAG_PROBE_MAX) {
  const t = String(text ?? '').replace(/^\s+/, '');
  // 纯空白：调用方会立刻原样放行、但**留在 probe 状态**，
  // 这样「换行」和后面的 `<thinking>` 分属两个 chunk 时仍然拦得住。
  if (t.length === 0) return 'none';
  if (!t.startsWith('<')) return 'none';
  const rest = t.slice(1);
  const m = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(rest);
  if (m === null) {
    // `<` 后面还没来字母：可能正要写成 `<thinking`，再等等。
    // 但 `<` 后面已经是 `/`、`｜` 这种，绝不可能是内部标签，立刻放行。
    if (rest.length === 0) return t.length < max ? 'wait' : 'none';
    return 'none';
  }
  const name = m[1].toLowerCase();
  const afterName = rest.slice(name.length);
  const delimited = afterName.length > 0 && /[\s>/]/.test(afterName[0]);
  if (!delimited) {
    // 名字可能还在长（`<think` 后面会变成 `<thinking`）
    if (t.length >= max) return 'none';
    /**
     * v0.16：名字还没收全时一律等一等（最多等到 TAG_PROBE_MAX）。
     * 以前只等「已知前缀的可能延伸」，未知名字（`<quick` → `<quick_check>`）
     * 会在第一片就直接放行，等于把新造的词漏掉。
     */
    return 'wait';
  }
  const kind = tagKindOf(name);
  return kind === null ? 'none' : { kind, name };
}

/**
 * 重试模式下用来顶替残片的失败码。
 *
 * 为什么是 `EMPTY_RESPONSE`：
 *   dsh-llm 的默认重试集合是
 *     ["EMPTY_RESPONSE", "RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]
 *   （lib/index.js `DEFAULT_RETRYABLE_CODES`，最多 5 次，退避 500ms→10s）。
 *   `EMPTY_RESPONSE` 的语义正是「这次尝试什么都没产出，重跑一次是安全的」，
 *   而 DSML 残片恰好就是这种——模型本该发起工具调用，结果只吐出闭合标签，
 *   这一步等于什么都没做。归到这个码上，重试器才会接管。
 *
 * 另一个理由：`dsh-llm-retry` 的说明写着重试发生在 agent loop 的
 * `agent/request-error` 扩展点上、**在同一个打开的轮次内重跑失败步骤**，
 * 所以重试不会丢掉已经跑完的工具结果——正是「不打断任务进度」要的效果。
 */
const RETRY_FAILURE_CODE = 'EMPTY_RESPONSE';

/** 重试模式下顶替残片时，交给重试器看到的说明。 */
const RETRY_FAILURE_MESSAGE =
  'Assistant text degenerated into DSML tool-call fragments with no real content; retrying the step.';

/**
 * 判断一段 text 是否是「工具调用被截断」的残片形态。
 *
 * 判据（v0.3）：**最后一个闭合 DSML 标签之后，只剩空白或极短的尾巴。**
 *
 * 为什么不用「去标签后长度」：
 *   半句话+残片 `我说完了</｜｜DSML｜｜ invoke>`（22 字）和
 *   正常讨论 `这个 </｜｜DSML｜｜ invoke> 标签是残片，我们查过…`（102 字）
 *   在长度上会混在一起，门槛调哪儿都会误伤一边。
 *
 *   但两者的**结构**不同：
 *     · 残片：标签是正文的结尾（`...invoke>` / `...calls>` 之后没内容）
 *     · 正常讨论：标签夹在句子中间，后面还有话
 *   所以只看「最后一个闭合标签之后还剩什么」，不受长度影响。
 *
 * 另外仍要求至少出现一个**闭合**标签：只提 `｜｜DSML｜｜` 字样、
 * 或只有开标签的文本，不视为泄露。
 *
 * @param {string} text
 * @param {number} [tailMax] 闭合标签之后允许的残留字符数（去空白后）
 * @returns {boolean}
 */
export function isPureDsmlFragment(text, tailMax = 2) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (!DSML_MARK_RE.test(text)) return false;

  // 找最后一个闭合标签的位置（v0.13：竖线根数不再固定）
  const closerRe = new RegExp('</\\s*' + DSML_MARK + '\\s*[^>]*>', 'gi');
  let lastEnd = -1;
  let m;
  while ((m = closerRe.exec(text)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < 0) return false; // 没有闭合标签 → 不是截断形态

  const tail = text.slice(lastEnd).replace(/\s+/g, '');
  return tail.length <= tailMax;
}

/**
 * 判断某个位置是否落在「被引用的代码」里 —— 围栏代码块或行内代码。
 *
 * 为什么要这一步（v0.7）：
 *   新判据「最后一个 DSML 标签之后没内容」会把
 *   「我复现了，日志里就是 `</｜｜DSML｜｜ invoke>`」这种正常解释也算成泄露。
 *   模型在正文里贴残片做示例是合理行为，尤其写复盘的时候。
 *   所以先排除掉「标签处在 ``` 围栏里」和「同一行里标签前面有未闭合的反引号」两种情形。
 *
 * @param {string} text 整段正文
 * @param {number} tagEnd 标签结束位置（下标）
 * @returns {boolean}
 */
export function isQuotedDsml(text, tagEnd) {
  if (typeof text !== 'string' || tagEnd <= 0) return false;
  const upto = text.slice(0, tagEnd);

  // 围栏代码块：``` 出现奇数次 → 这个位置还在块内
  const fences = upto.match(/```/g);
  if (fences !== null && fences.length % 2 === 1) return true;

  // 行内代码：同一行内、标签前面有奇数个反引号 → 包在 `…` 里
  const lineStart = upto.lastIndexOf('\n') + 1;
  const ticks = (upto.slice(lineStart).match(/`/g) ?? []).length;
  return ticks % 2 === 1;
}

/**
 * v0.7 的泄露判据：**最后一个 DSML 标签之后没有正文**（允许 ≤2 个空白外的字符）。
 *
 * 和 `isPureDsmlFragment` 的区别（两处）：
 *   1. 开标签也算。模型被截断时可能停在 `<｜｜DSML｜｜ parameter name="x">` 这种开标签上，
 *      旧判据要求「至少一个闭合标签」，这种形态直接漏掉。
 *   2. 排除代码引用（见 `isQuotedDsml`）。
 *
 * 为什么这条判据能覆盖「整段正文 + 尾巴残片」：
 *   泄露的结构是「正文写完了，本该发起工具调用，结果只吐出标签」——
 *   标签永远在**结尾**。正常讨论 DSML 时标签夹在句子中间，后面还有话，
 *   所以「后面没内容」这条不受正文长短影响，不会因为正文长就漏判。
 *
 * @param {string} text
 * @param {number} [tailMax] 最后一个标签之后允许的残留字符数（去空白后）
 * @returns {boolean}
 */
export function isDsmlTailFragment(text, tailMax = 2) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (!DSML_MARK_RE.test(text)) return false;

  const tagRe = new RegExp(DSML_TAG_SRC, 'gi');
  let lastEnd = -1;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < 0) return false; // 只有「｜｜DSML｜｜」字样，没有真正的标签
  if (isQuotedDsml(text, lastEnd)) return false;

  const tail = text.slice(lastEnd).replace(/\s+/g, '');
  return tail.length <= tailMax;
}

/** 纯标签噪声里允许残留的「可见字符」上限（去标签、去空白之后）。 */
const SOUP_MAX_VISIBLE = 2;
/** 判为标签噪声至少要出现的标签个数。 */
const SOUP_MIN_TAGS = 2;
/** 除思考/草稿族之外，算「内部标记」的标签名。 */
const SOUP_EXTRA_NAMES = [
  'parameter',
  'invoke',
  'function_call',
  'function_calls',
  'tool_call',
  'tool_calls',
  'tool_use',
  'antml',
];

/**
 * v0.12：判断一段正文是不是「只剩标签壳子的噪声」。
 *
 * 为什么需要这条判据（2026-11-21 定）：
 *   实测漏出的一条正文长这样：
 *     </thinking> </thinking> … </thinking> <parameter> </parameter>
 *   全是**闭合标签**，一个开标签都没有。
 *   已有的两条判据都管不到它：
 *     · `probeInternalTag` 只在正文**开头**是 `<` + 字母时才拦；`</thinking>` 的第二个字符是 `/`，
 *       直接按普通正文放行；`<parameter>` 名字不在思考/草稿族里，也放行。
 *     · `isDsmlTailFragment` 只认 DSML 的 `｜｜DSML｜｜` 标签，这些是普通尖括号标签，命不中。
 *   于是整段噪声被当成「真正文」计进 `realTextChars`，收尾那条「什么都没产出就重跑」的闸
 *   也因此不触发 —— 用户看到的是一屏 `</thinking>`。
 *
 * 判据（结构与长度分开看，和 `isDsmlTailFragment` 同一套思路）：
 *   1. 至少两个标签；
 *   2. 去掉所有标签、去掉空白之后，剩下的可见字符 ≤ `soupMaxVisible`；
 *   3. 至少一个标签名属于内部标记族（思考/草稿/parameter/invoke/antml…）。
 *   三条同时成立才算噪声。条件 3 是防误杀：`<b></b><i></i>` 这种空 HTML 不该被吃掉，
 *   而 `</thinking><parameter>` 这种只可能来自上游序列化。
 *
 * 代码引用（围栏块、行内反引号）里贴示例不受影响，见 `isQuotedDsml`。
 *
 * @param {string} text
 * @param {{maxVisible?:number, minTags?:number}} [options]
 * @returns {boolean}
 */
export function isInternalTagSoup(text, options = {}) {
  if (typeof text !== 'string' || text.length === 0) return false;
  const maxVisible = Number.isFinite(options.maxVisible) ? options.maxVisible : SOUP_MAX_VISIBLE;
  const minTags = Number.isFinite(options.minTags) ? options.minTags : SOUP_MIN_TAGS;

  const tagRe = /<\/?\s*([A-Za-z][A-Za-z0-9_-]*)(?:\s[^<>]*)?\/?>/g;
  let count = 0;
  let suspect = false;
  let lastEnd = -1;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    count += 1;
    lastEnd = m.index + m[0].length;
    if (!suspect) {
      const name = String(m[1] ?? '').toLowerCase();
      const family =
        THINK_TAG_PREFIXES.some((p) => name.startsWith(p)) ||
        DRAFT_TAG_PREFIXES.some((p) => name.startsWith(p)) ||
        SOUP_EXTRA_NAMES.some((p) => name === p || name.startsWith(p));
      if (family) suspect = true;
    }
  }
  if (count < minTags || !suspect) return false;
  if (lastEnd >= 0 && isQuotedDsml(text, lastEnd)) return false;

  const visible = text.replace(tagRe, '').replace(/\s+/g, '');
  return visible.length <= maxVisible;
}

/**
 * v0.8：判断「这段正文」是不是「那段推理内容」的副本。
 *
 * 为什么要这个判据（2026-11-14 定）：
 *   中转（openai-completions）会把 `reasoning_content` 原样复制进 `content`。
 *   某会话的 11 次失败尝试里，text 与 reasoning **逐字相同**（8/8 可比样本，
 *   长度 1235/1534/1593/2144/2587/2733/3404/3667 全等）。DSH 的适配器只从
 *   `choice.delta.content` 造 text 块，没有回填思考的路径，所以这是上游行为。
 *
 * 判据：去掉 DSML 标签、压缩空白后，两者开头至少重合 REASONING_COPY_MIN_OVERLAP 个字符，
 * 且一方是另一方的前缀（流式顺序不定：有时正文先到，有时思考后到）。
 * 用「前缀 + 最小重合长度」而不是全等，是因为两边都在流式增长。
 *
 * @param {string} text  累积的正文
 * @param {string} thought 累积的推理内容
 * @returns {boolean}
 */
/**
 * v0.22：套话判据 —— 「正文被上游换成了固定拒绝语」。
 *
 * 现场（2026-11-23，会话 f7bf07df）：5 次出现 `你好，我无法给到相关内容。`，
 * 每次都**同时**带着完整的 `run_code` 调用，且工具调用实际执行成功
 * （下一步的 `tool/result` 有正常输出）。也就是说：模型干了活，正文却被换成了这句话。
 *
 * 所以判据不能只看「像不像拒绝」，要看**这一轮到底有没有干活**：
 *   · 有工具调用 / 有救回的调用 → 这句话不可能是模型的真实结论（它正要跑工具）；
 *   · 正文很短（≤24 字，去掉空白）→ 真拒绝通常还会解释两句，不会这么齐整；
 *   · 与 reasoning 不同源 → 若 reasoning 以它开头，那本来就是模型自己说的。
 */
export const CANNED_REFUSALS = [
  '你好，我无法给到相关内容。',
  '抱歉，我无法提供相关内容。',
  '我无法提供相关内容',
  '我无法协助完成这个请求',
  'I cannot provide that content.',
  "I can't help with that.",
  "I'm unable to help with that request.",
];

/** 去掉所有空白，用于比对（避免 `\n你好…` 这种前缀漏判）。 */
const squeeze = (s) => String(s ?? '').replace(/\s+/g, '');

/** 泛化的「固定拒绝语」形状：短、无解释、只表拒绝。 */
const CANNED_SHAPE_RE =
  /^(?:你好|抱歉|对不起)?[，,]?(?:我)?(?:无法|不能|不便|恕不)(?:给到|提供|回答|协助|满足|回应|帮助)[^。]{0,12}(?:内容|信息|请求|问题)?[。.]?$/;

/**
 * 这段正文是不是「固定拒绝语」。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isCannedRefusal(text) {
  const sq = squeeze(text);
  if (sq.length === 0) return false;
  for (const c of CANNED_REFUSALS) {
    if (squeeze(c) === sq) return true;
  }
  // 泛化形状只在 12–40 字之间成立：太短是语气词，太长就带解释了（真拒绝）。
  if (sq.length < 12 || sq.length > 40) return false;
  return CANNED_SHAPE_RE.test(sq);
}

/**
 * 这段正文是不是「某条套话的开头」（用来在流式阶段先扣住，别把半句发出去）。
 *
 * 返回真只代表「还可能是套话」，块尾再用 {@link isCannedRefusal} 定夺。
 */
export function isCannedRefusalPrefix(text) {
  const sq = squeeze(text);
  if (sq.length === 0) return true; // 只有空白：还算前缀，等下一个 delta
  for (const c of CANNED_REFUSALS) {
    const target = squeeze(c);
    if (target.startsWith(sq)) return true;
  }
  return false;
}

export function looksLikeReasoningCopy(text, thought) {
  if (typeof text !== 'string' || typeof thought !== 'string') return false;
  const norm = (s) => s.replace(DSML_TAG, '').replace(/\s+/g, ' ').trim();
  const a = norm(text);
  const b = norm(thought);
  if (a.length < REASONING_COPY_MIN_OVERLAP || b.length < REASONING_COPY_MIN_OVERLAP) return false;
  const probe = a.slice(0, REASONING_COPY_MIN_OVERLAP);
  if (!b.startsWith(probe)) return false;
  // 短的一方必须是长的一方的前缀才算「同一段内容」
  const [shortSide, longSide] = a.length <= b.length ? [a, b] : [b, a];
  return longSide.startsWith(shortSide);
}

/**
 * 从 chunk 里取出「会进入正文」的 text。
 *
 * dsh-llm 的 chunk 协议（lib/types/assistant-stream.js）：
 *   { type: 'text-delta',      index, text }
 *   { type: 'reasoning-delta', index, text }
 *   { type: 'block-end',       block: { type: 'text' | 'reasoning' | 'tool-call', text } }
 *
 * 只收 `text-delta` 与 `block.type === 'text'`。
 * reasoning 不算 —— 推理内容里提到 DSML 标签是正常的，不该报警。
 *
 * @param {any} chunk
 * @returns {string|null}
 */
export function chunkText(chunk) {
  if (!chunk || typeof chunk !== 'object') return null;
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text;
  if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
    return chunk.block.text;
  }
  return null;
}

/**
 * v0.15（rescue 分支）：把「泄漏成纯文本的 DSML 工具调用」解析成真正的工具调用。
 *
 * 为什么要有这条路径（2026-11-22 定）：
 *   根因在中转的 chat template 不认模型吐出的原生工具调用标记，于是标记被当成
 *   **普通正文**塞进 \`content\`。插件在客户端改不了 broker 的解析结果，但能把
 *   这段正文**重新组装成 tool-call 分片**交给 DSH —— 这条路零额外请求、
 *   不打断前缀缓存、工具真的执行、副作用不重复（重跑整个 step 会重做已执行的写操作）。
 *
 * 安全边界（两道闸，任一不过就整体失败 → 调用方回落 retry）：
 *   1. 工具名必须在**本次请求声明的工具表**里（options.tools）；
 *   2. 每个调用的参数集必须能序列化成合法 JSON 对象。
 *   这样「正文里恰好写着一段工具调用示例」不会被当成真调用执行。
 *
 * @param {string} text 待解析的整块正文
 * @param {Iterable<string>} allowedNames 本次请求可见的工具名
 * @returns {{ok:boolean, reason:string|null, calls:{name:string,arguments:string}[], prose:string}}
 */
/**
 * v0.20：DSML 调用标签的元素名（与 `parseLeakedCalls` 里的 KNOWN 同源）。
 * 单独导出是为了让「退化标签扫描」和「影子救援」共用一份名单。
 */
export const CALL_TAG_NAMES = Object.freeze([
  'tool_calls',
  'tool-calls',
  'toolcalls',
  'calls',
  'invoke',
  'parameter',
]);

/**
 * v0.20：扫「竖线包元素名」的退化标签 —— `<` 与 DSML 字面都不在了。
 *
 * 这是 relay 吃掉 `<` 之后的残留形态，例如 `｜｜ invoke｜｜ name="…"`。
 * 返回与正常解析同构的 token；区间含前缀竖线与结尾 `>`。
 * 严格起见：必须两侧都有竖线，且元素名必须来自 `known`。
 */
export function scanBareTags(src, known) {
  const names = (known instanceof Set ? [...known] : Array.isArray(known) ? known : [])
    .filter((n) => typeof n === 'string' && n.length > 0)
    .join('|');
  if (names.length === 0) return [];
  const re = new RegExp('[｜|]+\\s*(\\/)?\\s*(' + names + ')\\s*(?=[｜|])[｜|]+\\s*([^<>]*)>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(String(src ?? ''))) !== null) {
    out.push({
      closing: (m[1] ?? '') === '/',
      name: String(m[2]).toLowerCase(),
      attrs: String(m[3] ?? '').trim(),
      start: m.index,
      end: re.lastIndex,
    });
    if (re.lastIndex === m.index) re.lastIndex += 1; // 防零宽匹配死循环
  }
  return out;
}

export function parseLeakedCalls(text, allowedNames = []) {
  const src = typeof text === 'string' ? text : '';
  // v0.19：每条结果都带一个 format 归因码 —— 排查时先看「这次是哪种毛病」。
  const format = classifyFormat(src);
  const fail = (reason, diag) => ({ ok: false, reason, calls: [], prose: '', format, diag: diag ?? null });
  if (src.length === 0) return fail('empty');

  const allowed = new Set(
    (Array.isArray(allowedNames) ? allowedNames : [])
      .map((n) => String(n ?? ''))
      .filter((n) => n.length > 0),
  );
  // 白名单为空说明拿不到本次工具表 —— 什么都不救，交给老路径。
  if (allowed.size === 0) return fail('no_allowlist');

  const KNOWN = new Set(['tool_calls', 'tool-calls', 'toolcalls', 'calls', 'invoke', 'parameter']);
  const tagRe = new RegExp('<' + '\\s*(\\/?)\\s*(?:' + RESCUE_MARK_SRC + ')\\s*([^<>]*)>', 'gi');

  const splitBody = (body) => {
    const s = String(body ?? '').trim();
    const m = /^([A-Za-z][A-Za-z0-9_-]*)?\s*([\s\S]*)$/.exec(s);
    return { name: String(m && m[1] ? m[1] : '').toLowerCase(), attrs: m && m[2] ? m[2] : '' };
  };
  const attrOf = (attrs, key) => {
    const re = new RegExp(String(key) + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i');
    const m = re.exec(String(attrs ?? ''));
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[2];
  };
  const decodeEntities = (s) =>
    String(s ?? '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');

  const tokens = [];
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    const body = splitBody(m[2]);
    if (!KNOWN.has(body.name)) continue; // 不是 DSML 工具调用标签：留给正文
    tokens.push({ closing: m[1] === '/', name: body.name, attrs: body.attrs, start: m.index, end: tagRe.lastIndex });
  }
  /**
   * v0.20：标记退到「连 `<` 和 DSML 字面都丢了、只剩竖线包着元素名」也要认。
   *
   * 为什么：relay 把 `<` 当 HTML 标签起始吃掉时，剩下的正是
   * `｜｜ invoke｜｜ name="…"` 这种形态；旧正则要求 `<`，于是整段原样吐给用户。
   * 只认 KNOWN 里的元素名、且必须两侧有竖线，正文里的普通竖线不会变成调用。
   */
  for (const t of scanBareTags(src, KNOWN)) {
    const dup = tokens.some((o) => t.start < o.end && o.start < t.end);
    if (!dup) tokens.push(t);
  }
  if (tokens.length > 1) tokens.sort((a, b) => a.start - b.start);
  if (tokens.length === 0) {
    /**
     * v0.19：`no_tag` 是历史最高频的失败原因（59/95），但旧日志只有一个
     * 「no_tag」+ 正文开头 160 字，看不出是「压根没有标记」还是
     * 「有标记但标签名不认识」。这里直接把数字记下来。
     */
    const marks = (src.match(new RegExp(DSML_TAG_SRC, 'gi')) ?? []).length;
    return fail('no_tag', {
      tags: 0,
      dsmlTags: marks,
      len: src.length,
      excerpt: src.slice(0, 120).replace(/\s+/g, ' '),
    });
  }

  /**
   * v0.19：把「在哪一步、被哪个标签撞死」定位出来。
   * 旧日志只有 reason，复现一次要翻整段正文；现在 at/tag/excerpt 直接够用。
   */
  const diagAt = (ti, extra = {}) => {
    const t = ti >= 0 && ti < tokens.length ? tokens[ti] : null;
    const at = t ? t.start : src.length;
    return {
      at,
      tag: t ? `${t.closing ? '/' : ''}${t.name}` : null,
      tokens: tokens.length,
      excerpt: src.slice(Math.max(0, at - 40), Math.min(src.length, at + 40)).replace(/\s+/g, ' '),
      ...extra,
    };
  };

  const calls = [];
  let prose = '';
  let cursor = 0;
  let openInvoke = null;
  let openParam = null;

  const pushContent = (s) => {
    if (s.length === 0) return;
    if (openParam) openParam.chunks.push(s);
    else if (openInvoke) return; // invoke 内部、parameter 之外的杂字丢掉（不进正文也不进参数）
    else prose += s;
  };

  for (let ti = 0; ti < tokens.length; ti += 1) {
    const t = tokens[ti];
    pushContent(src.slice(cursor, t.start));
    cursor = t.end;

    if (t.name === 'tool_calls' || t.name === 'tool-calls' || t.name === 'toolcalls' || t.name === 'calls') {
      continue;
    }
    if (t.name === 'invoke') {
      if (t.closing) {
        if (openInvoke === null) return fail('unpaired_invoke', diagAt(ti));
        if (openParam !== null) {
          return fail('unpaired_param', diagAt(ti, { openParam: openParam.name, openInvoke: openInvoke.name }));
        }
        const args = {};
        for (const p of openInvoke.params) args[p.name] = p.value;
        calls.push({ name: openInvoke.name, args });
        openInvoke = null;
      } else {
        if (openInvoke !== null) return fail('nested_invoke', diagAt(ti, { openInvoke: openInvoke.name }));
        const n = attrOf(t.attrs, 'name');
        if (!n) return fail('invoke_no_name', diagAt(ti));
        /**
         * v0.20：标记没洗干净时，残留竖线会粘在工具名上（`｜｜ invoke`）。
         * 两头剥掉再比白名单 —— 否则一条本来能救回的调用会被判成 unknown_tool。
         */
        const toolName = String(n).replace(/^[｜|\s]+|[｜|\s]+$/g, '').trim();
        if (!toolName) return fail('invoke_no_name', diagAt(ti));
        openInvoke = { name: toolName, params: [] };
      }
      continue;
    }
    // parameter
    if (t.closing) {
      if (openParam === null || openInvoke === null) {
        return fail('unpaired_param', diagAt(ti, {
          openParam: openParam ? openParam.name : null,
          openInvoke: openInvoke ? openInvoke.name : null,
        }));
      }
      const raw = decodeEntities(openParam.chunks.join(''));
      let value = raw;
      if (!openParam.isString) {
        try {
          value = JSON.parse(raw);
        } catch {
          value = raw;
        }
      }
      openInvoke.params.push({ name: openParam.name, value });
      openParam = null;
    } else {
      if (openInvoke === null) return fail('param_outside_invoke', diagAt(ti));
      if (openParam !== null) return fail('nested_param', diagAt(ti, { openParam: openParam.name }));
      const pn = attrOf(t.attrs, 'name');
      if (!pn) return fail('param_no_name', diagAt(ti));
      const isString = String(attrOf(t.attrs, 'string') ?? 'true').toLowerCase() !== 'false';
      openParam = { name: String(pn).trim(), isString, chunks: [] };
    }
  }
  pushContent(src.slice(cursor));

  if (openInvoke !== null || openParam !== null) {
    return fail('unpaired', diagAt(-1, {
      openInvoke: openInvoke ? openInvoke.name : null,
      openParam: openParam ? openParam.name : null,
    }));
  }
  if (calls.length === 0) return fail('no_invoke', diagAt(-1));

  const out = [];
  for (const call of calls) {
    if (!allowed.has(call.name)) {
      return fail('unknown_tool', diagAt(-1, {
        tool: call.name,
        allowed: allowedNames.length,
        allowedSample: (Array.isArray(allowedNames) ? allowedNames : []).slice(0, 8),
      }));
    }
    let json;
    try {
      json = JSON.stringify(call.args);
    } catch {
      return fail('bad_args', diagAt(-1, { tool: call.name, why: 'stringify' }));
    }
    if (typeof json !== 'string' || json.length < 2 || json[0] !== '{') {
      return fail('bad_args', diagAt(-1, { tool: call.name, why: 'not-object' }));
    }
    out.push({ name: call.name, arguments: json });
  }

  const cleanProse = prose.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // 残留标记说明还有没配对的标签：宁可回落重跑，也不交出半截调用。
  if (DSML_MARK_RE.test(cleanProse)) {
    return fail('leftover_mark', diagAt(-1, { proseLength: cleanProse.length }));
  }

  return {
    ok: true,
    reason: null,
    calls: out,
    prose: cleanProse,
    format,
    // v0.19：AGENTS.md「工具调用避错」里能静态看出来的坑，逐条标注。
    lint: lintToolCalls(out),
  };
}

/**
 * v0.19：归因 —— 这条泄漏/残片在**格式**上到底哪里坏了。
 *
 * 用户要看的是「这次又是什么毛病」，而不是「又拦了一条」。
 * 日志里的 `format` 字段就是下面这些短码之一，一行统计即可看趋势。
 *
 * 取值：
 *   empty              空串
 *   no_dsml            没有 DSML 标记（普通正文）
 *   think_tag          字面思考标签（thinking/thought/reasoning/reflection）
 *   single_pipe        竖线退化成单根：`｜DSML｜` / `|DSML|`，v0.13 前会整条漏过
 *   param_without_invoke  有 parameter、没有 invoke（残片从中间开始的典型形态）
 *   closed_only        只有闭合标签，没有开标签
 *   unclosed_invoke    有开 invoke、无闭合
 *   tags_only          只有标签，剥完一个字不剩
 *   prose_plus_tags    正文后面挂着标签
 */
export function classifyFormat(text) {
  const src = typeof text === 'string' ? text : '';
  if (src.trim().length === 0) return 'empty';

  // 标准形态是「两侧各至少一根竖线」。某一侧整根丢了（`｜DSML` / `DSML｜` /
  // 干脆没有竖线）就是退化 —— 这正是 v0.13 之前整条漏过的形态。
  // 判据：松匹配（竖线可有可无）比严匹配（两侧都要有）多出来的那些就是退化。
  const strictMarks = (src.match(new RegExp(DSML_MARK, 'gi')) ?? []).length;
  const looseMarks = (src.match(/(?:[｜|]\s*)?[Dd][SsＳｓ][MmＭｍ][LlＬｌ](?:\s*[｜|])?/g) ?? []).length;
  if (looseMarks > strictMarks) return 'single_pipe';
  if (strictMarks === 0) {
    return /(?:<|&lt;)\/?(?:thinking|thought|reasoning|reflection)\b/i.test(src) ? 'think_tag' : 'no_dsml';
  }

  const tagRe = new RegExp('<' + '\\s*(\\/?)\\s*(?:' + RESCUE_MARK_SRC + ')\\s*([^<>]*)>', 'gi');
  let openInvoke = 0;
  let closeInvoke = 0;
  let openParam = 0;
  let insideInvoke = 0;
  let prose = '';
  let cursor = 0;
  let m;
  while ((m = tagRe.exec(src)) !== null) {
    // invoke 内部的文字是参数值，不是正文 —— 只累计 invoke 之外的文字。
    if (insideInvoke === 0) prose += src.slice(cursor, m.index);
    cursor = tagRe.lastIndex;
    const nm = /^[A-Za-z][A-Za-z0-9_-]*/.exec(String(m[2] ?? '').trim());
    const name = String(nm ? nm[0] : '').toLowerCase();
    const closing = m[1] === '/';
    if (name === 'invoke') {
      if (closing) {
        closeInvoke += 1;
        insideInvoke = Math.max(0, insideInvoke - 1);
      } else {
        openInvoke += 1;
        insideInvoke += 1;
      }
    }
    if (name === 'parameter' && !closing) openParam += 1;
  }
  if (insideInvoke === 0) prose += src.slice(cursor);

  if (openParam > 0 && openInvoke === 0) return 'param_without_invoke';
  if (prose.trim().length > 0) return 'prose_plus_tags';
  if (closeInvoke > 0 && openInvoke === 0) return 'closed_only';
  if (openInvoke > closeInvoke) return 'unclosed_invoke';
  return 'tags_only';
}

/**
 * v0.19：AGENTS.md「工具调用避错」表里那些**能静态看出来**的坑。
 *
 * 为什么放在守卫里：这些坑的报错都发生在工具执行之后（甚至整段程序不执行），
 * 事后翻会话才知道是哪一条。守卫在**调用落地的那一刻**就能标注，
 * 日志里直接是「这条调用踩了哪条纪律」，不用再人肉对表。
 *
 * 只标不拦：命中返回 code，调用照常执行 —— 守卫没有资格替用户改调用。
 */
export const TOOLCALL_RULES = Object.freeze({
  removed_tool_name: '已移除的工具名 → 用 ops_* 真名（pwsh/read/grep/glob 已不存在）',
  recursive_grep_in_bash: 'bash 里递归 grep 会超时 → 用 ops_grep（path 只给一层 + 排除 glob）',
  shell_heredoc: 'PowerShell 没有 heredoc → 多行脚本先落盘成 .py/.sh 再跑',
  literal_dsml_mark: '参数里写了字面 DSML/思考标记 → 用字符串拼接构造，否则会被守卫截断',
  brace_glob: 'ops_grep 不支持花括号 glob → 拆成多个数组项',
  proxy_noproxy_missing: '测代理要 --noproxy，否则 curl 读 NO_PROXY 直接连出去',
  broad_grep_path: 'ops_grep 的 path 给到了家目录/盘符根 → 只给真正需要的那一层',
  grep_without_exclude: 'ops_grep 没带排除 glob → 加 !**/node_modules/**、!**/.venv/**',
  ps_dollar_expansion: '命令里的 $_(上条参数) / $env: / $() 会被 bash 先展开 → 整条用单引号包或改写',
  runcode_toplevel_let: 'run_code 顶层 let/const 跨程序存活会重名 → 换新变量名或整体包进 { }',
});

const REMOVED_TOOLS = Object.freeze({
  pwsh: 'ops_bash',
  read: 'ops_inspect_local_file',
  grep: 'ops_grep',
  glob: 'ops_glob',
});

/**
 * @param {{name:string, arguments?:string, args?:object}[]} calls
 * @returns {{code:string, tool:string, hint:string, detail?:string}[]}
 */
export function lintToolCalls(calls = []) {
  const list = Array.isArray(calls) ? calls : [];
  const hits = [];
  const seen = new Set();
  const push = (code, tool, detail) => {
    const key = `${code}|${tool}|${detail ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ code, tool, hint: TOOLCALL_RULES[code] ?? '', detail: detail ?? null });
  };

  for (const call of list) {
    const name = String(call && call.name ? call.name : '');
    if (!name) continue;
    if (REMOVED_TOOLS[name]) push('removed_tool_name', name, `${name} → ${REMOVED_TOOLS[name]}`);

    let args = call && typeof call.args === 'object' && call.args ? call.args : null;
    if (!args && typeof (call && call.arguments) === 'string') {
      try {
        args = JSON.parse(call.arguments);
      } catch {
        args = null;
      }
    }
    const raw = args ? JSON.stringify(args) : String((call && call.arguments) || '');
    if (raw.length === 0) continue;
    const lower = raw.toLowerCase();

    if (hasDsmlTag(raw) || /(?:<|&lt;)\/?(?:thinking|thought|reasoning|reflection)\b/i.test(raw)) {
      push('literal_dsml_mark', name);
    }

    const cmd = String((args && (args.command ?? args.cmd ?? args.script ?? args.code)) ?? '');
    if (cmd) {
      if (/\bgrep\b[^|;&]{0,80}\s-[A-Za-z]*[rR]/.test(cmd)) push('recursive_grep_in_bash', name);
      if (/\b(python3?|node|bash|sh|pwsh|powershell)(\.exe)?\s+-\s*<<\s*['"]?[A-Za-z_]/.test(cmd)) {
        push('shell_heredoc', name);
      }
      if (/\bcurl\b/.test(cmd) && /(\s-x\s|--proxy\s)/.test(cmd) && /(localhost|127\.0\.0\.1)/.test(cmd)
        && !/--noproxy/.test(cmd)) {
        push('proxy_noproxy_missing', name);
      }
      // AGENTS.md「PS 报 Unexpected token，路径被当代码」：`$_` / `$env:` / `$(...)`
      // 在 bash 里先展开，命令到 PowerShell 时已经变形。
      if (/\b(powershell|pwsh)(\.exe)?\b/.test(cmd) && /(\$_|\$env:|\$\(\s*\w)/.test(cmd)) {
        push('ps_dollar_expansion', name);
      }
    }

    // ops_grep 的两条纪律：path 只给一层；必须带排除 glob。
    if (name === 'ops_grep' && args) {
      const p = String(args.path ?? '');
      if (p && /(^\/c\/Users(\/a)?\/?$)|(^\/c\/?$)|(^\/?$)|(^[A-Za-z]:\\?$)/.test(p)) {
        push('broad_grep_path', name, p);
      }
      const globArg0 = args.glob;
      const hasGlob = Array.isArray(globArg0) ? globArg0.length > 0 : Boolean(globArg0);
      const excludes = Array.isArray(globArg0)
        ? globArg0.filter((g) => String(g).startsWith('!')).length
        : String(globArg0 ?? '').startsWith('!') ? 1 : 0;
      if (hasGlob && excludes === 0) push('grep_without_exclude', name);
    }

    // run_code 顶层 let/const 会跨程序存活（重名 = 整段不执行）。
    if (args && typeof args.code === 'string') {
      const topLevel = args.code.split('\n').some((l) => /^(let|const)\s/.test(l));
      if (topLevel) push('runcode_toplevel_let', name);
    }

    const globArg = args && args.glob ? args.glob : null;
    const globText = Array.isArray(globArg) ? globArg.join(' ') : String(globArg ?? '');
    if (globText && /[A-Za-z0-9_*?.-]*\{[^}]*,[^}]*\}/.test(globText)) push('brace_glob', name);
  }
  return hits;
}

/**
 * v0.15：从 \`llm/stream\` 的 options 里取出本次请求可见的工具名。
 *
 * 依据：\`@deepseek-ai/dsh-llm-pi-ai/lib/index.js\` 用 \`toolsOf(options)\` 取工具，
 * 说明 waterfall 的 options 就是完整请求；\`options.tools\` 可能是
 * \`{name}\` 或 \`{function:{name}}\` 两种形态，都认。
 */
export function collectToolNames(options) {
  const raw = Array.isArray(options?.tools) ? options.tools : [];
  const names = [];
  for (const t of raw) {
    const n =
      typeof t?.name === 'string' && t.name.length > 0
        ? t.name
        : typeof t?.function?.name === 'string' && t.function.name.length > 0
          ? t.function.name
          : null;
    if (n !== null && !names.includes(n)) names.push(n);
  }
  return names;
}

/** 把一行事件追加到日志文件；任何失败都静默吞掉，绝不影响主流程。 */
export function appendLine(file, payload) {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // 写日志失败不能影响模型流
  }
}

/** 内存计数 + 日志落盘。 */
class LeakMeter {
  constructor(logger, logFile) {
    this.logger = logger;
    this.logFile = logFile;
    this.total = 0;
    this.byStep = new Map();
  }

  record(detail) {
    this.total += 1;
    const key = `${detail.provider || '?'}/${detail.model || '?'}`;
    this.byStep.set(key, (this.byStep.get(key) || 0) + 1);
    const line =
      `[DSML-LEAK] #${this.total} provider=${detail.provider} model=${detail.model} ` +
      `snippet=${JSON.stringify(detail.snippet)}${detail.replaced ? ' (已拦截)' : ''}`;
    this.logger?.warn?.(line);
    appendLine(this.logFile, {
      at: new Date().toISOString(),
      kind: 'leak',
      seq: this.total,
      provider: detail.provider ?? null,
      model: detail.model ?? null,
      snippet: detail.snippet,
      textLength: detail.textLength ?? null,
      replaced: detail.replaced === true,
    });
  }

  summary() {
    return {
      total: this.total,
      byRoute: Object.fromEntries(this.byStep),
    };
  }
}

/**
 * 一条流的正文累积器。
 *
 * 设计原则：只读不改。缓冲内容仅用于判定，永不参与返回。
 */
export class TextAssembler {
  constructor() {
    this.buffer = '';
    this.closed = false;
  }

  /** 追加一段正文。 */
  push(text) {
    if (this.closed) return;
    this.buffer += text;
    // 防御：缓冲别无限长（正常响应也就几千字）
    if (this.buffer.length > 200_000) {
      this.buffer = this.buffer.slice(-100_000);
    }
  }

  /** 把 block-end 的整块文本并入（可能与逐块累积重复，用重建而非拼接）。 */
  absorbBlock(text) {
    if (this.closed) return;
    // block-end 带的是这一块的**完整**文本；若它更长，以它为准。
    if (typeof text === 'string' && text.length >= this.buffer.length) {
      this.buffer = text;
    }
  }

  /** 取当前累积的正文。 */
  text() {
    return this.buffer;
  }

  /** 标记这一块正文结束，之后 push 会忽略（直到 reset）。 */
  finish() {
    this.closed = true;
  }

  /** 开始下一块正文。 */
  reset() {
    this.buffer = '';
    this.closed = false;
  }
}

/* ───────────────────────── v0.20：流式扣留 ───────────────────────── */

/**
 * v0.20：普通正文**常驻不发表**的尾部字数。
 *
 * 为什么需要一段尾巴：`</parameter>` / `</invoke>` 这类闭合标签，只有在
 * `<` 出现的那一刻才开始有嫌疑；而 `<` 到 `>` 之间可能跨 chunk。把最后
 * 几十字压住不发，就能在「开标签已经流出去、闭合标签刚到时」把它抓回来。
 *
 * 为什么是 0（2026-11-23 定稿）：最终实现走的是「一出现嫌疑字符就不发表」，
 * 而不是「先发表、发现不对再收回」—— 流是单向的，发出去的字节收不回来，
 * 所谓「可控窗口」只能是**还没发出去**的那一段。于是纯正文一个字都不用压，
 * 逐块透传的字面量成立（有测试盯着）；需要窗口的调用方可以显式传 `tail`。
 */
/**
 * v0.21：哪些 `format` 属于「散文里散落标签」。
 *
 * 只有这类形态 + `looksLikeReasoningCopy()` 判真，才走「纯副本抑制」：
 * 真正的调用被切断会落在 `unclosed_invoke` / `tags_only` / `closed_only`，
 * 不在这里 —— 抑制不能误伤「模型真的想调工具」。
 */
const COPY_FORMATS = new Set(['prose_plus_tags', 'param_without_invoke']);

const HOLDBACK_TAIL = 0;

/** v0.20：单块最长扣留。超过就原样放行 —— 绝不吞内容。 */
const HOLDBACK_MAX = 8192;

/** v0.20：跨块携带上限（开标签在上一块、闭合标签在这一块时靠它拼回来）。 */
const HOLDBACK_CARRY_MAX = 8192;

/**
 * v0.20：可能出现在「调用片段」里的标签名。
 * 只有这些名字的 `<...>` 才值得扣留；`<div>`、`a < b` 这种立刻放行。
 */
const HOLDBACK_TAG_NAMES = Object.freeze([
  'invoke', 'parameter', 'tool_calls', 'tool-calls', 'toolcalls', 'calls',
  'thinking', 'thought', 'reasoning', 'reflection', 'analysis', 'draft', 'summary',
]);

/** 宽口径剥离：DSML 标记允许零竖线（退化形态）。 */
const RESCUE_TAG_ANY = new RegExp('<\\s*\\/?\\s*(?:' + RESCUE_MARK_SRC + ')\\s*[^<>]*>', 'gi');

/**
 * v0.20：把一段文本里的 DSML 标签全部剥掉，留下正文。
 *
 * 用途：`unpaired_param` 那 35 例其实是**正文里挂着没有开标签的闭合标签**
 * （relay 把 reasoning 复制进 content，思考里提到过 `</parameter>`）。
 * 它们不是调用，救不回来也不该整步重跑 —— 剥掉标签、正文照发。
 */
/**
 * v0.20.1：找出「还没闭合的 invoke」在文本里的起始位置；没有就返回 -1。
 *
 * 为什么需要：跨块回溯原先只在**相邻两块**之间传递 carry。真实流量里一条调用
 * 可能被切成三块以上（正文碎片 + 参数很长），中间那块结束时既没有闭合标签、
 * 也没有半截标签可携带，于是整条调用还是丢。这里给出「从哪一刀开始要接着扣」。
 */
/**
 * v0.20.1：把「孤立的闭合标签」从即将下发的正文里剥掉。
 *
 * 为什么要剥：收紧之后孤立闭合标签不再扣留（它没有可等的另一半），
 * 但它是模型输出里的元字符，**不能让用户看见** `</｜DSML｜ parameter>` 这种东西。
 * 只剥完整标签、只剥闭合形状 —— 开标签仍由扣留那条路管，散文一个字都不动。
 */
export function stripCloserTags(text) {
  const src = String(text ?? '');
  if (!/DSML|[｜|]\s*(?:invoke|parameter)/i.test(src)) return src;
  return src
    .replace(new RegExp('<\\s*\\/\\s*(?:' + RESCUE_MARK_SRC + ')\\s*[^<>]*>', 'gi'), '')
    .replace(new RegExp('(?:[｜|]+\\s*)+\\/\\s*(?:invoke|parameter|calls)\\s*(?:[｜|]+\\s*)*>?', 'gi'), '');
}

export function unclosedInvokeStart(text) {
  const src = String(text ?? '');
  const re = new RegExp(
    '<\\s*(\\/?)\\s*(?:' + RESCUE_MARK_SRC + ')\\s*([^<>]*)>|[｜|]+\\s*(\\/)?\\s*(invoke)\\s*[｜|]+\\s*([^<>]*)>',
    'gi',
  );
  const stack = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const closing = m[1] === '/' || m[3] === '/';
    const body = String(m[2] ?? m[5] ?? '');
    const nm = /^[A-Za-z][A-Za-z0-9_-]*/.exec(body.trim());
    const name = String(nm ? nm[0] : (m[4] ?? '')).toLowerCase();
    if (name !== 'invoke') continue;
    if (closing) stack.pop();
    else stack.push(m.index);
    if (re.lastIndex === m.index) re.lastIndex += 1;
  }
  return stack.length > 0 ? stack[stack.length - 1] : -1;
}

export function stripLeakedTags(text) {
  return String(text ?? '').replace(RESCUE_TAG_ANY, '');
}

/** 竖线/空白之后，标记名是否还只是 `dsml` 的前缀。 */
function markerRun(buf, at) {
  let i = at;
  while (i < buf.length && (buf[i] === '｜' || buf[i] === '|')) i += 1;
  while (i < buf.length && /\s/.test(buf[i])) i += 1;
  let letters = '';
  let closed = false;
  let j = i;
  for (; j < buf.length; j += 1) {
    const ch = buf[j];
    const norm = ch.normalize('NFKC').toLowerCase();
    if (/[a-z]/.test(norm)) {
      letters += norm;
      if (letters.length > 4) break;
      continue;
    }
    if (ch === '｜' || ch === '|') closed = true;
    break;
  }
  const isMarkerWord = 'dsml'.startsWith(letters) && letters.length > 0;
  if (!isMarkerWord) {
    /**
     * v0.20：只有竖线、后面还没来东西（`｜` / `｜｜` / `｜ ｜`）时，它也
     * 可能是标记的开头 —— 先扣住，等下一块再判。到块尾仍没补齐就原样放行，
     * 所以正文不会因此卡住，最多晚一个 chunk。
     */
    if (j >= buf.length && letters.length === 0 && i >= buf.length) {
      return { kind: 'marker_prefix' };
    }
    return { kind: 'text' };
  }
  if (letters.length < 4) return { kind: 'marker_prefix' };
  // letters === 'dsml'：后面紧跟竖线（或输入到此为止）才算标记
  if (closed) return { kind: 'marker' };
  if (j >= buf.length) return { kind: 'marker' }; // 标记名已完整，竖线可能下一块才来
  return { kind: 'text' };
}

/** 从 `<` 起判断这个尖括号开的是什么。 */
function tagRun(buf, at, openCount) {
  let i = at + 1;
  while (i < buf.length && /\s/.test(buf[i])) i += 1;
  let closing = false;
  if (buf[i] === '/') {
    closing = true;
    i += 1;
    while (i < buf.length && /\s/.test(buf[i])) i += 1;
  }
  /**
   * v0.20：`<` 后面直接跟竖线（`<｜｜DSML｜｜ …`，以及退化的 `<｜`）——
   * 竖线是标记本身，不是元素名的一部分。不跳过它，整条标签会被判成正文放出去，
   * 用户那边就看见半个 `<｜`。
   */
  while (i < buf.length && (buf[i] === '\uFF5C' || buf[i] === '|')) i += 1;
  if (i >= buf.length) return { kind: 'tag_prefix' };
  let name = '';
  let j = i;
  for (; j < buf.length; j += 1) {
    const ch = buf[j];
    if (/[A-Za-z0-9_-]/.test(ch)) {
      name += ch.toLowerCase();
      if (name.length > 12) return { kind: 'text' };
      continue;
    }
    break;
  }
  const terminated = j < buf.length;
  if (name.length === 0) {
    // `<` 后面还是空白/斜线/什么都没来：可能是标签开头，先等等
    return { kind: terminated ? 'text' : 'tag_prefix' };
  }
  const known = HOLDBACK_TAG_NAMES.some((n) => n.startsWith(name));
  if (!known && !'dsml'.startsWith(name)) return { kind: 'text' };
  if (!terminated) return { kind: 'tag_prefix' };
  const exact = HOLDBACK_TAG_NAMES.includes(name);
  if (!exact && !name.startsWith('dsml')) return { kind: 'text' };
  if (closing && openCount <= 0) return { kind: 'unpaired' };
  return { kind: 'tag' };
}

/**
 * v0.20：流式扣留器。
 *
 * 老行为（v0.19 及以前）在 `rescue` 档把**整段正文一律扣住**，直到块尾才判：
 * 这既让普通回答失去流式手感，又救不回任何东西 —— 开标签在上一块、闭合标签
 * 在这一块时，上一块已经被判成 `unpaired_param` 丢掉了。日志里
 * `rescued = 0 / rescue-failed = 99` 就是这个结构性后果。
 *
 * 新行为分三档，全部**有界**：
 *   1. 纯正文 → 只压住最后 `tail` 个字，其余逐块透传（观感不变）；
 *   2. 出现疑似调用开头（退化标记、单竖线、`<inv`、`</parameter>`）
 *      → 从那个字符起整段扣住，等补齐；
 *   3. 到块尾/流尾/超过 `maxHold` 还没补齐 → 原样放行，并把这一段
 *      尾巴**带进下一块**（`carry`），让跨块的调用仍有机会被拼回来。
 */
export class StreamHoldback {
  constructor(opts = {}) {
    this.tail = Number.isFinite(opts.tail) ? Math.max(0, opts.tail) : HOLDBACK_TAIL;
    this.maxHold = Number.isFinite(opts.maxHold) ? Math.max(1, opts.maxHold) : HOLDBACK_MAX;
    this.buf = '';
    this.carry = '';
    this.holdKind = '';
    this.emitted = 0;
    this.held = 0;
    this.gaveUp = 0;
    this.reasons = Object.create(null);
  }

  /** 攒一段正文，返回现在可以下发的片段（按顺序）。 */
  feed(text) {
    if (typeof text === 'string' && text.length > 0) this.buf += text;
    return this.drain(false);
  }

  /** 块结束/流结束：把手里剩下的全交出去（`final` 时不再保留尾巴）。 */
  flush(final = true) {
    return this.drain(final);
  }

  /**
   * 块边界。返回带进下一块的尾巴。
   *
   * 只携带「真的像调用片段」的尾巴（含标记或尖括号）；纯正文尾巴不携带，
   * 因为它本来就在 `block.text` 里，带了会被解析器当成重复内容。
   */
  endBlock() {
    const held = this.buf;
    this.buf = '';
    this.held += held.length;
    /**
     * 只有「真的像调用片段」的尾巴才带进下一块：退化标记、完整标记、
     * 已经开出来的已知标签、以及配不上开标签的闭合标签。
     *
     * 纯正文尾巴，或只是一个孤零零的 `<`（正文里「a < b」太常见），都不带 ——
     * 带了会把下一块的解析输入污染成 `no_tag`，日志里全是假失败。
     */
    const carryKinds = new Set(['marker', 'marker_prefix', 'tag', 'unpaired']);
    const carryable =
      held.length > 0 && held.length <= HOLDBACK_CARRY_MAX && carryKinds.has(this.holdKind);
    this.carry = carryable ? held : '';
    this.holdKind = '';
    return { carried: this.carry, held };
  }

  /** 取走跨块携带段（拼到下一块的解析输入前面）。 */
  takeCarry() {
    const out = this.carry;
    this.carry = '';
    return out;
  }

  /** 统计（写日志用；不含正文）。 */
  stats() {
    return {
      emitted: this.emitted,
      held: this.held,
      carry: this.carry.length,
      gaveUp: this.gaveUp,
      reasons: { ...this.reasons },
    };
  }

  /** 缓冲里最早一个「可能是调用开头」的位置。 */
  riskAt() {
    const buf = this.buf;
    let open = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const c = buf[i];
      if (c === '｜' || c === '|') {
        const st = markerRun(buf, i);
        if (st.kind === 'marker' || st.kind === 'marker_prefix') return { at: i, kind: st.kind };
        continue;
      }
      if (c !== '<') continue;
      const st = tagRun(buf, i, open);
      if (st.kind === 'text') continue;
      /**
       * v0.20.1：闭合标签本身不是调用证据，开标签才是。
       *
       * 生产复盘（2026-11-23，5,024 行日志）里 57 条 `unpaired*` 全部是
       * 「英文散文 + 末尾贴的 `</｜｜DSML｜｜ parameter>`」：`diag.openInvoke`/`openParam`
       * 57/57 为 null，失败点离末尾只有 21–134 字，救回 0 条；同一批数据里两个
       * finish 事件却因此把 12,532 字压到末尾才吐（最大一块压掉 9,537/10,466 = 91%）。
       * 所以孤立的闭合标签一律当正文照常下发 —— 它没有可等的「另一半」，
       * 扣住它只会延迟正文。（真调用片段一定带着未闭合的开标签，那条路照旧扣。）
       */
      if (st.kind === 'unpaired') {
        /**
         * 跳过整条标签，而不是只跳过 `<`：标签里自带 `｜DSML｜` 标记，
         * 从下一个字符继续扫会在 `｜` 上再判出一个 `marker` —— 等于绕个弯
         * 又把这枚闭合标签扣住了（v0.20.1 第一版就栽在这，4 条用例当场红）。
         */
        const gt = buf.indexOf('>', i);
        if (gt >= 0) {
          i = gt;
          continue;
        }
        return null;
      }
      if (st.kind === 'tag') open += 1;
      return { at: i, kind: st.kind };
    }
    return null;
  }

  drain(final) {
    const out = [];
    /**
     * v0.20.1：放行前剥掉孤立闭合标签。`this.emitted` 记**消费掉**的原始字数
     * （内部账本要跟 buf 对齐），`out` 里给用户的只有正文。
     */
    const push = (piece) => {
      if (piece.length === 0) return;
      const clean = stripCloserTags(piece);
      if (clean.length > 0) out.push(clean);
    };
    let guard = 0;
    while (guard++ < 256) {
      const hit = this.riskAt();
      if (!hit) {
        const keep = final ? 0 : Math.min(this.tail, this.buf.length);
        const cut = this.buf.length - keep;
        if (cut > 0) {
          push(this.buf.slice(0, cut));
          this.emitted += cut;
          this.buf = this.buf.slice(cut);
        }
        return out;
      }
      if (hit.at > 0) {
        push(this.buf.slice(0, hit.at));
        this.emitted += hit.at;
        this.buf = this.buf.slice(hit.at);
      }
      /**
       * 到这里 buf 以「嫌疑片段」开头。三种去向：
       *   · 已经补齐成完整标记/标签 → 继续等（它可能是真调用），由 maxHold 兜底；
       *   · 只是前缀 → 继续等；
       *   · 不得不放（final / 超上限）→ 原样吐出去，一个字节都不吞。
       */
      const overflow = this.buf.length >= this.maxHold;
      if (final || overflow) {
        if (overflow) this.gaveUp += 1;
        this.reasons[hit.kind] = (this.reasons[hit.kind] ?? 0) + 1;
        push(this.buf);
        this.emitted += this.buf.length;
        this.buf = '';
        return out;
      }
      this.reasons[hit.kind] = (this.reasons[hit.kind] ?? 0) + 1;
      this.holdKind = hit.kind;
      return out;
    }
    return out;
  }
}

export const name = 'dsml-guard';

// 注意：cordis 的 inject 声明形式在这个版本里是**扁平对象**，
// 服务名直接做键。写成 { required: [...], optional: [...] } 会被当成
// 两个叫 "required"、"optional" 的服务而永远 pending（实测于 2026-11-08）。
export const inject = {
  llm: { required: true },
};

/**
 * Cordis 插件入口。
 *
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config = {}) {
  // 默认日志路径：$DSH_HOME/logs/dsml-guard.log，DSH_HOME 未设时落 ~/.dsh/logs。
  // v0.14 起不再用「插件目录上溯两级」——插件装进 profile 的 node_modules 之后，
  // 那个相对路径会指到 <profile>/logs，跟 DSH 自己的日志目录分家。
  // 本机（qqbot/logs/dsml-guard.log）由 cordis.patch.yml 的 config.logFile 固定住。
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
  const defaultLog = join(dshHome, 'logs', 'dsml-guard.log');
  const logFile =
    typeof config.logFile === 'string' && config.logFile.length > 0 ? config.logFile : defaultLog;

  // 插件被加载这件事本身也留痕 —— 用来确认它到底有没有挂上。
  // v0.7 起带 version：改完代码要能一眼看出运行中的是哪个版本，
  // 否则只能靠文件 mtime 和 pid 猜（boot 行和 v0.6 长得一模一样）。
  appendLine(logFile, {
    at: new Date().toISOString(),
    kind: 'boot',
    version: GUARD_VERSION,
    pid: process.pid,
    enabled: config.enabled !== false,
    logFile,
  });

  const enabled = config.enabled !== false;
  if (!enabled) {
    ctx.logger?.info?.('[dsml-guard] disabled by config');
    return;
  }

  /**
   * 命中残片后做什么。三档：
   *
   *   'observe' —— 只记日志，原样透传。最保守。
   *   'replace' —— 换成一句提示，让对话继续往前。残片不进历史，代价是
   *                这一轮的正文没了。
   *   'retry'   —— **发一个失败分片，让 DSH 自己重跑这一步**。
   *                这是真正「不打断任务」的档：agent loop 在同一个打开的
   *                轮次内重跑失败步骤，已完成的工具结果全部保留。
   *
   * 兼容老配置：`intercept: true` 且没写 `leakAction` 时按 'replace' 走。
   */
  const leakActionMode = (() => {
    const raw = typeof config.leakAction === 'string' ? config.leakAction.trim().toLowerCase() : '';
    if (raw === 'observe' || raw === 'replace' || raw === 'retry' || raw === 'rescue' || raw === 'rescue-dry') return raw;
    return config.intercept === true ? 'replace' : 'observe';
  })();

  ctx.logger?.info?.(`[dsml-guard] active on llm/stream (action=${leakActionMode})`);
  // 把实际生效的档位也落盘 —— 重启后靠这一行确认配置真的被读到。
  appendLine(logFile, {
    at: new Date().toISOString(),
    kind: 'active',
    action: leakActionMode,
    interceptCompat: config.intercept === true,
  });
  const meter = new LeakMeter(ctx.logger, logFile);

  /**
   * waterfall listener：拿到 options 与 next，返回 next() 的原样结果。
   * 所有观察都发生在旁路，返回值必须是同一个流的内容。
   */
  const listener = (options, next) => {
    const stream = next();
    if (!stream) return stream;

    const probe = { provider: options?.provider, model: options?.model };
    const asm = new TextAssembler();

    /**
     * v0.15：本次请求可见的工具名（rescue 的白名单）。
     * 拿不到就一个都不救 —— 宁可重跑，也不执行来路不明的东西。
     */
    const allowedNames = collectToolNames(options);
    /** v0.15：这条流里救回了几个调用（>0 时收尾不改写失败判据）。 */
    let rescuedCalls = 0;
    /** v0.15：最后一次 rescue 解析失败的原因（只用于日志）。 */
    let rescueReason = null;

    /**
     * v0.8：这一路流里已经流过的推理内容。
     *
     * 用来识别「正文其实是 reasoning 的副本」（中转的老毛病）。
     * 只在本条流内有效；不做任何上送，也不进日志正文。
     */
    let thought = '';

    /**
     * v0.4 拦截（intercept）。
     *
     * 默认关闭。开启后行为变了：
     *   · 见到第一段正文就先**扣住**，不往下游喂，直到这一块结束（`block-end`）
     *     —— 只有到那一刻才知道整块是不是残片；
     *   · 是**纯残片**（去掉 DSML 标签后一个字不剩）→ 丢掉原文，换成一句提示；
     *   · 不是 → 把扣住的原话原样补发。
     *
     * v0.5 收紧：以前「短前缀 + 残片」也一起换，结果误杀了短的正常讨论。
     * 现在只认空心残片。真实泄露基本全是这个形态。
     *
     * 代价：正文延迟到 block-end 才出现，流式打字效果消失。这是为了
     * 「不把残片写进历史、让下一轮能继续」必须付的价钱，所以默认关着。
     */
    /**
     * 命中残片后做什么，在 apply 作用域里已解析好。
     */
    const leakAction = leakActionMode;

    /** 是否需要在 block-end 之前扣住正文（'replace' 与 'retry' 都需要）。 */
    const holding =
    leakAction === 'replace' || leakAction === 'retry' || leakAction === 'rescue' || leakAction === 'rescue-dry';

    /** v0.20：rescue 两档走「流式扣留」而不是「一律全扣」。 */
    const rescueMode = leakAction === 'rescue' || leakAction === 'rescue-dry';

    /**
     * v0.20：流式扣留器（详见 `StreamHoldback` 的注释）。
     *
     * 只在 rescue 两档启用：`retry`/`replace` 的语义是「整块判完再决定要不要
     * 丢掉」，那里不能提前放行任何字节。rescue 不同 —— 它要的是**完整调用**，
     * 正文本身可以照常流出去。
     */
    const holdback = rescueMode
      ? new StreamHoldback({ tail: HOLDBACK_TAIL, maxHold: RESCUE_HOLD_MAX })
      : null;

    const interceptText =
      typeof config.interceptText === 'string' && config.interceptText.length > 0
        ? config.interceptText
        : '（本轮输出异常：模型只吐出了空的工具调用标签，没有正文。请继续。）';

    /** 扣住的原文（仅 holding 模式使用）。 */
    let held = '';

    /**
     * 已经发出失败分片，这条流剩下的内容全部丢弃。
     * 不丢的话，残片之后可能还有半截正文，会跟着失败分片一起进上下文。
     */
    let stopped = false;
    /** v0.20：收尾时扣留器只收口一次（`inspect` 会为放行尾巴重入一次 finish）。 */
    let finishFlushed = false;

    // ── v0.10：正文里混进内部草稿时，按族分流（思考搬 reasoning / 整理直接丢）──
    /** 'idle'（普通正文）| 'probe'（开头几个字还判断不出）| 'think' | 'draft' */
    let convertState = 'idle';
    /** probe / 草稿段之后攒下的开头几个字。 */
    let probeBuf = '';
    /** probe 阶段被暂扣的 `block-start`（判定为思考时要把它改写成 reasoning）。 */
    let pendingBlockStart = null;
    /** 最近一次判定的标签种类与名字（写日志用）。 */
    let tagKind = null;
    let tagName = '';
    /** think / draft 状态里，可能是「闭合标签开头」的尾巴（`</think` 被切成两段时用）。 */
    let thinkHold = '';
    let draftHold = '';
    /** 当前 text 块的 index（合成正文块要用它 + 偏移）。 */
    let blockIndex = 0;
    /** 搬走的思考原文（剥掉标签后），用来给 reasoning 块的最终 block.text。 */
    let thinkingText = '';
    /** 这条流里有多少字是从正文搬到 reasoning 的。 */
    let thinkingChars = 0;
    /** 这条流里丢掉了多少字的整理产物。 */
    let draftChars = 0;
    /** 这条流里真正的正文有多少字。 */
    let realTextChars = 0;
    /** 当前 text 块已经下发给前端的正文长度（v0.11：block-end 补齐用）。 */
    let blockEmitted = 0;
    /**
     * v0.20：当前块**真正发出去**的字数（`blockEmitted` 计的是「作者写了多少」，
     * 被 holdback 压住的尾巴并没有发出去）。rescue 成功时要靠它算「正文补哪些」，
     * 否则会把已经流出去的正文再发一遍。
     */
    let blockPublished = 0;
    /**
     * v0.21：这一块被判定成「上游把思考复制进正文」，整块作废、不吐一个字。
     * 一旦置位，`passText` 不再下发任何正文，块尾直接走既有重取通道。
     */
    let suppressedCopy = false;
    /**
     * v0.22：流式阶段先扣住的「可能是套话」的正文（块尾用 `isCannedRefusal` 定夺）。
     * `null` = 没在扣。
     */
    let refusalBuf = null;
    /** v0.22：整块确认是套话、已压住待收尾时定夺（`{text, index}`）。 */
    let pendingRefusal = null;
    /**
     * v0.20.1：跨多块的回溯携带。与 holdback 的 carry 分工不同 ——
     * holdback 传「半截标签」，这里传「已经开出来、但还没闭合的整段调用」。
     * 只有解析判失败且确实存在未闭合 invoke 时才设值，成功即清空。
     */
    let crossCarry = '';
    /** 本条流有没有发起工具调用。 */
    let hasToolCall = false;
    /** 搬走的思考有没有闭合过。 */
    let thinkingClosed = false;
    /** 当前 text 块是否已经来过正文（用来判断「开头」）。 */
    let blockHasText = false;
    /** 思考块的块头已经按 reasoning 发过 → 后面的真正文得另开一个块。 */
    let blockIsReasoning = false;
    /** 这个块被判成整理产物（整块丢掉）；块尾要据此吞掉块头/块尾。 */
    let blockDropped = false;
    /** 进入这个块时 realTextChars 的基线（判断「整块没留下任何真正文」）。 */
    let blockRealBase = 0;
    /** 合成正文块是否已开（闭合标签后的真正文放进 index + 1000）。 */
    let synthOpen = false;
    let synthText = '';

    /** 构造一个终态失败分片（形状见 dsh-llm `adapterFailureChunk`）。 */
    const failureChunk = () => ({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: RETRY_FAILURE_MESSAGE,
          code: RETRY_FAILURE_CODE,
        },
      },
    });

    /**
     * 对当前累积的整段正文做一次判定。
     *
     * @returns {'retry'|true|false|null}
     *   'retry' = 命中尾部残片，应发失败分片让 DSH 重跑这一步
     *   true    = 命中空心残片，已换成提示（'replace' 档）
     *   false   = 命中但不是空心残片（replace 档不该动它），应放行原文
     *   null    = 没命中，或 observe 档
     */
    const judge = () => {
      try {
        const text = asm.text();
        // v0.12：只剩标签壳子的噪声（全是闭合标签 / <parameter> 这类）——
        // 它既不是 DSML 残片，也不以开标签开头，前面所有判据都放过它。
        // 注意：这里**不看** hasToolCall。带工具调用时也照样重跑——
        // 重跑只重做失败步骤、已完成的工具结果不丢（dsh-llm-retry 的语义），
        // 而把一屏 `</thinking>` 写进历史是不可逆的。宁可多跑一次。
        if (isInternalTagSoup(text)) {
          asm.reset();
          appendLine(logFile, {
            at: new Date().toISOString(),
            kind: 'intercepted',
            provider: probe.provider ?? null,
            model: probe.model ?? null,
            action: leakAction,
            dropped: text.length,
            proseLength: 0,
            reasoningCopy: false,
            shape: 'tag_soup',
            format: classifyFormat(text),
          });
          noteRethink({ soup: true });
          return leakAction === 'retry' || leakAction === 'rescue' || leakAction === 'rescue-dry'
            ? 'retry'
            : true;
        }
        // v0.7：开标签结尾 / 正文 + 尾巴残片 都算泄露
        if (!isDsmlTailFragment(text)) return null;
        const prefix = text.replace(DSML_TAG, '').trim();
        const hollow = prefix.length <= INTERCEPT_PREFIX_MAX;
        /**
         * 两档的差别就在这里：
         *   retry   —— 正文会被重跑时重新生成，所以「有正文 + 尾巴残片」也照样重跑；
         *   replace —— 换掉等于把这段正文删了，只允许换空心残片。
         */
        // v0.15：rescue 解析失败时要按 retry 语义处理（整段丢弃、让 DSH 重跑），
        // 否则「正文 + 尾巴残片」会被当成不需要动的普通正文原样放行。
        const acting = holding && (leakAction === 'retry' || leakAction === 'rescue' ? true : hollow);
        // v0.8：正文是不是这段推理的副本 —— 决定「扣住」是否有正当理由
        const reasoningCopy = looksLikeReasoningCopy(text, thought);
        meter.record({
          ...probe,
          snippet: text.slice(0, 200),
          textLength: text.length,
          replaced: acting,
          reasoningCopy,
        });
        asm.reset();
        if (!acting) return false;
        appendLine(logFile, {
          at: new Date().toISOString(),
          kind: 'intercepted',
          provider: probe.provider ?? null,
          model: probe.model ?? null,
          action: leakAction,
          dropped: text.length,
          // 记一下「被丢弃的正文有多长」：0 = 空心残片，>0 = 正文 + 尾巴残片
          proseLength: prefix.length,
          // v0.8：true 说明这段正文本就是思考的副本（中转复制），
          // 前端看到的「垃圾」正是它 —— 排查频率问题先看这个字段。
          reasoningCopy,
          // v0.19：这次是哪种格式坏法（closed_only / prose_plus_tags / ...）
          format: classifyFormat(text),
        });
        return leakAction === 'retry' || leakAction === 'rescue' || leakAction === 'rescue-dry'
            ? 'retry'
            : true;
      } catch {
        return null;
      }
    };

    /**
     * 处理一个 chunk。
     *
     * 非拦截模式（默认）：**原样返回同一个 chunk**，一个字节都不改。
     * 拦截模式：正文先扣住；`block-end` 决定放行原文还是换成提示。
     *
     * @returns {object[]} 要下发的 chunk（可能 0 个、1 个或 2 个）
     */
    /** 记一条「正文里的内部草稿被处理掉」的日志（不记正文，只记字数与标签名）。 */
    /** v0.17：同一个块只记一次（handleBlockEnd 记完 finish 又记一遍，日志里成对出现）。 */
    let notedKey = '';
    const noteRethink = (extra = {}) => {
      const key = `${blockIndex}|${tagKind}|${tagName}|${thinkingChars}|${draftChars}|${realTextChars}`;
      if (key === notedKey) return;
      notedKey = key;
      try {
        appendLine(logFile, {
          at: new Date().toISOString(),
          kind: 'rethink',
          provider: probe.provider ?? null,
          model: probe.model ?? null,
          tag: tagKind,
          tagName,
          thinkingChars,
          draftChars,
          realTextChars,
          hasToolCall,
          closed: thinkingClosed,
          ...extra,
        });
      } catch {
        // 记不上也不影响主流程
      }
    };

    /**
     * 正文原样下发（v0.4 起的扣留 / v0.8 的副本识别都在这里）。
     *
     * @returns {object[]} 真正要交给下游的 chunk
     */
    const passText = (chunk, text) => {
      /**
       * v0.22：套话先扣住，别把「你好，我无法…」这半句发到屏幕上。
       *
       * 命中只在**开头**：`refusalBuf === null` 且这段文本还是某条套话的前缀时才入袋；
       * 一旦偏离（正文继续往下写），立刻把攒的这截原样接回正常通路 ——
       * 所以真实回答只会多等几毫秒，不会丢字。
       */
      if (holding) {
        if (refusalBuf !== null) {
          const merged = refusalBuf + text;
          if (isCannedRefusalPrefix(merged)) {
            refusalBuf = merged;
            return [];
          }
          refusalBuf = null;
          return passText(chunk, merged);
        }
        if (blockEmitted === 0 && isCannedRefusalPrefix(text)) {
          refusalBuf = text;
          return [];
        }
      }
      /**
       * v0.21：**先**判是不是纯副本，再决定要不要往下发 —— 且必须在 `asm.push(text)`
       * 之前算 `sofar`（`asm` 里已经有这段文本，push 之后再拼就重复了一遍，
       * 前缀比对必然失配，抑制永远不触发。这是第一版没转绿的原因）。
       */
      if (holding && holdback && !suppressedCopy) {
        const sofar = asm.text() + text;
        if (
          COPY_FORMATS.has(classifyFormat(sofar)) &&
          looksLikeReasoningCopy(sofar, thought) &&
          stripLeakedTags(sofar).trim().length > 0
        ) {
          suppressedCopy = true;
        }
      }
      if (text.length > 0) realTextChars += text.length;
      blockEmitted += text.length;
      asm.push(text);
      if (!holding) return [{ ...chunk, text }];
      /**
       * v0.20：rescue 档不再「一律全扣」。
       *
       * 旧行为把整块正文压到块尾才吐，普通回答完全没有流式手感；而且开标签
       * 只要落在上一块，这一块的闭合标签就永远配不上（`unpaired_param`）。
       * 现在只有「真的像调用开头」的那一段被扣住，其余逐块透传。
       */
      if (holdback) {
        // v0.21：已经判定成纯副本 → 这一块一个字都不发（判定见函数开头）。
        if (suppressedCopy) return [];
        const parts = holdback.feed(text);
        if (parts.length === 0) return [];
        const outs = [];
        for (const part of parts) {
          blockPublished += part.length;
          outs.push({ ...chunk, text: part });
        }
        return outs;
      }
      held += text;
      /**
       * v0.15：rescue 模式要拿到**整段**工具调用才能解析，所以只要手里这段带
       * DSML 标记，就把扣留上限抬到 RESCUE_HOLD_MAX；不带标记仍按 1200 放行，
       * 免得把正常长回复压在内存里。
       */
      const holdMax =
        (leakAction === 'rescue' || leakAction === 'rescue-dry') && DSML_MARK_RE.test(held)
          ? RESCUE_HOLD_MAX
          : INTERCEPT_HOLD_MAX;
      if (held.length > holdMax) {
        /**
         * v0.8：先看这段正文是不是「思考的副本」。
         *   是副本 → 放行只会把垃圾亮给前端（今天 15 次可见全来自这里），继续扣住；
         *   不是   → 这么长不可能是残片，按 v0.7 的老规矩立刻放行、之后不再扣这一块。
         */
        if (held.length <= REASONING_HOLD_MAX && looksLikeReasoningCopy(held, thought)) {
          return [];
        }
        // v0.12：标签噪声往往比扣留上限还长（一屏 `</thinking>` 就上千字），
        // 放行它就等于把噪声写进历史 —— 继续扣住，等块尾一次性判死。
        if (isInternalTagSoup(held)) {
          return [];
        }
        // v0.17：连发的游离闭合标签同理（`</thinking>` x 114 那种）。
        if (countStrayInternalClosers(held) >= STRAY_CLOSER_MIN) {
          return [];
        }
        const out = held;
        held = '';
        asm.reset();
        return [{ ...chunk, text: out }];
      }
      return []; // 先扣住
    };

    /**
     * 把一个**整块正文**按内部标签切分（v0.11）。
     *
     * 为什么需要它：上游有时不按 delta 推正文，而是把整段文字塞进
     * `block-end` 的 `block.text`（实测 22,039 字 / 19,749 字都是这么来的），
     * 而 `BlockAssembler` 以 `block.text` 为准 —— 只处理 delta 等于没处理。
     *
     * @returns {{think: string, real: string}} 思考内容（搬去 reasoning）与真正文
     */
    const splitBlockText = (text) => {
      const src = String(text ?? '');
      const thinks = [];
      const reals = [];
      let pos = 0;
      let atStart = true;
      const TAG_AT = /<\s*([A-Za-z][A-Za-z0-9_-]*)/y;

      while (pos < src.length) {
        // 找下一个「看起来是内部标签」的位置
        let idx = src.indexOf('<', pos);
        let name = null;
        let kind = null;
        while (idx >= 0) {
          TAG_AT.lastIndex = idx;
          const m = TAG_AT.exec(src);
          if (m) {
            /**
             * v0.16：名字后面必须紧跟 `>`、空白或 `/` 才算标签。
             * `<https://example.com>` 这种自动链接会被 `TAG_AT` 匹配成 name=`https`，
             * 不加这道闸就会被当成内部标签搬走。
             */
            const nextChar = src.slice(TAG_AT.lastIndex, TAG_AT.lastIndex + 1);
            const delimited =
              nextChar === '' || nextChar === '>' || nextChar === '/' || /\s/.test(nextChar);
            const k = delimited ? tagKindOf(m[1]) : null;
            if (k) {
              name = m[1];
              kind = k;
              break;
            }
          }
          idx = src.indexOf('<', idx + 1);
        }

        if (idx < 0 || kind === null) {
          reals.push(src.slice(pos));
          break;
        }

        const head = src.slice(pos, idx);
        const leadIsSpace = head.trim().length === 0;

        // 解析这个标签区域
        const gt = src.indexOf('>', idx);
        const bodyStart = gt >= 0 && gt - idx <= 40 ? gt + 1 : idx + 1 + name.length;
        const closeRe = new RegExp(`<\\/\\s*${name}[A-Za-z0-9_-]*\\s*>`, 'i');
        const tail = src.slice(bodyStart);
        const cm = closeRe.exec(tail);
        const inner = cm ? tail.slice(0, cm.index) : tail;
        const regionEnd = cm ? bodyStart + cm.index + cm[0].length : src.length;

        /**
         * 块开头就是标签 → 一律按标签处理（这是上游把思考/草稿塞进正文的形态）。
         * 正文**中间**出现的标签 → 只有区域足够长（≥200 字）才当垃圾剥掉，
         * 免得把「The <thinking> tag is what upstream leaks」这种正常讨论也吃掉。
         */
        const atBlockStart = atStart && leadIsSpace;
        /**
         * 判据：
         *  - 块开头（前面只有空白）就是标签 → 一定是塞进来的思考/草稿，照剥；
         *  - 正文中间的标签 → 必须**有闭合标签**且区域够长（≥40 字）才算垃圾，
         *    这样「The <thinking> tag is what upstream leaks」这类正常讨论不会被吃掉。
         */
        const junk = atBlockStart || (cm !== null && inner.length >= 40);

        if (junk) {
          reals.push(head);
          if (kind === 'think') thinks.push(inner);
          atStart = atStart && leadIsSpace;
        } else {
          // 不算垃圾：整段原样留作正文
          reals.push(src.slice(pos, regionEnd));
          atStart = false;
        }
        pos = regionEnd;
      }
      return { think: thinks.join(''), real: reals.join('') };
    };

    /** 正文块结束时的判定与放行（v0.4/v0.7 的老逻辑 + v0.11 的整块清洗）。 */
    const passBlockEnd = (chunk) => {
      const outs = [];

      /**
       * ── v0.15 rescue：整块文本先试「救回工具调用」──
       *
       * 位置选在这里的原因：`block-end.block.text` 是这一块的**完整**文本
       * （assembler 以它为准），只有到这一刻 `invoke`/`parameter` 才可能完整，
       * 逐 delta 解析必然拿到半截 JSON。
       *
       * 成功 → 交出「洗净的正文块 + N 个 tool-call 块」，原块尾吞掉；
       * 失败 → 什么都不改，落到下面既有分支（judge → retry）。
       */
      /**
       * v0.20：块边界先把扣留器收口 —— 顺序不能反。
       *
       * `takeCarry()` 拿的是**上一块**带过来的尾巴（它不在 `block.text` 里），
       * `endBlock()` 收的是**这一块**没发出去的尾巴（它本来就在 `block.text` 里）。
       * 先 endBlock 再 takeCarry 会把这一块的尾巴当成上一块的，解析输入被拼成
       * 两份同样的标记 —— 实测直接炸成 `param_outside_invoke`。
       */
      const inbound = holdback ? holdback.takeCarry() : '';
      const endInfo = holdback ? holdback.endBlock() : { carried: '', held: '' };
      const carry = inbound;

      /**
       * v0.20：observe 档的「影子救援」。
       *
       * 只解析、只记账（`dry: true`），既不改流也不产出 tool-call ——
       * 目的是在 `leakAction` 没配成 rescue 时，也能量出「这一块本来能救回多少」。
       * 排查覆盖率不必为了看数字去动生产行为；生产配了 rescue 就走下面的真路径。
       */
      if (!rescueMode && typeof chunk.block?.text === 'string' && chunk.block.text.length > 0) {
        const shadow = chunk.block.text;
        if (hasDsmlTag(shadow) || scanBareTags(shadow, CALL_TAG_NAMES).length > 0) {
          const shadowParsed = parseLeakedCalls(shadow, allowedNames);
          if (shadowParsed.ok) {
            appendLine(logFile, {
              at: new Date().toISOString(),
              kind: 'rescued',
              dry: true,
              mode: leakAction,
              provider: probe.provider ?? null,
              model: probe.model ?? null,
              calls: shadowParsed.calls.length,
              names: shadowParsed.calls.map((c) => c.name),
              proseLength: shadowParsed.prose.length,
              format: shadowParsed.format,
              lint: (shadowParsed.lint ?? []).map((h) => h.code),
            });
          }
        }
      }

      if (
        rescueMode &&
        typeof chunk.block?.text === 'string' &&
        /**
         * v0.20：门闸也要认退化形态 —— `<` 与 DSML 字面都丢了的标签
         * 不含 DSML 字样，`hasDsmlTag` 恒假，不补这一条这类调用永远进不来。
         */
        (hasDsmlTag(chunk.block.text) ||
          hasDsmlTag(carry) ||
          scanBareTags(chunk.block.text, CALL_TAG_NAMES).length > 0 ||
          scanBareTags(carry, CALL_TAG_NAMES).length > 0 ||
          /**
           * v0.20.1：中间那一块可能一个标签都没有（参数正文被切断），
           * 光看本块会被门闸挡回去，跨块段就再也没机会续上。
           */
          crossCarry.length > 0)
      ) {
        const full = chunk.block.text;
        // 上游有时会把上一块的内容重复写进这一块的 block.text，那样不能再拼一遍
        let parseInput = carry.length > 0 && !full.startsWith(carry) ? carry + full : full;
        // v0.20.1：把上一块没闭合的调用接在前面（顺序：跨块段 → 半截标签 → 本块）
        if (crossCarry.length > 0) {
          if (parseInput.startsWith(crossCarry)) {
            crossCarry = '';
          } else {
            parseInput = crossCarry + parseInput;
            crossCarry = '';
          }
        }
        const parsed = parseLeakedCalls(parseInput, allowedNames);
        /**
         * v0.21：纯 reasoning 副本 —— 不吐半截正文，整轮作废重取。
         *
         * 生产证据（2026-11-23，近 4 小时 10 条 `rescue-failed`）：全部是副本，
         * 与同刻 `leak` snippet 相似度 0.89–1.00、Δt=0.0s；全量 224 条 `intercepted`
         * 里 172 条 `reasoningCopy:true`（79%），累计丢 273,944 字，全在
         * `khala/deepseek-v4.1-flash-1017`。用户看到的「tool call 报错」其实是
         * 「上游污染 → 我们截断 → 只剩残渣」，跟他自己的调用写法无关。
         *
         * 判据复用 `looksLikeReasoningCopy()`（不新造启发式），再叠一道形态闸：
         * 只有「散文里散落标签」（`prose_plus_tags` / `param_without_invoke`）才算，
         * 真调用被切断（`unclosed_invoke`/`tags_only`）照旧走重跑那条老路。
         */
        if (
          !parsed.ok &&
          COPY_FORMATS.has(classifyFormat(parseInput)) &&
          looksLikeReasoningCopy(parseInput, thought)
        ) {
          appendLine(logFile, {
            at: new Date().toISOString(),
            kind: 'reasoningCopy-suppressed',
            provider: probe.provider ?? null,
            model: probe.model ?? null,
            /** 这次被整段丢掉的字节数（下游一个字都没拿到） */
            dropped: full.length,
            /** 其中真正的散文部分有多长（去掉标签后） */
            proseLength: stripLeakedTags(parseInput).trim().length,
            format: classifyFormat(parseInput),
            diagTag: parsed.diag?.tag ?? null,
            diagAt: parsed.diag?.at ?? null,
            /** 证据位：判定确实来自副本比对，不是别的启发式 */
            looksLikeReasoningCopy: true,
            thoughtLength: thought.length,
            action: 'retry',
            reason: parsed.reason,
            ...(holdback ? { hold: holdback.stats() } : {}),
          });
          held = '';
          crossCarry = '';
          blockPublished = 0;
          blockDropped = true;
          suppressedCopy = true;
          asm.reset();
          return [];
        }
        /**
         * v0.20.1：解析没成，但文本里确实开着一条 invoke ——
         * 说明它被切到了下一块（甚至下下块），把这一段留到下一块再拼。
         * 成功或压根没有未闭合 invoke 时清空，绝不无限累积。
         */
        if (!parsed.ok) {
          const openAt = unclosedInvokeStart(parseInput);
          if (openAt >= 0) {
            const nextCross = parseInput.slice(openAt).slice(0, HOLDBACK_CARRY_MAX);
            crossCarry = nextCross;
            appendLine(logFile, {
              at: new Date().toISOString(),
              kind: 'holdback',
              mode: 'chain',
              reason: parsed.reason,
              carry: nextCross.length,
              provider: probe.provider ?? null,
              model: probe.model ?? null,
            });
          }
        }
        /**
         * v0.16：rescue-dry = 只观察。解析成功也只记一条 rescue-would 日志，
         * 不交出 tool-call，落到下面既有分支（judge → retry）。
         * 用来在真实流量里量「解析成功率」，而不改变任何行为。
         */
        if (parsed.ok && leakAction === 'rescue-dry') {
          appendLine(logFile, {
            at: new Date().toISOString(),
            kind: 'rescue-would',
            provider: probe.provider ?? null,
            model: probe.model ?? null,
            calls: parsed.calls.length,
            names: parsed.calls.map((c) => c.name),
            proseLength: parsed.prose.length,
            dropped: full.length,
            sample: parsed.prose.slice(0, 160),
          });
          // 解析成功但 dry 档不交出调用：与 rescue 走同一条「让上层重跑」的路。
          // judge() 对「正文 + 调用标签」这种形态本来就不判泄漏（它只认纯残片与
          // 标签汤），所以不能落回下面的普通分支 —— 那会把标签原样写进历史。
          held = '';
          stopped = true;
          return [failureChunk()];
        }
        if (parsed.ok && leakAction === 'rescue') {
          const res = [];
          /**
           * 正文 index 复用原块：扣留期间正文一个 delta 都没发过时，原 block-start
           * 还在手上（或已按原 index 发过）。另开合成块会在历史里留下一个空文本块。
           *
           * v0.20：`reuse` 的判据从 `blockEmitted` 换成 `blockPublished` —— 流式扣留
           * 会先把安全的正文发出去（`blockEmitted > 0` 但 `blockPublished` 可能为 0
           * 也可能 >0）。真正决定「要不要另开块」的是**有没有发过**。
           */
          const reuse = blockPublished === 0;
          const proseIndex = reuse ? blockIndex : blockIndex + SYNTH_INDEX_OFFSET;
          if (reuse && pendingBlockStart) res.push(pendingBlockStart);
          pendingBlockStart = null;
          /**
           * v0.20：只补发**还没发过**的那段正文。
           *
           * 已发出去的前缀一定是干净正文（出现标记之前就发出去了），所以按字数裁掉
           * 前缀是安全的；不裁就会把同一段正文发两遍（前端看到重复段落）。
           */
          const skip = reuse ? 0 : Math.min(blockPublished, parsed.prose.length);
          const prose = parsed.prose.slice(skip).trim();
          if (prose.length > 0) {
            if (!reuse) res.push({ type: 'block-start', index: proseIndex, blockType: 'text' });
            res.push({ type: 'text-delta', index: proseIndex, text: prose });
            res.push({ type: 'block-end', index: proseIndex, block: { type: 'text', text: prose } });
            realTextChars += prose.length;
          }
          parsed.calls.forEach((call, i) => {
            const idx = blockIndex + RESCUE_INDEX_OFFSET + i;
            const id = `${RESCUE_ID_PREFIX}${i}`;
            res.push({ type: 'block-start', index: idx, blockType: 'tool-call' });
            res.push({ type: 'tool-call-delta', index: idx, id, name: call.name, argumentsDelta: call.arguments });
            res.push({
              type: 'block-end',
              index: idx,
              block: { type: 'tool-call', id, name: call.name, arguments: call.arguments },
            });
          });
          rescuedCalls += parsed.calls.length;
          hasToolCall = true;
          held = '';
          asm.reset();
          appendLine(logFile, {
            at: new Date().toISOString(),
            kind: 'rescued',
            provider: probe.provider ?? null,
            model: probe.model ?? null,
            calls: parsed.calls.length,
            names: parsed.calls.map((c) => c.name),
            proseLength: parsed.prose.length,
            proseSkipped: skip,
            dropped: full.length,
            sample: parsed.prose.slice(0, 160),
            format: parsed.format ?? null,
            lint: (parsed.lint ?? []).map((h) => h.code),
            // v0.20：这次是靠跨块携带拼回来的吗（旧代码在这条上必然是 unpaired_param）
            carried: carry.length,
            ...(holdback ? { hold: holdback.stats() } : {}),
            finishPending: true,
          });
          return res;
        }
        rescueReason = parsed.reason;
        appendLine(logFile, {
          at: new Date().toISOString(),
          kind: 'rescue-failed',
          provider: probe.provider ?? null,
          model: probe.model ?? null,
          reason: parsed.reason,
          textLength: full.length,
          allowlist: allowedNames.length,
          sample: full.slice(0, 160),
          // v0.19：这条到底坏在哪种格式上、卡在哪个标签/偏移。
          format: parsed.format ?? null,
          diag: parsed.diag ?? null,
          carried: carry.length,
        });

        /**
         * v0.20：`unpaired_param` / `closed_only` 的兜底 —— 把正文救回来。
         *
         * 日志里 35 条 `unpaired_param` 的 sample 全是英文思考散文：relay 把
         * reasoning 复制进 content，而那段思考里提到过 `</parameter>`。它们
         * **不是调用**，所以「救回调用」这条路对它们天然无效；旧代码却按
         * rescue 失败处理 → 整步重跑，用户白等一次。
         *
         * 判据故意收得很紧：整段（含跨块携带）**没有任何 DSML 标记**才算噪声。
         * 带标记就说明模型真的想调工具，那种情况必须交给下面的重跑分支。
         */
        const NOISE_REASONS = new Set([
          'unpaired_param',
          'unpaired',
          'closed_only',
          'param_outside_invoke',
          'no_invoke',
          'invoke_no_name',
        ]);
        if (!hasDsmlTag(parseInput) && NOISE_REASONS.has(parsed.reason)) {
          const cleaned = stripLeakedTags(full);
          const skip = Math.min(blockPublished, cleaned.length);
          const prose = cleaned.slice(skip).trim();
          const reused = pendingBlockStart !== null && blockPublished === 0;
          if (pendingBlockStart) {
            outs.push(pendingBlockStart);
            pendingBlockStart = null;
          }
          const targetIndex = reused ? blockIndex : blockIndex + SYNTH_INDEX_OFFSET;
          if (prose.length > 0) {
            if (!reused) outs.push({ type: 'block-start', index: targetIndex, blockType: 'text' });
            outs.push({ type: 'text-delta', index: targetIndex, text: prose });
            outs.push({ type: 'block-end', index: targetIndex, block: { type: 'text', text: prose } });
            realTextChars += prose.length;
          } else {
            outs.push({ ...chunk, block: { ...chunk.block, text: '' } });
          }
          appendLine(logFile, {
            at: new Date().toISOString(),
            kind: 'rescued-noise',
            provider: probe.provider ?? null,
            model: probe.model ?? null,
            reason: parsed.reason,
            format: parsed.format ?? null,
            textLength: full.length,
            proseLength: prose.length,
            stripped: full.length - cleaned.length,
            ...(holdback ? { hold: holdback.stats() } : {}),
          });
          held = '';
          asm.reset();
          return outs;
        }
      }

      /**
       * v0.11：以 `block.text` 为准重新分类。
       *
       * 上游有时把整段文字塞在 block-end 里（delta 只给两三个字符），
       * 而 `BlockAssembler` 以 block.text 为准 —— 只在 delta 上过滤等于没过滤。
       * 实测 2026-11-15 22:30 / 22:56 两条 22,039 / 19,749 字的 `<analysis>` 就是这么漏出去的。
       */
      if (holding && typeof chunk.block?.text === 'string') {
        const raw = chunk.block.text;
        /**
         * v0.17：先把游离闭合标签处理掉再切分。
         * 见 `countStrayInternalClosers` 的注释：`</thinking>` 连发 100 多次那种块，
         * 标签必须剥掉；剥完剩下的文字也按思考算（回答不会闭合一个没打开过的标签）。
         */
        const stray = countStrayInternalClosers(raw);
        const strayHeavy = stray >= STRAY_CLOSER_MIN;
        const full = stray > 0 ? dropStrayInternalClosers(raw) : raw;
        let split = splitBlockText(full);
        if (strayHeavy && split.real.trim().length > 0) {
          split = { think: split.think + split.real, real: '' };
        }

        // 整块都是整理产物：块头还没发就一起吞掉，什么都不留
        if (split.think.length === 0 && split.real.trim().length === 0) {
          // v0.15.1/v0.17.1：这一段已经整个搬进 reasoning，扣留缓冲里的同一份要丢掉，
          // 否则 finalize() 会把它当正文补发（实测 3,147 字整段漏出）。
          held = '';
          if (pendingBlockStart) {
            pendingBlockStart = null;
            noteRethink({ where: 'block-end' });
            return outs;
          }
          draftChars += full.length;
          noteRethink({ where: 'block-end' });
          return [{ ...chunk, block: { ...chunk.block, text: '' } }];
        }

        // 思考类：搬进 reasoning 通道
        if (split.think.length > 0) {
          thinkingChars += split.think.length;
          thinkingText += split.think;
          // v0.15.1/v0.17.1：这一段已经整个搬进 reasoning，扣留缓冲里的同一份要丢掉，
          // 否则 finalize() 会把它当正文补发（实测 3,147 字整段漏出）。
          held = '';
          noteRethink({ where: 'block-end' });
          if (pendingBlockStart) {
            outs.push({ ...pendingBlockStart, blockType: 'reasoning' });
            pendingBlockStart = null;
            outs.push({ type: 'reasoning-delta', index: blockIndex, text: split.think });
            outs.push({ ...chunk, index: blockIndex, block: { ...chunk.block, type: 'reasoning', text: split.think } });
            if (split.real.trim().length > 0) {
              const synthIndex = blockIndex + SYNTH_INDEX_OFFSET;
              outs.push({ type: 'block-start', index: synthIndex, blockType: 'text' });
              outs.push({ type: 'text-delta', index: synthIndex, text: split.real });
              outs.push({ type: 'block-end', index: synthIndex, block: { type: 'text', text: split.real } });
              realTextChars += split.real.length;
            }
            return outs;
          }
          // 块头已经按 text 发过了（改不了类型）：至少把思考内容从正文里洗掉
          return [{ ...chunk, block: { ...chunk.block, text: split.real } }];
        }

        // 普通正文：delta 没给全就用 block.text 补齐，并以它为准
        if (pendingBlockStart) {
          outs.push(pendingBlockStart);
          pendingBlockStart = null;
        }
        if (split.real.length > blockEmitted) {
          // 注意：不能把 block-end 本身交给 passText —— 它超长放行时会返回
          // `{...chunk, text}`，等于把原 block.text（带标签的全文）又发出去一次。
          outs.push(...passText({ type: 'text-delta', index: blockIndex }, split.real.slice(blockEmitted)));
        }
        chunk = { ...chunk, block: { ...chunk.block, text: split.real } };
      }

      if (pendingBlockStart) {
        outs.push(pendingBlockStart);
        pendingBlockStart = null;
      }
      if (typeof chunk.block?.text === 'string') {
        if (chunk.block.text.length > 0) realTextChars = Math.max(realTextChars, chunk.block.text.length);
        asm.absorbBlock(chunk.block.text);
      }
      asm.finish();
      const verdict = judge();
      asm.reset();
      if (!holding) return [...outs, chunk];
      if (verdict === 'retry') {
        held = '';
        stopped = true;
        return [failureChunk()];
      }
      if (verdict === true) {
        held = '';
        return [...outs, { type: 'text-delta', index: 0, text: interceptText }, { ...chunk, block: { ...chunk.block, text: interceptText } }];
      }
      // 放行：把扣住的原话补发，再给原 block-end
      const out = held;
      held = '';
      return out.length > 0 ? [...outs, { type: 'text-delta', index: 0, text: out }, chunk] : [...outs, chunk];
    };

    /** 把真正文交给下游（若当前块已按 reasoning 发过块头，就另开一个合成块）。 */
    const emitRealText = (chunk, text, outs) => {
      if (text.length === 0) return;
      if (blockIsReasoning) {
        if (text.trim().length === 0) return; // 只有空白，不值得单开一个块
        if (!synthOpen) {
          synthOpen = true;
          synthText = '';
          outs.push({ type: 'block-start', index: blockIndex + SYNTH_INDEX_OFFSET, blockType: 'text' });
        }
        synthText += text;
        realTextChars += text.length;
        outs.push(...passText({ ...chunk, index: blockIndex + SYNTH_INDEX_OFFSET }, text));
        return;
      }
      outs.push(...passText(chunk, text));
    };

    /** think 族的闭合标签（`</thinking>` / `</think>` / `</reflection>` …）。 */
    const THINK_CLOSE_RE = /<\/\s*(?:think|thought|reasoning|reflection)[A-Za-z0-9_-]*\s*>/i;

    /** draft 族的闭合标签按实际标签名生成。 */
    const draftCloseRe = (name) => new RegExp(`<\\/\\s*${String(name).replace(/[^a-z0-9_-]/gi, '')}[A-Za-z0-9_-]*\\s*>`, 'i');

    /**
     * 尾巴里可能是闭合标签开头的部分先扣住。
     * `</thinking>` 完全可能被拆成 `…</think` + `ing>…` 两块，不扣住就会漏判。
     */
    const holdPartialClose = (buf) => {
      const at = buf.lastIndexOf('</');
      if (at < 0 || buf.length - at > 20) return { out: buf, hold: '' };
      return { out: buf.slice(0, at), hold: buf.slice(at) };
    };

    /** 处理一段 text-delta（v0.10 的分流状态机）。 */
    const handleTextDelta = (chunk) => {
      // observe 档一个字节都不改：v0.10 的「搬通道 / 丢整理产物」都属于改流。
      if (!holding) {
        asm.push(chunk.text);
        blockHasText = true;
        return [chunk];
      }

      const outs = [];
      let text = chunk.text;

      // 上游没给 block-start 的少见情况：第一段正文也要判定一次。
      if (convertState === 'idle' && !blockHasText && realTextChars === 0 && pendingBlockStart === null) {
        convertState = 'probe';
        probeBuf = '';
        blockIndex = typeof chunk.index === 'number' ? chunk.index : 0;
      }

      let guard = 0;
      while (text.length > 0 && guard++ < 64) {
        if (convertState === 'probe') {
          probeBuf += text;
          text = '';
          const verdict = probeInternalTag(probeBuf);
          if (verdict === 'wait') {
            blockHasText = true;
            return outs;
          }
          if (verdict === 'none') {
            const buffered = probeBuf;
            probeBuf = '';
            /**
             * 纯空白（典型是正文开头的那个换行）：立刻原样放行，但**留在 probe 状态**。
             * 这些流里 `<thinking>` 经常跟在换行后面单独成块，若在这里就把状态置回 idle，
             * 后面的 `<thinking>` 就再也看不见了。空白本身无需等，放行也不会丢字。
             */
            if (buffered.trim().length === 0) {
              // v0.11：空白先攒着不放 —— 块头还扣着，block-end 时按 block.text 统一定夺，
              // 否则「整块都是 <analysis>」时块头已经按 text 发出去，就收不回来了。
              if (buffered.length <= 8) {
                probeBuf = buffered;
                return outs;
              }
            }
            if (pendingBlockStart) {
              outs.push(pendingBlockStart);
              pendingBlockStart = null;
            }
            convertState = 'idle';
            blockHasText = true;
            emitRealText(chunk, buffered, outs);
            return outs;
          }
          // 命中内部草稿标签
          tagKind = verdict.kind;
          tagName = verdict.name;
          blockHasText = true;
          const trimmed = probeBuf.replace(/^\s+/, '');
          probeBuf = '';
          const gt = trimmed.indexOf('>');
          /**
           * 标签可能**漏了闭合尖括号**（`<thinkingNo translation files anywhere`），
           * 这种时候「内容」从标签名后面就开始，不能整段扔掉。
           */
          const rest = gt >= 0 ? trimmed.slice(gt + 1) : trimmed.slice(1 + verdict.name.length);
          if (tagKind === 'think') {
            if (pendingBlockStart) {
              outs.push({ ...pendingBlockStart, blockType: 'reasoning' });
              pendingBlockStart = null;
            }
            blockIsReasoning = true;
            convertState = 'think';
            thinkHold = '';
            text = rest;
            continue;
          }
          convertState = 'draft';
          blockDropped = true;
          draftHold = '';
          text = rest;
          continue;
        }

        if (convertState === 'think') {
          const buf = thinkHold + text;
          text = '';
          thinkHold = '';
          const m = THINK_CLOSE_RE.exec(buf);
          if (m === null) {
            const { out, hold } = holdPartialClose(buf);
            thinkHold = hold;
            if (out.length > 0) {
              thinkingChars += out.length;
              thinkingText += out;
              outs.push({ type: 'reasoning-delta', index: blockIndex, text: out });
            }
            return outs;
          }
          thinkingClosed = true;
          const before = buf.slice(0, m.index);
          if (before.length > 0) {
            thinkingChars += before.length;
            thinkingText += before;
            outs.push({ type: 'reasoning-delta', index: blockIndex, text: before });
          }
          const after = buf.slice(m.index + m[0].length);
          convertState = 'probe';
          probeBuf = '';
          noteRethink();
          text = after;
          continue;
        }

        if (convertState === 'draft') {
          const buf = draftHold + text;
          text = '';
          draftHold = '';
          const m = draftCloseRe(tagName).exec(buf);
          if (m === null) {
            const { hold } = holdPartialClose(buf);
            draftHold = hold;
            draftChars += buf.length - hold.length;
            return outs;
          }
          draftChars += m.index + m[0].length;
          const after = buf.slice(m.index + m[0].length);
          convertState = 'probe';
          probeBuf = '';
          text = after;
          continue;
        }

        // 普通正文
        const rest = text;
        text = '';
        emitRealText(chunk, rest, outs);
        return outs;
      }
      return outs;
    };

    /** 处理正文块的块尾（v0.10 的分流收尾）。 */
    const handleBlockEnd = (chunk) => {
      const outs = [];

      /**
       * v0.22：整块确认是套话 → 先压住，等 `finish` 看这一轮到底有没有干活
       * （有没有工具调用）。有活干 = 这句话是被上游换进来的，绝不能展示；
       * 没活干 = 模型真的在拒绝，原样放出去（我们不替它改口）。
       */
      if (holding && !blockIsReasoning) {
        const cand = refusalBuf !== null ? refusalBuf : (typeof chunk.block?.text === 'string' ? chunk.block.text : '');
        if (cand.length > 0 && isCannedRefusal(cand) && blockEmitted === 0) {
          pendingRefusal = { text: cand, index: blockIndex };
          refusalBuf = null;
          pendingBlockStart = null;
          probeBuf = '';
          draftHold = '';
          convertState = 'idle';
          return outs;
        }
        refusalBuf = null;
      }

      /**
       * 整块都是整理产物、一个字正文都没留下：块头没发过，块尾也不发。
       * 这一段彻底不进上下文（用户 2026-11-15 拍板）。
       */
      if (blockDropped && realTextChars === blockRealBase && !blockIsReasoning && !synthOpen) {
        pendingBlockStart = null;
        probeBuf = '';
        draftHold = '';
        convertState = 'idle';
        noteRethink();
        return outs;
      }

      if (convertState === 'probe') {
        const buffered = probeBuf;
        probeBuf = '';
        // 只有空白：什么都不用发，block.text 里会有全文（v0.11）
        if (buffered.trim().length > 0) {
          if (pendingBlockStart) {
            outs.push(pendingBlockStart);
            pendingBlockStart = null;
          }
          emitRealText(chunk, buffered, outs);
        }
        convertState = 'idle';
      }

      if (blockIsReasoning) {
        if (convertState === 'think' && thinkHold.length > 0) {
          thinkingChars += thinkHold.length;
          thinkingText += thinkHold;
          outs.push({ type: 'reasoning-delta', index: blockIndex, text: thinkHold });
          thinkHold = '';
        }
        if (convertState === 'think') noteRethink();
        convertState = 'idle';
        if (synthOpen) {
          // 闭合标签后还跟过真正文：它单独构成一个块，得在这里给它判定并闭合
          asm.absorbBlock(synthText);
          asm.finish();
          const verdict = judge();
          asm.reset();
          if (verdict === 'retry') {
            held = '';
            stopped = true;
            return [failureChunk()];
          }
          const rest = held;
          held = '';
          if (rest.length > 0) outs.push({ type: 'text-delta', index: blockIndex + SYNTH_INDEX_OFFSET, text: rest });
          outs.push({
            type: 'block-end',
            index: blockIndex + SYNTH_INDEX_OFFSET,
            block: { type: 'text', text: synthText },
          });
          synthOpen = false;
        }
        outs.push({ ...chunk, index: blockIndex, block: { ...chunk.block, type: 'reasoning', text: thinkingText } });
        return outs;
      }

      if (convertState === 'draft') {
        draftChars += draftHold.length;
        draftHold = '';
        convertState = 'idle';
        // 整块都是整理产物：块头没发过（清掉），块尾也不发 —— 这一段彻底不进上下文
        pendingBlockStart = null;
        noteRethink();
        return outs;
      }

      // 块头不在这里吐：passBlockEnd 要按 block.text 决定它是正文、思考还是整块丢弃
      return [...outs, ...passBlockEnd(chunk)];
    };

    const inspect = (chunk) => {
      try {
        if (!chunk || typeof chunk !== 'object') return [chunk];

        // 正文块的块头先扣住：要等第一段正文才知道它是正文还是内部草稿。
        if (chunk.type === 'block-start' && chunk.blockType === 'text' && holding) {
          blockHasText = false;
          blockIsReasoning = false;
          synthOpen = false;
          synthText = '';
          convertState = 'probe';
          probeBuf = '';
          tagKind = null;
          tagName = '';
          thinkingText = '';
          blockDropped = false;
          blockRealBase = realTextChars;
          blockEmitted = 0;
          blockPublished = 0;
          suppressedCopy = false;
          blockIndex = typeof chunk.index === 'number' ? chunk.index : 0;
          pendingBlockStart = chunk;
          return [];
        }

        if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') hasToolCall = true;
        if (typeof chunk.type === 'string' && chunk.type.startsWith('tool-call')) hasToolCall = true;
        /**
         * v0.22：上游可能只给 `block-end` 而不给 `block-start`（实测会话 f7bf07df 就是这样）。
         * 只在 block-start 上记，会让「这一轮到底有没有干活」误判成「没有」——
         * 套话就会被当成真拒绝原样放给用户。
         */
        if (chunk.type === 'block-end' && chunk.block && chunk.block.type === 'tool-call') hasToolCall = true;

        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          return handleTextDelta(chunk);
        }

        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
          // 只做记录：推理里出现 DSML 标签是正常的，不参与判定。
          // 但要留够长度，否则正文副本没法比对（正文可能比思考先到）。
          if (thought.length < REASONING_HOLD_MAX * 2) thought += chunk.text;
          return [chunk];
        }

        if (chunk.type === 'block-end' && chunk.block?.type === 'text') {
          return handleBlockEnd(chunk);
        }

        if (chunk.type === 'finish') {
          /**
           * v0.20：流结束时把扣留器里剩下的尾巴放出去。
           *
           * 不放就会丢掉最后 ≤`HOLDBACK_TAIL` 个字 —— 那种「静默吞字」比什么
           * bug 都难查（用户只会说「最后一句没了」）。这里不做任何判定，
           * 原样吐出去；要不要判死由下面既有的分支决定。
           */
          if (holdback && !finishFlushed) {
            finishFlushed = true;
            const tail = holdback.flush(true);
            const stats = holdback.stats();
            const flat = tail.join('');
            if (flat.length > 0 || stats.held > 0 || stats.gaveUp > 0) {
              appendLine(logFile, {
                at: new Date().toISOString(),
                kind: 'holdback',
                where: 'finish',
                flushed: flat.length,
                ...stats,
              });
            }
            if (flat.length > 0) {
              const flushed = tail.map((part) => ({ type: 'text-delta', index: blockIndex, text: part }));
              return [...flushed, ...inspect(chunk)];
            }
          }
          /**
           * v0.22：套话定夺 —— 放在 `rescuedCalls > 0` 之前，因为它要改写 `outs`。
           *
           * 判「被替换」需要同时满足：这一轮真有工具调用（`hasToolCall` 或 `rescuedCalls>0`）、
           * 正文去掉空白 ≤24 字、且 reasoning 不以它开头（不同源）。
           * 被替换时：有思考就把思考当正文给用户看（他是好的，只是被盖住了），
           * 没思考就一个字都不给（宁可空，也不把假话当模型结论）。
           */
          if (pendingRefusal) {
            const rec = pendingRefusal;
            pendingRefusal = null;
            // 用 `thought`（这条流的所有 reasoning-delta）而不是 `thinkingText`：
            // 后者只在「把思考从正文里搬出去」那几条路径上累加，纯 reasoning-delta 不算，
            // 拿它来判「有没有思考」会永远是 0（第一版就栽在这）。
            const reasons = stripLeakedTags(thought).trim();
            const sameOrigin = rec.text.trim().length > 0 && squeeze(thought).startsWith(squeeze(rec.text).slice(0, 8));
            const short = squeeze(rec.text).length <= 24;
            const replaced = (hasToolCall || rescuedCalls > 0) && short && !sameOrigin;
            const shown = replaced ? (reasons.length > 0 ? 'reasoning' : 'nothing') : 'passthrough';
            appendLine(logFile, {
              at: new Date().toISOString(),
              kind: 'canned-refusal',
              provider: probe.provider ?? null,
              model: probe.model ?? null,
              canned: rec.text,
              reasoningLength: thought.length,
              shown,
              toolCalls: rescuedCalls,
              hasToolCall,
              action: replaced ? (reasons.length > 0 ? 'reasoning-as-text' : 'suppressed-silent') : 'passthrough',
            });
            if (replaced) {
              const outs2 = [];
              if (reasons.length > 0) {
                outs2.push({ type: 'block-start', index: rec.index, blockType: 'text' });
                outs2.push({ type: 'text-delta', index: rec.index, text: reasons });
                outs2.push({ type: 'block-end', index: rec.index, block: { type: 'text', text: reasons } });
              }
              const wasKind = chunk.reason && chunk.reason.kind ? chunk.reason.kind : 'none';
              const reason = wasKind === 'stop' ? { kind: 'tool-calls' } : chunk.reason;
              return [...outs2, reason ? { ...chunk, reason } : chunk];
            }
            // 真拒绝：原样放回（block-start / delta / block-end 三件套一起补）。
            return [
              { type: 'block-start', index: rec.index, blockType: 'text' },
              { type: 'text-delta', index: rec.index, text: rec.text },
              { type: 'block-end', index: rec.index, block: { type: 'text', text: rec.text } },
              chunk,
            ];
          }
          /**
           * v0.15：已经救回工具调用 → 这一步有产出，绝不能按「什么都没做」重跑；
           * 同时把 `stop` 改写成 `tool-calls`（语义准确；执行判定本来只看有没有
           * tool-call 块，见 dsh-agent-loop/lib/index.js:971）。
           */
          if (rescuedCalls > 0) {
            const was = chunk.reason && chunk.reason.kind ? chunk.reason.kind : 'none';
            const reason = chunk.reason && chunk.reason.kind === 'stop' ? { kind: 'tool-calls' } : chunk.reason;
            // v0.16：把「原来是什么收尾」落盘 —— 否则截断(max-tokens)被改写成
            // tool-calls 之后，事后完全看不出这次救回是不是从半截里捞出来的。
            appendLine(logFile, {
              at: new Date().toISOString(),
              kind: 'rescued-finish',
              provider: probe.provider ?? null,
              model: probe.model ?? null,
              calls: rescuedCalls,
              was,
              now: reason && reason.kind ? reason.kind : 'none',
            });
            return [reason ? { ...chunk, reason } : chunk];
          }
          /**
           * v0.21：整轮被判定成纯副本 → 这一轮什么都没产出，走既有 EMPTY_RESPONSE 重取。
           * 放在 `rescuedCalls > 0` 之后：真救回了调用就说明不是纯副本，别把好结果判死。
           */
          if (suppressedCopy && rescuedCalls === 0) {
            suppressedCopy = false;
            held = '';
            stopped = true;
            return [failureChunk()];
          }
          // v0.12：收尾时手里扣的还是标签噪声 → 直接当成「这一步什么都没产出」重跑。
          // 必须在这里判，因为 `finish` 一旦放过去，消费者就把这轮当正常结束了。
          if (isInternalTagSoup(held) || isInternalTagSoup(asm.text())) {
            held = '';
            stopped = true;
            noteRethink({ retried: true, soup: true });
            return [failureChunk()];
          }
          /**
           * v0.9/v0.10 收尾：整条消息只有被处理掉的内部草稿、既没有正文也没有工具调用。
           *
           * 这种「既然什么都没做」的步骤让 DSH 重跑才有意义——否则用户看到的是
           * 一个只有思考行、没有任何产出的空回答。用 EMPTY_RESPONSE 让它自动重试。
           */
          if (thinkingChars + draftChars > 0 && realTextChars === 0 && !hasToolCall) {
            noteRethink({ retried: true });
            stopped = true;
            return [failureChunk()];
          }
          if (thinkingChars + draftChars > 0) noteRethink({ retried: false });
          return [chunk];
        }

        return [chunk];
      } catch {
        // 观察失败绝不能影响主流程
        return [chunk];
      }
    };

    /**
     * 流结束时的收尾判定。
     *
     * 拦截模式下如果还有没下发的扣住内容，这里必须吐出去，
     * 否则消费者会收到空流（比残片更糟）。
     *
     * @returns {object[]} 收尾时补发的 chunk
     */
    const finalize = () => {
      try {
        const out = [];
        // v0.10：流结束时还压在探测/思考/草稿里的东西必须吐出去，否则前端收到的流是空的。
        if (convertState === 'probe' && probeBuf.length > 0) {
          if (pendingBlockStart) {
            out.push(pendingBlockStart);
            pendingBlockStart = null;
          }
          const buffered = probeBuf;
          probeBuf = '';
          emitRealText({ type: 'text-delta', index: blockIndex, text: buffered }, buffered, out);
        }
        if (convertState === 'think' && thinkHold.length > 0) {
          thinkingChars += thinkHold.length;
          thinkingText += thinkHold;
          out.push({ type: 'reasoning-delta', index: blockIndex, text: thinkHold });
          thinkHold = '';
        }
        if (convertState === 'draft') {
          draftChars += draftHold.length;
          draftHold = '';
        }
        convertState = 'idle';
        if (pendingBlockStart) {
          out.push(pendingBlockStart);
          pendingBlockStart = null;
        }
        if (synthOpen) {
          const rest = held;
          held = '';
          if (rest.length > 0) out.push({ type: 'text-delta', index: blockIndex + SYNTH_INDEX_OFFSET, text: rest });
          out.push({
            type: 'block-end',
            index: blockIndex + SYNTH_INDEX_OFFSET,
            block: { type: 'text', text: synthText },
          });
          synthOpen = false;
        }

        const verdict = judge();
        if (holding && verdict === 'retry') {
          held = '';
          stopped = true;
          return [failureChunk()];
        }
        if (holding && verdict === true) {
          held = '';
          out.push({ type: 'text-delta', index: 0, text: interceptText });
          return out;
        }
        if (held.length > 0) {
          out.push({ type: 'text-delta', index: 0, text: held });
          held = '';
        }
        return out;
      } catch {
        return [];
      }
    };

    const isIterable =
      typeof stream?.[Symbol.asyncIterator] === 'function' || typeof stream?.[Symbol.iterator] === 'function';

    if (!isIterable) {
      // 单值返回，原样透传（不做观察，无法安全包装）
      return stream;
    }

    /**
     * 上游迭代出错时留一条痕，然后**原样继续抛**。
     *
     * 为什么不吞：dsh-llm 的约定（lib/index.js L2309-2313）写得很清楚——
     *   适配器层（selection / dispatch / iteration）的失败由 `adapterStream`
     *   自己转成终态 `finish` chunk；而**中间件层的失败一律继续抛出**。
     * 我们就是中间件。吞掉异常会让上层永远等不到那个终态 chunk，
     * 那才是真正打断任务的做法。所以这里只记录，不改变异常本身。
     */
    const noteIterFailure = (e) => {
      try {
        appendLine(logFile, {
          at: new Date().toISOString(),
          kind: 'stream-error',
          provider: probe.provider ?? null,
          model: probe.model ?? null,
          error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
        });
      } catch {
        // 记录失败也不能影响抛出
      }
    };

    const asyncIter = stream[Symbol.asyncIterator] || stream[Symbol.iterator];

    const wrapper = {
      [Symbol.asyncIterator]() {
        const it = asyncIter.call(stream);

        /** 待下发的额外交付块。每个迭代器各自持有，避免多条流互相串味。 */
        let pendingTail = [];

        /**
         * 把一个结果交给消费者。
         *
         * 拦截模式下同一个源 chunk 可能拆成两个下发：第一个直接交出去，
         * 剩下的压进 `pendingTail`，下一次 `next()` 先把它吐完。
         */
        /**
         * 从上游取下一块，必要时循环跳过被扣住的部分。
         *
         * 为什么用循环而不是 `return this.next()`：递归会重新进入被消费者
         * 包装过的那一层（有些消费者会把 next 换成自己包一层的版本），
         * 导致异常被转成 done 或提前收尾。循环始终操作同一个 `it`。
         */
        const pull = async () => {
          for (;;) {
            if (pendingTail.length > 0) return { done: false, value: pendingTail.shift() };

            // 已经发出失败分片：上游剩余内容一律丢弃，安静收尾。
            // 让上游继续跑没有意义（重试器马上要重跑这一步），
            // 但也不能直接 return 不管——得把迭代器关掉，否则上游会抛 "already running"。
            if (stopped) {
              try {
                await it.return?.();
              } catch {
                // 关流失败不影响我们已经给出的失败分片
              }
              return { done: true, value: undefined };
            }

            let r;
            let iterError = null;
            let iterThrew = false;
            try {
              r = await it.next();
            } catch (e) {
              // 先把异常**存起来**，不能立刻抛 ——
              // 一旦从这个 async 函数里 throw，外面包的 for-await 会调用
              // 我们的 return()，而 return() 里又调 finalize()，状态就乱了。
              iterThrew = true;
              iterError = e;
            }

            if (iterThrew) {
              // 失败时不补发扣住的内容：上游已经坏了，吐出半截正文只会让人更困惑。
              // 只需把可能的残片判定记录下来（finalize 自身不会抛）。
              finalize();
              pendingTail = [];
              noteIterFailure(iterError);
              throw iterError;
            }

            if (r.done) {
              const tail = finalize();
              if (tail.length > 0) {
                pendingTail = tail;
                return { done: false, value: pendingTail.shift() };
              }
              return r;
            }

            const outs = inspect(r.value);
            if (outs.length === 0) continue; // 被扣住，继续往上要
            /**
             * 顺序必须保持：`outs[0]` 现在发，其余按原序压在 `pendingTail` 里。
             *
             * 早先这里调了 `deliver(...)`，而当次刚赋值的 `pendingTail` 非空，
             * 于是它先把 `outs[1]` 交了出去——`[text-delta, block-end]` 被颠倒成
             * 「先块尾、后正文」，DSH 侧收到块尾时正文还没到。v0.9 补发正文的
             * 场景会稳定触发，所以直接按序返回。
             */
            pendingTail = outs.slice(1);
            return { done: false, value: outs[0] };
          }
        };

        return {
          next: pull,
          async return(v) {
            const tail = finalize();
            if (tail.length > 0) pendingTail = tail;
            if (!it.return) return { done: true, value: v };
            try {
              return await it.return(v);
            } catch (e) {
              noteIterFailure(e);
              throw e;
            }
          },
          async throw(e) {
            finalize();
            if (!it.throw) throw e;
            try {
              return await it.throw(e);
            } catch (e2) {
              noteIterFailure(e2);
              throw e2;
            }
          },
        };
      },
    };
    return wrapper;
  };

  ctx.on('llm/stream', listener);
  ctx.logger?.info?.(`[dsml-guard] listening (action=${leakActionMode})`);
}
