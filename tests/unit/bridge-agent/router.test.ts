import { describe, expect, it } from 'vitest';
import {
  BridgeAgent,
  BRIDGE_AGENT_SYSTEM_PROMPT,
  type BridgeAgentClassifier,
} from '../../../src/bridge-agent/index.js';

const VAE_INPUT =
  '只要 Q(z|molecule) 已经通过 ELBO 训练并冻结，且 TFE 的 mu/var 真正对齐到它，TFE 分支会间接受到先验约束。 然而，这里对TFE-I出来的embedding计算KL并放在swanlab上的意思是说如果对比学习真正发挥作用，那么即便没有KL散度的约束，因为分子图VAE是经过了约束的这个细胞embedding也会符合正态分布对吗，然而我们当前的训练却发现它并不符合也就是说图VAE没有发挥预想的功能，产生合理的latent';

describe('BridgeAgent', () => {
  it('forwards complex scientific input to tmux unchanged after LLM classification', async () => {
    const classifier: BridgeAgentClassifier = {
      async classify(input) {
        return {
          input_sha256: input.inputSha256,
          kind: 'task',
          presentation: 'card',
          answer: 'The VAE should use KL divergence.',
        };
      },
    };
    const route = await new BridgeAgent(classifier).route({ userInput: VAE_INPUT });

    expect(route.stdin).toBe(VAE_INPUT);
    expect(route.stdin).not.toContain('The VAE should use KL divergence.');
    expect(route.kind).toBe('task');
    expect(route.presentation).toBe('card');
  });

  it('rejects a classifier decision for a different input and keeps command stdin exact', async () => {
    const classifier: BridgeAgentClassifier = {
      async classify() {
        return {
          input_sha256: 'not-the-current-input',
          kind: 'task',
          presentation: 'markdown',
        };
      },
    };
    const route = await new BridgeAgent(classifier).route({
      userInput: '/model',
      inputMode: 'command',
    });

    expect(route.stdin).toBe('/model');
    expect(route.kind).toBe('native-command');
    expect(route.presentation).toBe('card');
    expect(route.inputMode).toBe('command');
  });

  it('defines an XML-scoped prompt that prohibits answering tasks', () => {
    expect(BRIDGE_AGENT_SYSTEM_PROMPT).toContain('<bridge_agent>');
    expect(BRIDGE_AGENT_SYSTEM_PROMPT).toContain('绝不能解答');
    expect(BRIDGE_AGENT_SYSTEM_PROMPT).toContain('修改 stdin 的权限');
  });

  it('classifies terminal output without rewriting it', () => {
    const agent = new BridgeAgent();

    expect(agent.classifyOutput('```ts\nconst value = 1;\n```')).toBe('code');
    expect(agent.classifyOutput('▸ Running pnpm test')).toBe('execution-log');
    expect(agent.classifyOutput('Select a model\n1. gpt-5')).toBe('picker');
    expect(
      agent.classifyOutput(
        'Would you like to run the following command?\n1. Yes, proceed\n2. Yes, and do not ask again\n3. No',
      ),
    ).toBe('picker');
    expect(
      agent.classifyOutput(
        '请回复是否采用这个选择？\n• Edited abstract.md (+2 -2)\n• 已按你的要求修改：最终摘要已完成。',
      ),
    ).not.toBe('picker');
    expect(agent.classifyOutput('Tests passed.')).toBe('final');
  });
});
