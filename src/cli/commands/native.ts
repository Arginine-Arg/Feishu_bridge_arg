import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { normalizeProfileConfig } from '../../config/profile-schema';
import { connectCodexHost } from '../../agent/structured/host';
import { codexRemotePermissionArgs, codexThreadPermissionOverrides } from '../../agent/structured/permissions';
import { spawnProcess } from '../../platform/spawn';
import { listStructuredTmuxPanes } from '../../agent/structured/tmux-discovery';
import { RpcClient } from '../../agent/structured/rpc';

/** Run as an ordinary foreground shell command. The caller's shell (and its
 * Clash/Conda environment) survives both normal exit and Ctrl-C. */
export async function runNative(thread: string | undefined, opts: { profile?: string }): Promise<void> {
  const rootPaths = resolveAppPaths();
  const root = JSON.parse(await readFile(rootPaths.configFile, 'utf8'));
  const profileName = opts.profile ?? root.activeProfile;
  const paths = resolveAppPaths({ profile: profileName });
  if (!root.profiles?.[profileName]) throw new Error(`Unknown profile: ${profileName}`);
  const config = normalizeProfileConfig(root.profiles[profileName]);
  const env = { ...process.env };
  const cwd = process.cwd();
  const sandbox = config.sandbox.defaultMode;
  if (config.agentKind === 'claude') {
    const child = spawnProcess('claude', [...(thread ? ['--resume', thread] : []), ...(config.preferences.model ? ['--model', config.preferences.model] : []), ...(sandbox === 'danger-full-access' ? ['--dangerously-skip-permissions'] : [])], { cwd, env, stdio: 'inherit' });
    await waitChild(child);
    return;
  }
  const binary = config.codex?.binaryPath ?? 'codex';
  if (config.codex?.codexHome) env.CODEX_HOME = config.codex.codexHome;
  if (!env.CODEX_HOME && config.codex?.inheritCodexHome === false) env.CODEX_HOME = `${paths.profileDir}/codex-home`;
  if (!thread) {
    // Older servers cannot resume a newly allocated thread before its first
    // turn is materialized. Let native TUI own this blank conversation; it
    // remains bindable through live, without injecting a synthetic prompt.
    console.log('New native conversation (live fallback); use native <thread-id> to share a saved conversation.');
    await waitChild(spawnProcess(binary, [...codexRemotePermissionArgs(sandbox)], { cwd, env, stdio: 'inherit' }));
    return;
  }
  const existing = thread ? listStructuredTmuxPanes().filter(pane => pane.structured.threadId === thread && pane.structured.endpoint) : [];
  const candidates = new Set(existing.map(pane => pane.structured.endpoint!));
  for (const file of [join(paths.profileDir, 'structured', 'tmux-bindings.json'), join(paths.profileDir, 'preferred-panes.json')]) {
    try {
      const stored = JSON.parse(await readFile(file, 'utf8'));
      for (const entry of Object.values(stored.bindings ?? stored.targets ?? {}) as Array<{ threadId?: string; endpoint?: string; structured?: { threadId: string; endpoint?: string } }>) {
        const identity = entry.structured ?? entry;
        if (identity.threadId === thread && identity.endpoint) candidates.add(identity.endpoint);
      }
    } catch { /* no prior binding */ }
  }
  const endpoints: string[] = [];
  for (const endpoint of candidates) {
    if (!endpoint.startsWith('unix:///')) continue;
    let observer: RpcClient | undefined;
    try {
      const stat = await lstat(endpoint.slice('unix://'.length));
      if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) continue;
      observer = await RpcClient.connect(`ws+unix://${endpoint.slice('unix://'.length)}:/`);
      await observer.initialize();
      const loaded = await observer.request('thread/loaded/list', {});
      if (loaded.data?.includes(thread)) endpoints.push(endpoint);
    } catch { /* stale endpoint; never retry a mutation here */ }
    finally { observer?.close(); }
  }
  if (endpoints.length > 1) throw new Error('Multiple endpoints own this thread; no new writer was started.');
  const host = endpoints[0]
    ? { endpoint: endpoints[0], rpc: await RpcClient.connect(`ws+unix://${endpoints[0].slice('unix://'.length)}:/`) }
    : await connectCodexHost({ binary, profileDir: paths.profileDir, scope: `native:${thread ?? process.env.TMUX_PANE ?? 'new'}`, cwd, env });
  try {
    if (endpoints[0]) await host.rpc.initialize();
    const result = await host.rpc.request('thread/resume', {
      threadId: thread, excludeTurns: true, cwd,
      ...codexThreadPermissionOverrides(sandbox),
    }, 180000);
    const id = result.thread?.id;
    if (typeof id !== 'string' || (thread && id !== thread)) throw new Error('Thread identity mismatch; TUI was not started.');
    console.log(`Shared Codex thread: ${id}`);
    const child = spawnProcess(binary, ['-c', 'check_for_update_on_startup=false', ...codexRemotePermissionArgs(sandbox), '--remote', host.endpoint, 'resume', id, '--no-alt-screen'], { cwd, env, stdio: 'inherit' });
    await waitChild(child);
  } finally { host.rpc.close(); }
}

async function waitChild(child: ReturnType<typeof spawnProcess>): Promise<void> {
  // Terminal signals reach the child as well. Keep this parent alive to wait
  // for cleanup, and return to the original interactive shell afterward.
  const handle = () => {};
  process.on('SIGINT', handle);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => { process.exitCode = code ?? 0; resolve(); });
    });
  } finally { process.off('SIGINT', handle); }
}
