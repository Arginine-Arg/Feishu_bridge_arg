export type BridgePromptSource = 'im' | 'card' | 'comment';

export interface BridgePromptMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface BridgePromptContext {
  chatId: string;
  chatType: string;
  senderId: string;
  senderName?: string;
  /** Whether the sender is a human user or another bot ('app' sender). */
  senderType?: 'user' | 'bot';
  /** The bridge bot's own open_id — "this id is you" for self-identification. */
  botOpenId?: string;
  /** Accounts @-mentioned in the triggering message(s), deduped across the batch. */
  mentions?: BridgePromptMention[];
  threadId?: string;
  messageIds?: string[];
  source: BridgePromptSource;
}

export interface BridgePromptQuotedMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptInteractiveCard {
  messageId?: string;
  content: unknown;
}

/**
 * A prior message in the same Feishu topic, supplied as read-only context when
 * the bot is first pulled into a topic it hasn't been part of. Distinct from
 * `quotedMessages` (an explicit reply-quote): this is the topic's upstream
 * conversation the bot would otherwise be blind to.
 */
export interface BridgePromptTopicMessage {
  messageId: string;
  senderId: string;
  senderName?: string;
  senderType?: 'user' | 'bot';
  createdAt?: string;
  rawContentType: string;
  content: string;
}

export interface BridgePromptComment {
  commentScopeId: string;
  isWholeDocument: boolean;
  docsLink?: string;
  question: string;
  quote?: string;
}

export interface BridgePromptAttachment {
  path: string;
  kind: string;
  hash?: string;
  size?: number;
  mime?: string;
  sourceMessageId?: string;
  requiredness?: 'required' | 'optional';
  decision?: 'accepted' | 'rejected' | 'skipped';
  rejectionReason?: string;
}

export interface BuildAgentPromptInput {
  /**
   * Kept for source compatibility with older integrations. Conversation
   * routing metadata belongs to the bridge, not the agent's user turn.
   */
  context?: BridgePromptContext;
  /** @deprecated Bridge runtime instructions are no longer injected into user turns. */
  instructions?: string[];
  userInput: string;
  topicContext?: BridgePromptTopicMessage[];
  quotedMessages?: BridgePromptQuotedMessage[];
  interactiveCards?: BridgePromptInteractiveCard[];
  comment?: BridgePromptComment;
  attachments?: BridgePromptAttachment[];
}

export function buildAgentPrompt(input: BuildAgentPromptInput): string {
  // A bridged turn is a user turn, not a system-message transport. In
  // particular, do not make normal chat pay to re-send routing ids, bridge
  // operational rules, or a JSON/XML envelope that Codex will echo in tmux.
  // Supplemental material is included only when the user actually supplied
  // it, in a compact human-readable form that preserves the needed paths and
  // source content.
  const sections = [input.userInput];

  if (input.topicContext && input.topicContext.length > 0) {
    sections.push(
      [
        '此前话题内容：',
        ...input.topicContext.map((message, index) =>
          `--- ${index + 1} ---\n${message.content}`),
      ].join('\n'),
    );
  }
  if (input.quotedMessages && input.quotedMessages.length > 0) {
    sections.push(
      [
        '引用内容：',
        ...input.quotedMessages.map((message, index) =>
          `--- ${index + 1} ---\n${message.content}`),
      ].join('\n'),
    );
  }
  if (input.interactiveCards && input.interactiveCards.length > 0) {
    sections.push(
      [
        '交互卡片内容：',
        ...input.interactiveCards.map((card) => safeJsonStringify(card.content)),
      ].join('\n'),
    );
  }
  if (input.comment) {
    sections.push(
      [
        '文档评论：',
        input.comment.question,
        ...(input.comment.quote ? [`选中文本：${input.comment.quote}`] : []),
      ].join('\n'),
    );
  }
  if (input.attachments && input.attachments.length > 0) {
    sections.push(
      [
        '本地附件：',
        ...input.attachments.map((attachment) => formatAttachment(attachment)),
      ].join('\n'),
    );
  }

  return sections.filter(Boolean).join('\n\n');
}

function formatAttachment(attachment: BridgePromptAttachment): string {
  if (attachment.decision && attachment.decision !== 'accepted') {
    return `- ${attachment.kind}: 无法读取（${attachment.rejectionReason ?? attachment.decision}）`;
  }
  return `- ${attachment.kind}: ${attachment.path}${attachment.mime ? ` (${attachment.mime})` : ''}`;
}

export function promptSection(tag: string, value: unknown): string {
  return `<${tag}>\n${safeJsonStringify(value)}\n</${tag}>`;
}

export function safeJsonStringify(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
