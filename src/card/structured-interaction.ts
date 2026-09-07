import type { StructuredInteraction } from '../agent/structured/contracts';

export function structuredInteractionCard(interaction: StructuredInteraction, sign: (input: string) => string): object {
  return { schema: '2.0', config: { streaming_mode: false, summary: { content: '等待选择' } }, body: { elements: [
    { tag: 'markdown', content: interaction.prompt.slice(0, 10000) },
    ...interaction.choices.map((choice, index) => {
      const input = `/answer ${interaction.id} ${choice.value}`;
      return { tag: 'button', type: 'default', text: { tag: 'plain_text', content: `${index + 1}. ${choice.label}`.slice(0, 100) },
        behaviors: [{ type: 'callback', value: { cmd: 'live.input', input, __bridge_cb: true, bridge_token: sign(input) } }] };
    }),
  ] } };
}
