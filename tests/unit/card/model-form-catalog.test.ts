import { describe, expect, it } from 'vitest';
import { modelFormCard } from '../../../src/card/config-card';

function selectOptions(card: any): Array<{ value: string; text: { content: string } }> {
  const form = card.body.elements.find((element: any) => element.tag === 'form');
  const select = form.elements.find((element: any) => element.name === 'model');
  return select.options;
}

describe('model form catalog', () => {
  it('renders dynamic cc-switch, Magpie and router options', () => {
    const card = modelFormCard({
      agentKind: 'codex',
      model: 'group/best-gpt',
      options: [
        { value: 'default', label: '跟随默认（不指定）' },
        { value: 'cc-model', label: '[cc-switch] CC A · cc-model' },
        { value: 'relay-a/gpt-6', label: '[Magpie] Relay A · gpt-6' },
        { value: 'group/best-gpt', label: '[Magpie 路由] 路由组 · best-gpt' },
      ],
      notice: 'Magpie 模型目录不可读：timeout',
    }) as any;
    const options = selectOptions(card);
    expect(options.map(option => option.value)).toEqual([
      'default',
      'cc-model',
      'relay-a/gpt-6',
      'group/best-gpt',
    ]);
    expect(options[3]!.text.content).toContain('Magpie 路由');
    const markdown = card.body.elements.find((element: any) => element.tag === 'markdown');
    expect(markdown.content).toContain('Magpie 路由组');
    expect(markdown.content).toContain('timeout');
  });

  it('keeps an unknown stored value selectable', () => {
    const card = modelFormCard({
      agentKind: 'codex',
      model: 'legacy/model',
      options: [{ value: 'default', label: '跟随默认（不指定）' }],
    }) as any;
    expect(selectOptions(card)[0]).toMatchObject({ value: 'legacy/model' });
  });
});
