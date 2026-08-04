import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  liveInteractionCard,
  liveInteractionCardForText,
  parseNativeCodexModelSelection,
  renderLiveAwareReplyCard,
} from '../../../src/bot/channel.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import {
  isStructuredLiveInteraction,
  liveInteractionSurface,
  parseLiveInteractionOptions,
} from '../../../src/agent/live-interaction-detection.js';
import { initialState, reduce, type RunState } from '../../../src/card/run-state.js';
import {
  AGENT_INPUT_CALLBACK_ACTION,
  BRIDGE_CALLBACK_MARKER,
  LIVE_INPUT_CALLBACK_ACTION,
} from '../../../src/card/dispatcher.js';

function buttonValues(card: unknown): Array<Record<string, unknown>> {
  const values: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (obj.tag === 'button' && Array.isArray(obj.behaviors)) {
      for (const behavior of obj.behaviors as Array<Record<string, unknown>>) {
        if (behavior.type === 'callback' && behavior.value && typeof behavior.value === 'object') {
          values.push(behavior.value as Record<string, unknown>);
        }
      }
    }
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return values;
}

function tags(card: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    if (typeof obj.tag === 'string') out.push(obj.tag);
    for (const value of Object.values(obj)) walk(value);
  };
  walk(card);
  return out;
}

describe('liveInteractionCard', () => {
  it('parses native Codex model confirmations with new reasoning levels', () => {
    expect(parseNativeCodexModelSelection('• Model changed to gpt-5.6-sol ultra')).toEqual({
      model: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    });
    expect(parseNativeCodexModelSelection('Model changed to gpt-5.6-terra Extra high')).toEqual({
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
    });
    expect(parseNativeCodexModelSelection('Model changed to gpt-5.6-luna (reasoning max)')).toEqual({
      model: 'gpt-5.6-luna',
      reasoningEffort: 'max',
    });
    expect(parseNativeCodexModelSelection('Model changed to claude-opus-4-8 high')).toBeUndefined();
  });

  it('signs each live input button as a bridge callback', () => {
    let n = 0;
    const card = liveInteractionCard(
      {
        signature: 'model-picker',
        prompt: 'Select Model and Effort\n1. gpt-5.5\n2. gpt-5.4\nPress enter to confirm or esc to go back',
        buttons: [
          { label: '1', input: '1' },
          { label: 'enter', input: 'enter' },
          { label: 'esc', input: 'esc' },
        ],
      },
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `tok-${n++}`;
      },
    );

    const values = buttonValues(card);
    expect(values).toHaveLength(3);
    expect(values.map((value) => value.input)).toEqual(['1', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual(['tok-0', 'tok-1', 'tok-2']);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
    expect(tags(card)).toContain('button');
    expect(tags(card)).not.toContain('action');
  });

  it('renders model picker text as signed live input controls', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      [
        'Select Model and Effort',
        'Access legacy models by running codex -m <model_name> or in your config.toml',
        '',
        '› 1. gpt-5.5 (current)  Frontier model for complex coding, research, and real-world work.',
        '2. gpt-5.4            Strong model for everyday coding.',
        '3. gpt-5.4-mini       Small, fast, and cost-efficient model for simpler coding tasks.',
        '4. gpt-5.3-codex      Coding-optimized model.',
        '5. gpt-5.2            Optimized for professional work and long-running agents.',
        'Press enter to confirm or esc to go back',
      ].join('\n'),
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `picker-token-${n++}`;
      },
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.input)).toEqual(['1', '2', '3', '4', '5', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'picker-token-0',
      'picker-token-1',
      'picker-token-2',
      'picker-token-3',
      'picker-token-4',
      'picker-token-5',
      'picker-token-6',
    ]);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('keeps indented confirmation hints in the prompt without making them buttons', () => {
    const text = [
      'Select Reasoning Level for gpt-5.6-luna',
      '  1. Low                        Fast responses with lighter reasoning',
      '  2. Medium (default)           Balances speed and reasoning depth for everyday tasks',
      '› 3. High                       Greater reasoning depth for complex problems',
      '  4. Extra high                 Extra high reasoning depth for complex problems',
      '  5. More reasoning… (current)  Max consumes usage limits faster',
      '  Press enter to confirm or esc to go back',
    ].join('\n');

    expect(parseLiveInteractionOptions(text).map((option) => option.key ?? option.label)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    const card = liveInteractionCardForText(text, () => 'reasoning-token');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', '2', '3', '4', '5', 'enter', 'esc']);
    expect(JSON.stringify(card)).toContain('Press enter to confirm or esc to go back');
  });

  it('recovers a choice that scrolled out during a same-menu redraw', () => {
    const text = [
      'Select Model',
      '› 1. gpt-5.6-sol (current)',
      '2. gpt-5.6-terra',
      '3. gpt-5.6-luna',
      '4. gpt-5.5',
      '5. gpt-5.2',
      'Press enter to confirm or esc to go back',
      'Select Model',
      '2. gpt-5.6-terra',
      '› 3. gpt-5.6-luna (current)',
      '4. gpt-5.5',
      '5. gpt-5.2',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    const card = liveInteractionCardForText(text, () => 'redraw-token');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', '2', '3', '4', '5', 'enter', 'esc']);
    expect(JSON.stringify(card)).toContain('gpt-5.6-sol');
  });

  it('does not hide an explicit option whose label mentions Enter', () => {
    const text = ['Select an action', '1. Enter to continue setup', '2. Cancel', 'Choose one:'].join('\n');
    expect(parseLiveInteractionOptions(text).map((option) => option.key)).toEqual(['1', '2']);
  });

  it('does not promote source-code diffs containing picker-looking rows', () => {
    const text = [
      "171 +      'Select Model',",
      '1. gpt-5.6-sol (selected)',
      '2. gpt-5.6-terra',
      '3. gpt-5.6-luna',
      '4. gpt-5.5',
      '5. gpt-5.2',
      '172. gpt-5.6-sol (current)',
      '173. gpt-5.6-terra',
      '174. gpt-5.6-luna',
      '175. gpt-5.5',
      '176. gpt-5.2',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionCardForText(text, () => 'source-code-token')).toBeUndefined();
  });

  it('does not promote a long source diff after the fallback tail drops its first line', () => {
    const text = [
      "171 +      'Select Model',",
      '1. gpt-5.6-sol (selected)',
      '2. gpt-5.6-terra',
      '3. gpt-5.6-luna',
      '4. gpt-5.5',
      '5. gpt-5.2',
      '172. gpt-5.6-sol (current)',
      '173. gpt-5.6-terra',
      '174. gpt-5.6-luna',
      '175. gpt-5.5',
      '176. gpt-5.2',
      '179. gpt-5.6-terra',
      '180. gpt-5.6-luna (current)',
      '181. gpt-5.5',
      '182. gpt-5.2',
      '189. gpt-5.6-sol',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionSurface(text)).toBeUndefined();
    expect(liveInteractionCardForText(text, () => 'long-source-code-token')).toBeUndefined();
  });

  it('rejects repeated source rows even when the diff line is outside the tail window', () => {
    const text = [
      "171 +      'Select Model',",
      ...Array.from({ length: 130 }, (_, index) => `history line ${index}`),
      '1. gpt-5.6-sol (selected)',
      '2. gpt-5.6-terra',
      '3. gpt-5.6-luna',
      '4. gpt-5.5',
      '5. gpt-5.2',
      '172. gpt-5.6-sol (current)',
      '173. gpt-5.6-terra',
      '174. gpt-5.6-luna',
      '175. gpt-5.5',
      '176. gpt-5.2',
      '179. gpt-5.6-terra',
      '180. gpt-5.6-luna (current)',
      '181. gpt-5.5',
      '182. gpt-5.2',
      '189. gpt-5.6-sol',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionCardForText(text, () => 'distant-source-code-token')).toBeUndefined();
  });

  it('waits for a complete picker frame, then preserves its first choice', () => {
    const firstFrame = [
      'Select Model and Effort',
      '› 1. gpt-5.6-sol (current)',
    ].join('\n');
    const completeFrame = [
      firstFrame,
      '2. gpt-5.6-terra',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    expect(liveInteractionCardForText(firstFrame, () => 'partial')).toBeUndefined();
    const card = liveInteractionCardForText(completeFrame, () => 'complete');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
    expect(JSON.stringify(card)).toContain('1. gpt-5.6-sol');
  });

  it('detects an untitled letter picker and sends literal keys', () => {
    const text = [
      'Which deployment target should receive the change?',
      'a) staging',
      'b) production',
      'Choose one:',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(true);
    expect(liveInteractionSurface(text)).toBe(text);
    expect(parseLiveInteractionOptions(text)).toEqual([
      { key: 'a', label: 'staging', selected: false, navigationOnly: false },
      { key: 'b', label: 'production', selected: false, navigationOnly: false },
    ]);
    const card = liveInteractionCardForText(text, () => 'letter-picker');
    expect(buttonValues(card).map((value) => value.input)).toEqual(['a', 'b', 'enter', 'esc']);
  });

  it('detects a question-only picker without vendor or prompt keywords', () => {
    const text = ['Which environment should receive the deployment?', '1. staging', '2. production'].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(true);
    expect(liveInteractionSurface(text)).toBe(text);
    const card = liveInteractionCardForText(text, () => 'question-only-picker');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
  });

  it('publishes a one-row picker when an explicit answer prompt is present', () => {
    const text = ['Select the only available workspace', '1. GPU-5090', 'Press Enter to continue'].join('\n');

    const card = liveInteractionCardForText(text, () => 'single-row-picker');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', 'enter', 'esc']);
  });

  it('accepts space-delimited numeric and letter option rows', () => {
    const text = ['Select an environment', '1 staging', '2 production', 'a sandbox', 'b review', 'Answer:'].join(
      '\n',
    );
    expect(parseLiveInteractionOptions(text).map((option) => option.key)).toEqual(['1', '2', 'a', 'b']);
    expect(liveInteractionCardForText(text, () => 'space-delimited-picker')).toBeDefined();
  });

  it('does not confuse a hyphen-separated numeric choice with a source diff', () => {
    const text = ['Select a runtime profile', '1 - local GPU', '2 - remote GPU', 'Press Enter to continue'].join(
      '\n',
    );
    expect(liveInteractionCardForText(text, () => 'hyphen-picker')).toBeDefined();
    expect(buttonValues(liveInteractionCardForText(text, () => 'hyphen-picker'))).toHaveLength(4);
  });

  it('maps checkbox and radio rows to navigation controls without vendor names', () => {
    const text = [
      'Select capabilities:',
      '[ ] read-only',
      '[ ] network access',
      'Use arrow keys and Enter to continue',
    ].join('\n');
    const card = liveInteractionCardForText(text, () => 'checkbox-picker');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual([
      'enter',
      'down enter',
      'esc',
    ]);
    expect(JSON.stringify(card)).toContain('network access');
  });

  it('keeps checkbox state separate from the current cursor marker', () => {
    expect(
      parseLiveInteractionOptions(
        ['Select features:', '› [x] already enabled', '  [ ] optional feature', 'Press Enter to continue'].join(
          '\n',
        ),
      ),
    ).toEqual([
      { label: 'already enabled', selected: true, checked: true, navigationOnly: true },
      { label: 'optional feature', selected: false, navigationOnly: true },
    ]);
  });

  it('detects a title-free arrow menu and preserves its option rows', () => {
    const text = ['› deploy to staging', '  deploy to production', 'Choose one:'].join('\n');
    const card = liveInteractionCardForText(text, () => 'arrow-picker');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['enter', 'down enter', 'esc']);
    expect(JSON.stringify(card)).toContain('deploy to production');
  });

  it('uses navigation for an unknown numeric menu when the terminal requests arrow keys', () => {
    const text = [
      'Select a runtime profile',
      '› 1. local GPU',
      '2. remote GPU',
      '3. CPU fallback',
      'Use arrow keys to navigate, then press Enter to choose',
    ].join('\n');
    const card = liveInteractionCardForText(text, () => 'arrow-numeric-picker');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual([
      'enter',
      'down enter',
      'down down enter',
      'esc',
    ]);
  });

  it('recognizes a genuine generic bullet menu but ignores quoted activity', () => {
    const menu = ['Available targets:', '• staging', '• production', 'Press Enter to continue'].join('\n');
    const menuCard = liveInteractionCardForText(menu, () => 'bullet-picker');
    expect(menuCard).toBeDefined();
    expect(buttonValues(menuCard).map((value) => value.input)).toEqual(['enter', 'down enter', 'esc']);

    const quotedActivity = [
      '> _▸ 执行活动（2 项）_',
      '> • Explored',
      '> └ Read src/agent/live-session.ts',
      '• 已完成检查。',
    ].join('\n');
    expect(liveInteractionCardForText(quotedActivity, () => 'quoted-activity')).toBeUndefined();
  });

  it('keeps a generic menu with more than the old model button cap intact', () => {
    const options = Array.from({ length: 30 }, (_, index) => `${index + 1}. profile-${index + 1}`);
    const text = ['Pick a profile:', ...options, 'Press Enter to continue'].join('\n');
    const card = liveInteractionCardForText(text, () => 'large-picker');
    expect(buttonValues(card).map((value) => value.input).slice(0, 30)).toEqual(
      options.map((_, index) => String(index + 1)),
    );
    expect(buttonValues(card)).toHaveLength(32);
  });

  it('maps the Claude bypass warning to safe terminal navigation keys', () => {
    const card = liveInteractionCardForText(
      [
        'WARNING: Claude Code running in Bypass Permissions mode',
        '',
        'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
        '',
        '❯ 1. No, exit',
        '  2. Yes, I accept',
        '',
        'Enter to confirm · Esc to cancel',
      ].join('\n'),
      () => 'claude-startup-token',
    );

    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => [value.input, value.cmd])).toEqual([
      ['enter', 'live.input'],
      ['down enter', 'live.input'],
      ['esc', 'live.input'],
    ]);
  });

  it('maps Claude model choices to arrow navigation instead of literal numbers', () => {
    const card = liveInteractionCardForText(
      [
        'Select Model',
        '› 1. claude-opus-4-8 (current)',
        '2. claude-sonnet-5',
        '3. claude-haiku-4-5-20251001',
        'Press enter to confirm or esc to go back',
      ].join('\n'),
      () => 'claude-model-token',
    );

    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual([
      'enter',
      'down enter',
      'down down enter',
      'esc',
    ]);
  });

  it('maps the Codex update picker to explicit navigation choices', () => {
    const card = liveInteractionCardForText(
      [
        'Update available! 0.144.3 -> 0.145.0',
        '❯ 1. Update now',
        '  2. Skip',
        '  3. Skip until next version',
        'Enter to confirm · Esc to cancel',
      ].join('\n'),
      () => 'codex-update-token',
    );

    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual([
      'enter',
      'down enter',
      'down down enter',
      'esc',
    ]);
  });

  it('renders an untitled Codex resume screen as live controls', () => {
    const card = liveInteractionCardForText(
      [
        '──────────────────────────────────────── 1 / 16 · 100% ─',
        'session 1: latest research task',
        'session 2: benchmark diagnosis',
        'enter resume   esc exit   ctrl+c exit   tab focus sort/filter   ←/→ change option',
        'ctrl+o comfortable view   ctrl+t transcript   ctrl+e expand   ↑/↓ browse',
      ].join('\n'),
      () => 'resume-token',
    );

    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual([
      'enter',
      'esc',
      'ctrl+c',
      'tab',
      'left',
      'right',
      'up',
      'down',
    ]);
    expect(JSON.stringify(card)).toContain('session 1: latest research task');
  });

  it('keeps all model choices when descriptions wrap and terminal rows are joined', () => {
    const card = liveInteractionCardForText(
      [
        'old terminal output',
        'Select Model and Effort',
        'Access legacy models by running codex -m <model_name> or in your config.toml',
        '› 1. gpt-5.6-sol (current)',
        'Latest frontier agentic coding model.',
        '2. gpt-5.6-terra',
        'Balanced agentic coding model for everyday work.',
        '3. gpt-5.6-luna',
        'Fast and affordable agentic coding model.',
        '4. gpt-5.5',
        'Frontier model for complex coding, research, and real-world work.',
        '5. gpt-5.4',
        'Strong model for everyday coding.',
        'and cost-efficient model for simpler coding tasks 6.rgpt-5.4-mini',
        'Optimized for professional work and long-running agents 7. gpt-5.2',
        'Press enter to confirm or esc to go back',
      ].join('\n'),
      () => 'wrapped-token',
    );

    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      'enter',
      'esc',
    ]);
    const rendered = JSON.stringify(card);
    for (const model of [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini',
      'gpt-5.2',
    ]) {
      expect(rendered).toContain(model);
    }
    expect(rendered).not.toContain('Frontier model for complex coding');
  });

  it('renders skills picker text as signed live input controls', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      [
        'Skills',
        'Choose an action',
        '',
        '› 1. List skills            Tip: press @ to open this list directly.',
        '2. Enable/Disable Skills  Enable or disable skills.',
      ].join('\n'),
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `skills-token-${n++}`;
      },
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'skills-token-0',
      'skills-token-1',
      'skills-token-2',
      'skills-token-3',
    ]);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('renders native permission choices as signed numeric tmux input', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      [
        'Would you like to run the following command?',
        '',
        'Environment: local',
        '',
        'Reason: Allow the one-GPU CURE smoke test to initialize PyTorch\'s local TCPStore and use the local GPU.',
        '',
        '$ CURE_NPROC_PER_NODE=1 bash chem/runs/cure_l1000_tfe_alignment_train.sh hgraph',
        '',
        '› 1. Yes, proceed (y)',
        "2. Yes, and don't ask again for commands that start with `CURE_NPROC_PER_NODE=1` (p)",
        '3. No, and tell Codex what to do differently (esc)',
      ].join('\n'),
      (action) => {
        expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
        return `permission-token-${n++}`;
      },
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.input)).toEqual(['1', '2', '3', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'permission-token-0',
      'permission-token-1',
      'permission-token-2',
      'permission-token-3',
      'permission-token-4',
    ]);
    for (const value of values) {
      expect(value.cmd).toBe('live.input');
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('renders picker output as controls from the main card reply path', () => {
    let n = 0;
    const card = renderLiveAwareReplyCard(
      stateFrom([
        {
          type: 'text',
          delta: [
            'Select Model and Effort',
            '1. gpt-5.5',
            '2. gpt-5.4',
            'Press enter to confirm or esc to go back',
          ].join('\n'),
        },
      ]),
      {
        signCallback: (action) => {
          expect(action).toBe(LIVE_INPUT_CALLBACK_ACTION);
          return `main-path-token-${n++}`;
        },
      },
      'live',
    );

    const values = buttonValues(card);
    expect(values.map((value) => value.cmd)).toEqual([
      'live.input',
      'live.input',
      'live.input',
      'live.input',
    ]);
    expect(values.map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
    expect(values.map((value) => value.bridge_token)).toEqual([
      'main-path-token-0',
      'main-path-token-1',
      'main-path-token-2',
      'main-path-token-3',
    ]);
  });

  it('renders non-live prompts as signed agent input controls', () => {
    let n = 0;
    const card = liveInteractionCardForText(
      'Do you want to proceed with applying this patch?',
      (action) => {
        expect(action).toBe(AGENT_INPUT_CALLBACK_ACTION);
        return `agent-token-${n++}`;
      },
      'agent',
    );

    expect(card).toBeDefined();
    const values = buttonValues(card);
    expect(values.map((value) => value.cmd)).toEqual(['agent.input', 'agent.input']);
    expect(values.map((value) => value.input)).toEqual(['yes', 'no']);
    expect(values.map((value) => value.bridge_token)).toEqual(['agent-token-0', 'agent-token-1']);
    for (const value of values) {
      expect(value[BRIDGE_CALLBACK_MARKER]).toBe(true);
    }
  });

  it('can skip prompts already sent as standalone interaction cards', () => {
    const text = [
      'Select Model and Effort',
      '1. gpt-5.5',
      '2. gpt-5.4',
      'Press enter to confirm or esc to go back',
    ].join('\n');
    const first = liveInteractionCardForText(text, () => 'tok');
    expect(first).toBeDefined();
    const signature = createHash('sha256')
      .update(text)
      .update('\0')
      .update('1|2|enter|esc')
      .digest('hex');
    expect(liveInteractionCardForText(text, () => 'tok', 'live', new Set([signature]))).toBeUndefined();
  });

  it('does not convert ordinary text into a live input card', () => {
    expect(liveInteractionCardForText('哈喽，我在。有什么要我处理的任务，直接发我就行。')).toBeUndefined();
    expect(liveInteractionCardForText('处理结果：\n1. 已更新依赖\n2. 已运行测试')).toBeUndefined();
    expect(liveInteractionCardForText('The query will select rows from the table.')).toBeUndefined();
    expect(
      liveInteractionCardForText(
        '接管后的首轮审计确认已完成。工具返回正常，我会从断点继续执行。',
        () => 'tok',
        'agent',
      ),
    ).toBeUndefined();
    expect(
      liveInteractionCardForText(
        [
          '• 我会按你的要求做两处结构调整，请选择更直接的表述。',
          '• 现有模型是否考虑 pathway programs？请回复审阅意见。',
          '• Edited stablefate_aaai_abstract_bilingual_2026-07-20.md (+2 -2)',
          '7 -Word count: 180 words',
          '7 +Word count: 179 words',
          '• 已按你的要求修改：英文与中文摘要已经同步完成。',
        ].join('\n'),
        () => 'tok',
        'live',
      ),
    ).toBeUndefined();
    expect(
      liveInteractionCardForText(
        [
          'Select Model and Effort',
          '1. gpt-5.5',
          'Press enter to confirm or esc to go back',
          '• 已完成任务，这是最终答复。',
        ].join('\n'),
        () => 'tok',
        'live',
      ),
    ).toBeUndefined();
    const academicDesign = [
      'generated molecule',
      '推理时禁止出现：',
      '目标 SMILES',
      '目标分子 MMELON embedding',
      '目标 fragment',
      '目标 graph',
      '目标 node count',
      '目标 attachment',
      '8. 为什么这可能比当前 Bio bridge 有效',
      '当前 Bio 失败可能不是 Bio 没有信息，而是：',
      'Bio information -> pooled representation -> source bridge -> DeFoG graph trajectory',
      '推荐的实验顺序是：',
      'A. 当前 Bio bridge',
      'B. Bio denoising/AR only',
      'C. Bio AR + linear chemical bridge',
      'D. Bio AR + bridge + shared DeFoG flow',
      '更详细的告诉我这个原理，和方案细节',
      '• 先明确一个边界：这套方案目前是新方案设计，不是当前 V126/V128 的已有实现。',
      '一、完整训练结构',
      'K 个 chemical queries',
      'attention pooling',
      'c_bio [B,768]',
      'molecular bridge',
      'u_m^teacher',
      '二、Bio Transformer 到底学习什么输入仍然是：[FATE_UP][PATHWAY_UP][GENES][PATHWAY_DOWN][FATE_DOWN]',
      '三、chemical teacher 是什么',
      '1. Bio representation gate',
      '2. Teacher-forced chemical gate',
      '3. Reference-blind Bio C gate',
      '4. 独立生物学 gate',
      '当前最应该先做的是一个低成本的 linear probe。',
    ].join('\n');
    expect(isStructuredLiveInteraction(academicDesign)).toBe(false);
    expect(liveInteractionSurface(academicDesign)).toBeUndefined();
    expect(liveInteractionCardForText(academicDesign, () => 'academic-design-token')).toBeUndefined();
  });

  it('does not turn bridge tool traces and progress updates into a picker', () => {
    const text = [
      '0fc351f (HEAD -> release-v0.6.35, tag: v0.6.68, origin/main) fix(picker): prevent false interactive cards and preserve redrawn choices',
      '• Ran node dist/cli.js --version && node -e "const p=require(\'./package.json\'); if(p.version!==\'0.6.68\') process.exit(1)"; sha256sum dist/cli.js dist/index.js package.json',
      '  │ process.exit(1); console.log(\'package version\',p.version)"; git status --short',
      '• GitHub 已接收提交，Release 和三路 CI 工作流都在运行中；标签对应的 Release 资产尚未生成。',
      '• Ran curl -fsSL --max-time 20 https://api.github.com/repos/Arginine-Arg/Feishu_bridge_arg/actions/runs/30869317268 | node -e "let s=\'\'; process.stdin.on(\'data\',d=>s+=d)"',
      '  │ console.log(JSON.stringify({status:r.status,conclusion:r.conclusion,html_url:r.html_url}));',
      '• 我又做了一个边界压力测试：如果污染代码行距离当前选择窗超过 120 行，旧逻辑仍可能误判。',
      '• Ran curl -fsSL --max-time 20 https://api.github.com/repos/Arginine-Arg/Feishu_bridge_arg/actions/runs/30869317268',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionSurface(text)).toBeUndefined();
    expect(liveInteractionCardForText(text, () => 'tool-trace-token')).toBeUndefined();
  });

  it('does not classify the full release-verification trace as a picker', () => {
    const text = [
      '0fc351f (HEAD -> release-v0.6.35, tag: v0.6.68, origin/release-v0.6.35, origin/main, origin/HEAD) fix(picker):',
      '    prevent false interactive cards and preserve redrawn choices',
      '• Ran node dist/cli.js --version && node -e "const p=require(\'./package.json\'); if(p.version!==\'0.6.68\')',
      '  │ process.exit(1); console.log(\'package version\',p.version)"; sha256sum dist/cli.js dist/index.js package.json',
      '  │ -e "let s=\'\'; process.stdin.on(\'data\',d=>s+=d); process.stdin.on(\'end\',()=>{const x=JSON.parse(s);',
      '  │ https://api.github.com/repos/Arginine-Arg/Feishu_bridge_arg/actions/runs?event=push\\&per_page=5 | node -e "let',
      '• GitHub 已接收提交，Release 和三路 CI 工作流都在运行中；标签对应的 Release 资产尚未生成（不是 404 配置问题，而是工作流尚未完成）。',
      '• Ran curl -fsSL --max-time 20 https://api.github.com/repos/Arginine-Arg/Feishu_bridge_arg/actions/runs/30869317268 |',
      '  │ console.log(JSON.stringify({status:r.status,conclusion:r.conclusion,html_url:r.html_url,updated_at:r.updated_at},null,2));',
      '• 我又做了一个边界压力测试：如果污染代码行距离当前选择窗超过 120 行，旧逻辑仍可能只看到重复的数字行而误判。',
      '• Ran curl -fsSL --max-time 20 https://api.github.com/repos/Arginine-Arg/Feishu_bridge_arg/actions/runs/30869317268',
      '```',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionSurface(text)).toBeUndefined();
    expect(liveInteractionCardForText(text, () => 'release-trace-token')).toBeUndefined();
  });

  it('does not promote command traces with a stale cursor row into a picker', () => {
    const text = [
      '• Ran node dist/cli.js --version',
      '  │ package version 0.6.68',
      '• GitHub 已接收提交，Release 工作流正在运行。',
      '• Ran curl -fsSL --max-time 20 https://api.github.com/repos/Arginine-Arg/Feishu_bridge_arg/actions/runs/30869317268',
      '› m',
      '• 远端 Release 尚未生成，继续等待检查结果。',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionSurface(text)).toBeUndefined();
    expect(liveInteractionCardForText(text, () => 'stale-cursor-token')).toBeUndefined();
  });

  it('keeps a real titled action menu even when a tool trace precedes it', () => {
    const text = [
      '• Ran pnpm build',
      'Select an action',
      '› 1. Continue',
      '2. Stop',
      'Press enter to confirm or esc to go back',
    ].join('\n');

    const card = liveInteractionCardForText(text, () => 'titled-menu-token');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', '2', 'enter', 'esc']);
  });

  it('does not treat repeated activity bullets and a footer hint as a generic menu', () => {
    const text = [
      '• Explored',
      '  └ Read src/agent/live-session.ts',
      '• Ran rg --files -g \'!node_modules\'',
      '  └ tests/unit/bot/live-interaction-card.test.ts',
      '• Worked for 2m 21s',
      '  esc to interrupt',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionCardForText(text, () => 'activity-footer-token')).toBeUndefined();
  });

  it('does not mistake verb-shaped choices for tool traces without command evidence', () => {
    const text = [
      'Which reference set should be opened?',
      '• Read docs',
      '• Read examples',
      'Press Enter to continue',
    ].join('\n');

    const card = liveInteractionCardForText(text, () => 'verb-choice-token');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['enter', 'down enter', 'esc']);
  });

  it('does not turn a normal Codex greeting and progress update into yes/no input', () => {
    const text = [
      '• Nihao! What would you like to work on?',
      '• 我是 Codex，一个可以帮你读代码、写代码、排查问题和处理项目文件的 AI 助手。',
      '• Model changed to gpt-5.6-sol high',
      '• 我是 Codex，基于 GPT-5。',
      '• 已经定位并修复。根因不是 SSH 或 TTY，而是 tmux 版本不匹配：',
      '```',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionSurface(text)).toBeUndefined();
    expect(liveInteractionCardForText(text, () => 'greeting-progress-token')).toBeUndefined();
  });

  it('does not truncate a command transcript by promoting its output rows to a picker', () => {
    const text = [
      '• Nihao! What would you like to work on?',
      '│  Context window:       98% left (16.6K used / 258K)                        │',
      '• 我是 Codex，一个可以帮你读代码、写代码、排查问题和处理项目文件的 AI 助手。',
      '• Model changed to gpt-5.6-sol high',
      '• 兼容客户端的配置已写入并通过新 shell 验证。',
      '• Ran find /tmp -maxdepth 1 -type s -name \'test-tmux*.sock\' -print',
      '  │ ps -eo pid,ppid,user,tty,stat,cmd | rg \'test-tmux\' || true',
      '• Ran git -C /workspace status --short; sed -n \'1,40p\' ~/.bash_aliases',
      '  └ fatal: not a git repository (or any of the parent directories): .git',
      '• Ran ps -o pid,ppid,user,tty,stat,cmd -p 3462868,740093',
      '1. process output row one',
      '2. process output row two',
      '3. process output row three',
      'Press enter to confirm or esc to cancel',
    ].join('\n');

    expect(isStructuredLiveInteraction(text)).toBe(false);
    expect(liveInteractionSurface(text)).toBeUndefined();
    expect(liveInteractionCardForText(text, () => 'command-transcript-token')).toBeUndefined();
  });

  it('scopes a partial model picker to its active numbered viewport', () => {
    const text = [
      '›     • Ran /usr/bin/tmux -S /tmp/tmux/default capture-pane -p -t codex:0.0 -S -30',
      '› c',
      '› co',
      '› con',
      '› cont',
      '› conti',
      '› contin',
      '› continue',
      'socket。临时复现进程正在清理',
      '› continue',
      '/fast          1.5x speed, increased usage',
      '  /permissions   choose what Codex is allowed to do',
      '› /m',
      '  /model     choose what model and reasoning effort to use',
      '› /mod',
      '1. gpt-5.6-sol (default)   Latest frontier agentic coding model.',
      '2. gpt-5.6-terra           Balanced agentic coding model for everyday work.',
      '› 3. gpt-5.6-luna (current)  Fast and affordable agentic coding model.',
      '4. gpt-5.5                 Frontier model for complex coding and research.',
      '5. gpt-5.2                 Optimized for professional work.',
    ].join('\n');

    expect(liveInteractionSurface(text)).toEqual([
      '1. gpt-5.6-sol (default)   Latest frontier agentic coding model.',
      '2. gpt-5.6-terra           Balanced agentic coding model for everyday work.',
      '› 3. gpt-5.6-luna (current)  Fast and affordable agentic coding model.',
      '4. gpt-5.5                 Frontier model for complex coding and research.',
      '5. gpt-5.2                 Optimized for professional work.',
    ].join('\n'));
    const card = liveInteractionCardForText(text, () => 'partial-model-token');
    expect(card).toBeDefined();
    expect(buttonValues(card).map((value) => value.input)).toEqual(['1', '2', '3', '4', '5', 'enter', 'esc']);
    const rendered = JSON.stringify(card);
    expect(rendered).not.toContain('› continue');
    expect(rendered).not.toContain('/permissions');
  });
});

function stateFrom(events: AgentEvent[]): RunState {
  return events.reduce((state, event) => reduce(state, event), initialState);
}
