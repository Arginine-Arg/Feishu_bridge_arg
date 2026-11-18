import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { ProfileConfig } from '../../config/profile-schema';
import type { CodexSandboxMode } from '../../config/permissions';
import { DshStructuredSession } from '../../agent/dsh/session';
import { dshHome } from '../../agent/dsh/model-state';
import type { AgentEvent } from '../../agent/types';

export async function runDshNative(input: {
  profile: ProfileConfig;
  profileDir: string;
  cwd: string;
  sandbox: CodexSandboxMode;
  sessionId?: string;
}): Promise<void> {
  const config = input.profile.dsh ?? { binaryPath: 'dsh' };
  const models = new Map<string, string>();
  const session = new DshStructuredSession({
    config,
    cwd: input.cwd,
    home: dshHome(input.profileDir, config.home),
    env: process.env,
    network: input.profile.network,
    sandbox: input.sandbox,
    sessionId: input.sessionId,
    onSessionId: async id => { process.stdout.write(`DeepSeek Harness 会话 ${id}\n`); },
    loadModel: async id => models.get(id),
    saveModel: async (id, model) => { if (model) models.set(id, model); else models.delete(id); },
  });
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ui = createInterface({ input: process.stdin, output: process.stdout, prompt: 'dsh> ', terminal });
  let ended = false;
  let operation: Promise<void> | undefined;
  const emit = (event: AgentEvent) => {
    if (event.type === 'text') process.stdout.write(event.delta);
    if (event.type === 'interactive' && event.interaction) {
      const interaction = event.interaction;
      process.stdout.write(`\n${interaction.prompt}\n${interaction.choices.map(
        choice => `${choice.label}  /answer ${interaction.id} ${choice.value}`,
      ).join('\n')}\n`);
    }
  };
  const report = (error: unknown) => {
    if (!terminal) process.exitCode = 1;
    console.error(error instanceof Error ? error.message : String(error));
  };
  const cancel = () => {
    if (session.diagnostics().inputState === 'submitted') void session.interrupt();
    else ui.close();
  };
  ui.on('SIGINT', cancel);
  process.on('SIGINT', cancel);
  const end = new Promise<void>(resolve => ui.once('close', () => { ended = true; resolve(); }));
  const lines = ui[Symbol.asyncIterator]();
  if (terminal) ui.prompt();
  try {
    while (!ended) {
      const { value, done } = await lines.next();
      if (done) break;
      const text: string = value.trim();
      if (!text) { if (terminal && !operation) ui.prompt(); continue; }
      if (text === '/exit' || text === '/quit') { ui.close(); break; }
      if (text.startsWith('/')) {
        try {
          for (const event of await session.command(text)) emit(event);
          process.stdout.write('\n');
        } catch (error) { report(error); }
        if (terminal && !operation) ui.prompt();
        continue;
      }
      if (operation) { console.error('当前任务仍在运行，可用 /stop 停止。'); continue; }
      operation = session.submit({ runId: randomUUID(), prompt: text },
        emit, new AbortController().signal).catch(report).finally(() => {
        operation = undefined;
        process.stdout.write('\n');
        if (terminal && !ended) ui.prompt();
      });
      if (!terminal) await operation;
    }
  } finally {
    ui.close();
    await end;
    process.off('SIGINT', cancel);
    await session.close();
    await operation;
  }
}
