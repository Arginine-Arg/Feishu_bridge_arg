import type { LarkChannel, SendOptions, StreamInput } from '@larksuite/channel';

/** Full-card snapshots with acknowledged delivery. The SDK stream controllers
 * resolve update() before the API call and can swallow a failed PATCH. */
export async function acknowledgedStream(
  channel: LarkChannel, chatId: string, input: StreamInput, options?: SendOptions,
): Promise<void> {
  let current: object = 'card' in input && input.card ? input.card.initial : markdownCard('🧠 正在思考…');
  let messageId = (await channel.send(chatId, { card: stationary(current) }, options)).messageId;
  if (!messageId) throw new Error('Streaming reply did not return a message ID');
  let pending = false;
  let timer: NodeJS.Timeout | undefined;
  let failure: unknown;
  let replacements = 0;
  let tail = Promise.resolve();
  let last = JSON.stringify(current);
  const flush = (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const operation = tail.then(async () => {
      if (failure) throw failure;
      if (!pending) return;
      pending = false;
      const snapshot = current;
      const serialized = JSON.stringify(snapshot);
      if (serialized === last) return;
      try {
        // Check the business code as well as HTTP errors. Some SDK methods
        // return a resolved response even when Feishu rejected the update.
        const response = await channel.rawClient.im.v1.message.patch({
          path: { message_id: messageId }, data: { content: JSON.stringify(stationary(snapshot)) },
        });
        if (response.code !== undefined && response.code !== 0) throw new Error(`Feishu PATCH rejected (${response.code})`);
      } catch (error) {
        // A withdrawn or expired card cannot be repaired in place. Start a
        // fresh, complete snapshot once; terminal failures reach the caller.
        if (replacements >= 1) throw error;
        const replacement = await channel.send(chatId, { card: stationary(snapshot) }, options);
        if (!replacement.messageId) throw error;
        messageId = replacement.messageId;
        replacements += 1;
      }
      last = serialized;
    });
    tail = operation.catch(error => { failure = error; });
    return operation;
  };
  const update = async (next: object): Promise<void> => {
    if (failure) throw failure;
    current = next;
    pending = true;
    if (!timer) timer = setTimeout(() => { void flush().catch(() => {}); }, 400);
  };
  try {
    if ('card' in input && input.card) {
      await input.card.producer({
        messageId,
        get current() { return current; },
        update: next => update(typeof next === 'function' ? next(current) : next),
      });
    } else if ('markdown' in input && input.markdown) {
      let text = '';
      await input.markdown({ messageId,
        append: async chunk => { text += chunk; await update(markdownCard(text)); },
        setContent: async content => { text = content; await update(markdownCard(text)); },
      });
    }
    await flush();
    if (failure) throw failure;
  } catch (error) {
    // Preserve the latest draft even when the producer itself fails, while
    // still rejecting so the caller can deliver the terminal fallback.
    await flush().catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    await tail;
  }
}

function stationary(card: object): object {
  const value = card as { config?: object };
  // Each update is a complete snapshot. No client-side typewriter buffer can
  // leave the visible card frozen at a prefix after an update failure.
  return { ...card, config: { ...value.config, streaming_mode: false } };
}

function markdownCard(content: string): object {
  return { schema: '2.0', config: { streaming_mode: false },
    body: { elements: [{ tag: 'markdown', content: content || '…' }] } };
}
