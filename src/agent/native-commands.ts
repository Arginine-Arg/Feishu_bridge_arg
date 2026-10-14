/**
 * Native agent commands that change the **main** conversation's state.
 *
 * A `/btw` side conversation is ephemeral: the server rejects goals there and
 * its model is not the one the user configures from Feishu. Keeping the list
 * in one place lets the structured backend and the live terminal relay agree
 * on which commands must never be delivered to (or typed into) a side thread.
 */
export function isMainScopedNativeCommand(prompt: string): boolean {
  // `/status`, `/skills` and friends follow the conversation the user is in,
  // so they stay side-scoped while a side is open. Only state-changing,
  // main-thread-only commands are listed here.
  return /^\/(?:goal|model|stop|compact)(?:\s|$)/iu.test(prompt.trim());
}
