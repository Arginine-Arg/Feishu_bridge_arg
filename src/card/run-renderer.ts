import type { Block, FooterStatus, RunState, ToolEntry } from './run-state';
import { toolBodyMd, toolHeaderText } from './tool-render';

const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

/**
 * Cumulative byte ceiling for a single rendered card. Feishu's per-element
 * limit is ~30KB and per-card overhead varies; 24KB leaves comfortable
 * headroom for JSON wrapping (schema field, summary, borders, etc.) plus
 * safety against per-element limit drift across API versions.
 *
 * When a `RunState` would render over this, the renderer force-collapses
 * the **earlier** tools' bodies via `collapsedToolSummary` and prepends an
 * `_N 更早的工具详情已折叠…_` marker. The latest tool, if any, keeps its
 * full panel because that's the one the user is watching right now.
 *
 * This is intentionally aggressive — a 30KB-ish stream patch that
 * `ctrl.update()` posts is a known failure mode in production (feishu
 * returns 230011 / withdrawn errors), and small-but-still-oversize cards
 * cause the user's reply to be silently clipped. Better to lose the older
 * tool bodies (always recoverable from `/doctor` or the daemon log) than
 * lose the whole conversation.
 */
export const CARD_BYTE_BUDGET = 24_000;

interface ToolGroup {
  kind: 'tools';
  tools: ToolEntry[];
}
interface TextGroup {
  kind: 'text';
  content: string;
}
type Group = ToolGroup | TextGroup;

export interface RunCardRenderOptions {
  signCallback?: (action: string) => string;
}

export function renderCard(state: RunState, options: RunCardRenderOptions = {}): object {
  const elements: object[] = [];

  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  // Index of each tool group in `elements` so we can collapse the earliest
  // one(s) when the cumulative card size blows past CARD_BYTE_BUDGET. The
  // latest group is always preserved (it's the one the user is watching).
  const groupElementRange: Array<{ start: number; toolCount: number }> = [];
  const textBlockRanges: Array<{ start: number; markdownElIdx: number }> = [];
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      const content = group.content.trim();
      if (content) {
        const start = elements.length;
        elements.push(markdown(content));
        textBlockRanges.push({ start, markdownElIdx: elements.length - 1 });
      }
    } else {
      const start = elements.length;
      elements.push(...renderToolGroup(group.tools, state.terminal !== 'running'));
      groupElementRange.push({ start, toolCount: group.tools.length });
    }
  }

  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应,已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done' && elements.length === 0) {
    elements.push(noteMd('_（未返回内容）_'));
  }

  if (state.terminal === 'running') {
    if (state.footer) {
      // Surface the running tool's elapsed time only while a tool is in
      // flight — for 'thinking'/'streaming' footers there's no useful
      // duration to display.
      const elapsedMs =
        state.footer === 'tool_running' ? state.currentToolElapsedMs : undefined;
      elements.push(footerStatus(state.footer, elapsedMs));
    }
    elements.push(stopButton(options));
  }

  return enforceCardByteBudget(state, elements, groupElementRange, textBlockRanges);
}

/**
 * Collapse tool groups from the earliest first until the serialized card is
 * under CARD_BYTE_BUDGET. Replaces each collapsed group with a single
 * `collapsedToolSummary` (header + per-tool title, no bodies) so the user
 * still sees *that* the tools ran, with their headers (icon + name + short
 * input summary). Bodies are always recoverable from `/doctor` or the daemon
 * log via the runId.
 *
 * Strategy:
 *   1. Serialize the card with the current elements.
 *   2. If over budget, walk `foldCount` from 1..N-1 (preserving the last
 *      group's full panels). At each step, build a fresh elements list:
 *      elements before the first group + one collapsed summary + elements
 *      from the rest of the source (skipping the folded groups' tool
 *      panels).
 *   3. Prepend a fold-marker note (so the user understands the gap) and
 *      re-measure. Stop as soon as we drop below the budget. Bail out and
 *      return the best-attempt card if even fully-folded doesn't fit (the
 *      SDK will likely reject; at least we tried).
 */
function enforceCardByteBudget(
  state: RunState,
  elements: object[],
  groupElementRange: Array<{ start: number; toolCount: number }>,
  textBlockRanges: Array<{ start: number; markdownElIdx: number }>,
): object {
  const wrap = (body: object[]): object => ({
    schema: '2.0',
    config: {
      streaming_mode: state.terminal === 'running',
      summary: { content: summaryText(state) },
    },
    body: { elements: body },
  });

  const sizeOf = (els: object[]): number => JSON.stringify(wrap(els)).length;
  if (sizeOf(elements) <= CARD_BYTE_BUDGET) return wrap(elements);

  // Pass 1: fold earliest tool groups into header-only summaries.
  // Tool bodies are already aggressively truncated to BODY_TOTAL_MAX in
  // tool-render.ts, but with many tools the cumulative panel overhead can
  // still exceed budget. We preserve the most recent tool group's full
  // panels — that's the one the user is watching.
  let workingElements = elements.slice();
  const groupTools: ToolEntry[][] = [];
  for (const g of groupBlocks(state.blocks)) {
    if (g.kind === 'tools') groupTools.push(g.tools);
  }
  for (let foldCount = 1; foldCount < groupElementRange.length; foldCount++) {
    const firstStart = groupElementRange[0]!.start;
    const firstUnfoldedStart = groupElementRange[foldCount]!.start;
    const foldedTools = groupTools.slice(0, foldCount).flat();
    if (foldedTools.length === 0) continue;
    const newBody: object[] = [];
    for (let i = 0; i < firstStart; i++) newBody.push(workingElements[i]!);
    newBody.push(
      noteMd(
        `_… ${foldedTools.length} 个更早的工具调用详情已折叠（完整内容见 /doctor 或 daemon 日志）_`,
      ),
    );
    newBody.push(
      collapsedToolSummary(foldedTools, state.terminal !== 'running'),
    );
    for (let i = firstUnfoldedStart; i < workingElements.length; i++) {
      newBody.push(workingElements[i]!);
    }
    workingElements = newBody;
    if (sizeOf(workingElements) <= CARD_BYTE_BUDGET) {
      return wrap(workingElements);
    }
  }

  // Pass 2: if tool folding alone isn't enough, the oversize is in text
  // blocks (streaming assistant text has no per-block cap). Truncate each
  // text markdown body to fit. We re-use each block's markdown element and
  // shrink its `content` until the card body fits.
  if (textBlockRanges.length === 0) {
    // Nothing left to trim. Return best-effort.
    return wrap(workingElements);
  }
  // Get all text-block contents in order; we'll iteratively shrink the
  // largest one until we fit.
  // Re-walk groups to fetch the original (untruncated) text contents.
  const textContents: string[] = [];
  for (const g of groupBlocks(state.blocks)) {
    if (g.kind === 'text') {
      const c = g.content.trim();
      if (c) textContents.push(c);
    }
  }
  // Map textBlockRanges[i] → textContents[i] by index (same order).
  for (let pass = 0; pass < 32; pass++) {
    if (sizeOf(workingElements) <= CARD_BYTE_BUDGET) return wrap(workingElements);
    // Find the largest text markdown element and chop its tail by 25%.
    let largestIdx = -1;
    let largestLen = 0;
    for (let i = 0; i < textBlockRanges.length; i++) {
      const range = textBlockRanges[i]!;
      const el = workingElements[range.markdownElIdx] as { content?: string };
      const len = el?.content?.length ?? 0;
      if (len > largestLen) {
        largestLen = len;
        largestIdx = i;
      }
    }
    if (largestIdx === -1) break;
    const range = textBlockRanges[largestIdx]!;
    const el = workingElements[range.markdownElIdx] as { content?: string };
    if (!el?.content) break;
    const newLen = Math.max(0, Math.floor(el.content.length * 0.75));
    const truncated =
      newLen > 0
        ? `${el.content.slice(0, newLen)}\n\n_… 已截断（${el.content.length - newLen} 字已折叠）_`
        : '_（内容已折叠）_';
    workingElements[range.markdownElIdx] = { tag: 'markdown', content: truncated };
  }

  return wrap(workingElements);
}

function* groupBlocks(blocks: Block[]): Generator<Group> {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf };
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content };
    }
  }
  if (toolBuf.length > 0) yield { kind: 'tools', tools: toolBuf };
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): object[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  // Running: collapse prior tools, keep latest visible.
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: object[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean): object {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean): object {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

/**
 * Render N tool calls as a single collapsed panel. **Body content is dropped**
 * — only the per-tool header line (icon + name + short summary) is kept.
 *
 * Why no bodies: with full input/output panels nested, the serialized JSON
 * can easily exceed Feishu's per-element size limit (~30KB), causing 400
 * errors that abort the entire card stream. Tool details are still in the
 * file log; users who really need them can `/doctor` to inspect.
 *
 * The latest-running tool, when applicable, is rendered separately via
 * `toolPanel(latest, true)` so live observation isn't sacrificed.
 */
function collapsedToolSummary(tools: ToolEntry[], finalized: boolean): object {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

interface PanelOpts {
  title: string;
  expanded: boolean;
  border: 'grey' | 'red' | 'blue';
  body: string;
}

function collapsiblePanel(opts: PanelOpts): object {
  return {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    border: { color: opts.border, corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
}

function panelHeader(titleMd: string): object {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function noteMd(content: string): object {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(options: RunCardRenderOptions): object {
  const value: Record<string, unknown> = { cmd: 'stop' };
  if (options.signCallback) {
    value.__bridge_cb = true;
    value.bridge_token = options.signCallback('stop');
  }
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value }],
  };
}

function footerStatus(status: Exclude<FooterStatus, null>, elapsedMs?: number): object {
  const baseText =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
        ? '🧰 正在调用工具'
        : '✍️ 正在输出';
  return noteMd(appendElapsed(baseText, elapsedMs));
}

/**
 * Append a `_已运行 X 分 Y 秒_` suffix to a footer string when `elapsedMs`
 * is set. Returns the input unchanged otherwise. The format is human-friendly
 * Chinese: 12 秒 / 3 分 14 秒 / 1 时 5 分 — terse enough not to inflate the
 * 30KB-per-element Feishu card budget.
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) {
    const sec = totalSec % 60;
    return sec > 0 ? `${totalMin} 分 ${sec} 秒` : `${totalMin} 分`;
  }
  const hour = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hour} 时 ${min} 分` : `${hour} 时`;
}

function appendElapsed(base: string, ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return base;
  return `${base} · 已运行 ${formatElapsed(ms)}`;
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
