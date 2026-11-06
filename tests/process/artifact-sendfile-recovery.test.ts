import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'tsup';
import { expect, it, vi } from 'vitest';
import { ArtifactBroker } from '../../src/bot/artifact-broker';
import { bindThreadArtifactDelivery } from '../../src/agent/artifact-context';

it('sends from a separate process with no inherited capability after broker restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ab-file-process-'));
  const workspace = join(root, 'workspace');
  const env: NodeJS.ProcessEnv = { ...process.env, CODEX_THREAD_ID: 'old-native-thread', ARG_BRIDGE_ARTIFACT_CONTEXT_DIR: join(root, 'contexts') };
  for (const key of ['ARG_BRIDGE_ARTIFACT_SCOPE', 'ARG_BRIDGE_ARTIFACT_STATE', 'ARG_BRIDGE_ARTIFACT_SOCKET', 'ARG_BRIDGE_ARTIFACT_TOKEN', 'TMUX', 'TMUX_PANE']) delete env[key];
  let broker: ArtifactBroker | undefined;
  try {
    await mkdir(workspace);
    await writeFile(join(workspace, 'START_PROMPT.md'), 'start');
    await build({ config: false, entry: { sendfile: fileURLToPath(new URL('../../src/cli/commands/agent-sendfile.ts', import.meta.url)) },
      outDir: join(root, 'cli'), format: ['esm'], platform: 'node', target: 'node20', silent: true,
      outExtension: () => ({ js: '.mjs' }),
      banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
      noExternal: ['graceful-fs'], dts: false });
    const send = vi.fn(async (_chatId: string, _content: unknown, _options: unknown) => ({ messageId: 'uploaded' }));
    const create = () => new ArtifactBroker(join(root, 'artifact-broker.sock'), { send } as never, async () => true, join(root, 'artifact-grants.json'));
    broker = create();
    await broker.start();
    const grant = broker.issue({ scope: 'chat-process', chatId: 'oc-process', replyTo: 'om-process', allowedRoots: [workspace], maxFileBytes: 4096, persistent: true });
    await broker.close();
    broker = create();
    await broker.start();
    await bindThreadArtifactDelivery('old-native-thread', grant, [workspace], env);
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const script = `import { runAgentSendFile } from ${JSON.stringify(pathToFileURL(join(root, 'cli', 'sendfile.mjs')).href)}; await runAgentSendFile('START_PROMPT.md');`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      const timer = setTimeout(() => { child.kill(); reject(new Error('sendfile process timed out')); }, 20_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    expect(result, result.stderr).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('已发送 START_PROMPT.md');
    expect(send).toHaveBeenCalledWith('oc-process', { file: { source: expect.stringContaining('START_PROMPT.md'), fileName: 'START_PROMPT.md' } }, { replyTo: 'om-process' });
    expect(send).toHaveBeenCalledOnce();
  } finally {
    await broker?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
