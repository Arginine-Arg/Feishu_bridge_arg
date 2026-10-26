import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveAppPaths } from '../../config/app-paths';
import { normalizeProfileConfig } from '../../config/profile-schema';
import { connectCodexHost } from '../../agent/structured/host';
import {
  codexRemotePermissionArgs,
  codexRemoteResumeArgs,
  codexThreadPermissionOverrides,
  releaseCodexThreadWriter,
  resolveCodexPermissionSettings,
  resumeCodexThread,
  type CodexPermissionCliOptions,
} from '../../agent/structured/permissions';
import { spawnProcess } from '../../platform/spawn';
import { listStructuredTmuxPanes } from '../../agent/structured/tmux-discovery';
import { RpcClient } from '../../agent/structured/rpc';
import { sanitizeAgentEnv } from '../../platform/network-env';
import {
  applyCodexCredentialEnv,
  defaultCodexHome,
  resolveCodexCredentialEnv,
  type CodexCredentialResolution,
} from '../../agent/codex/credentials';
import {
  dropOwner,
  fileStamp,
  fingerprintCredentialEnv,
} from '../../agent/structured/host-registry';
import {
  resolveCodexActiveConfigIdentity,
  resolveCodexProvider,
} from '../../agent/codex/provider';
import { readCcSwitchCurrentProvider } from '../../integrations/cc-switch';
import {
  createNativeBridgeSession,
  findLoadedThreadHost,
} from '../../agent/structured/native-bridge';
import { resolveAppServerSocketPath } from '../../agent/structured/socket-security';

/** Run as an ordinary foreground shell command. The caller's shell (and its
 * Clash/Conda environment) survives both normal exit and Ctrl-C. */
export async function runNative(
  thread: string | undefined,
  opts: {
    profile?: string;
    bridge?: boolean;
    adopt?: string;
  } & CodexPermissionCliOptions,
): Promise<void> {
  const rootPaths = resolveAppPaths();
  const root = JSON.parse(await readFile(rootPaths.configFile, 'utf8'));
  const profileName = opts.profile ?? root.activeProfile;
  const paths = resolveAppPaths({ profile: profileName });
  if (!root.profiles?.[profileName]) throw new Error(`Unknown profile: ${profileName}`);
  const config = normalizeProfileConfig(root.profiles[profileName]);
  const cwd = process.cwd();
  const permissions = resolveCodexPermissionSettings(config.sandbox.defaultMode, opts);
  const sandbox = permissions.sandbox;
  if (thread && permissions.explicit) {
    console.error(
      'arg-bridge: resume 继承 thread 创建时的权限；已忽略本次 --yolo/--sandbox/--ask-for-approval 覆盖。',
    );
  }
  const binary = config.codex?.binaryPath ?? 'codex';
  const codexHome = config.codex?.codexHome
    ?? (config.codex?.inheritCodexHome === false ? `${paths.profileDir}/codex-home` : undefined);
  if (opts.bridge || opts.adopt) {
    if (config.agentKind !== 'codex') {
      throw new Error('arg-bridge native --bridge/--adopt 只支持 Codex profile');
    }
    if (thread && opts.adopt) {
      throw new Error('不能同时提供 positional thread 和 --adopt');
    }
    const bridge = await createNativeBridgeSession({
      profileName,
      profileDir: paths.profileDir,
      cwd,
      config,
      configFile: rootPaths.configFile,
      env: process.env,
      binary,
      ...(codexHome ? { codexHome } : {}),
      sandbox,
      approvalPolicy: permissions.approvalPolicy,
      ...(thread ? { threadId: thread } : {}),
      ...(opts.adopt ? { adoptThreadId: opts.adopt } : {}),
    });
    try {
      if (bridge.mode === 'adopted') {
        console.log(
          `Bridge-managed migration: ${bridge.oldThreadId} -> ${bridge.threadId}`,
        );
        console.log(
          'Codex 0.164 thread/resume does not accept dynamicTools; the old text history was copied into this new Bridge thread.',
        );
      } else {
        console.log(`Bridge-managed Codex thread: ${bridge.threadId}`);
      }
      const child = spawnProcess(binary, codexRemoteResumeArgs(
        bridge.endpoint,
        bridge.threadId,
      ), {
        cwd,
        env: bridge.env,
        stdio: 'inherit',
      });
      await waitChild(child);
    } finally {
      await bridge.close();
    }
    return;
  }
  if (config.agentKind === 'claude') {
    const claudeEnv = await sanitizeAgentEnv({ ...process.env }, config.network);
    const child = spawnProcess('claude', [...(thread ? ['--resume', thread] : []), ...(config.preferences.model ? ['--model', config.preferences.model] : []), ...(sandbox === 'danger-full-access' ? ['--dangerously-skip-permissions'] : [])], { cwd, env: claudeEnv, stdio: 'inherit' });
    await waitChild(child);
    return;
  }
  // A third-party provider must not be diverted through a local clash port, so
  // the provider decides the network policy before the environment is prepared.
  const activeHome = codexHome ?? defaultCodexHome();
  const [provider, activeIdentity, ccSwitch] = await Promise.all([
    resolveCodexProvider(activeHome),
    resolveCodexActiveConfigIdentity(activeHome),
    readCcSwitchCurrentProvider(process.env),
  ]);
  const thirdParty = !provider.official;
  const runtimeIdentity = activeIdentity
    ? {
        ...(ccSwitch.providerId ? { ccSwitchProviderId: ccSwitch.providerId } : {}),
        codexProviderId: activeIdentity.codexProviderId,
        ...(activeIdentity.model ? { model: activeIdentity.model } : {}),
        recordedAt: Date.now(),
      }
    : undefined;
  const env = await sanitizeAgentEnv({ ...process.env }, config.network, {
    thirdPartyProvider: thirdParty,
  });
  if (codexHome) env.CODEX_HOME = codexHome;
  // `arg-bridge native` starts the Codex App Server and TUI without a login
  // shell, so a `cc-switch`-style empty OPENAI_API_KEY would reach the CLI
  // even when config.toml declares a third-party provider token.
  const credential: CodexCredentialResolution = await resolveCodexCredentialEnv(env.CODEX_HOME, {
    baseEnv: env,
  });
  applyCodexCredentialEnv(credential, env);
  if (!thread) {
    // Older servers cannot resume a newly allocated thread before its first
    // turn is materialized. Let native TUI own this blank conversation; it
    // remains bindable through live, without injecting a synthetic prompt.
    console.log('New native conversation (live fallback); use native <thread-id> to share a saved conversation.');
    await waitChild(spawnProcess(
      binary,
      codexRemotePermissionArgs(sandbox, permissions.approvalPolicy),
      { cwd, env, stdio: 'inherit' },
    ));
    return;
  }
  const discoveredHost = await findLoadedThreadHost(paths.profileDir, thread, env);
  const existing = discoveredHost
    ? []
    : listStructuredTmuxPanes().filter(pane => pane.structured.threadId === thread && pane.structured.endpoint);
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
  const endpoints: string[] = discoveredHost ? [discoveredHost.endpoint] : [];
  for (const endpoint of candidates) {
    if (!endpoint.startsWith('unix:///')) continue;
    let observer: RpcClient | undefined;
    try {
      const socketPath = await resolveAppServerSocketPath(endpoint.slice('unix://'.length));
      observer = await RpcClient.connect(`ws+unix://${socketPath}:/`, {
        codexHome: env.CODEX_HOME,
      });
      await observer.initialize();
      const loaded = await observer.request('thread/loaded/list', {});
      if (loaded.data?.includes(thread)) endpoints.push(`unix://${socketPath}`);
    } catch { /* stale endpoint; never retry a mutation here */ }
    finally { observer?.close(); }
  }
  if (endpoints.length > 1) throw new Error('Multiple endpoints own this thread; no new writer was started.');
  const host = discoveredHost ?? (endpoints[0]
    ? {
        endpoint: endpoints[0],
        rpc: await RpcClient.connect(`ws+unix://${endpoints[0].slice('unix://'.length)}:/`, {
          codexHome: env.CODEX_HOME,
        }),
      }
    : await connectCodexHost({
        binary,
        profileDir: paths.profileDir,
        scope: `native:${thread ?? process.env.TMUX_PANE ?? 'new'}`,
        cwd,
        env,
        fingerprint: {
          credentials: fingerprintCredentialEnv(credential.env),
          networkMode: thirdParty ? 'inherit:third-party-direct' : config.network?.mode ?? 'inherit',
          configStamp: env.CODEX_HOME ? fileStamp(join(env.CODEX_HOME, 'config.toml')) : undefined,
          authStamp: env.CODEX_HOME ? fileStamp(join(env.CODEX_HOME, 'auth.json')) : undefined,
        },
        ...(runtimeIdentity ? { runtimeIdentity } : {}),
      }));
  const startedHost = !discoveredHost && !endpoints[0];
  try {
    if (!discoveredHost && endpoints[0]) await host.rpc.initialize();
    const result = await resumeCodexThread(
      host.rpc,
      { threadId: thread, excludeTurns: true, cwd },
      codexThreadPermissionOverrides(sandbox, permissions.approvalPolicy),
      180000,
      { preserveProviderModel: true },
    );
    const id = result.thread?.id;
    if (typeof id !== 'string' || (thread && id !== thread)) throw new Error('Thread identity mismatch; TUI was not started.');
    console.log(`Shared Codex thread: ${id}`);
    const child = spawnProcess(binary, codexRemoteResumeArgs(host.endpoint, id), { cwd, env, stdio: 'inherit' });
    await waitChild(child);
  } finally {
    await releaseCodexThreadWriter(host.rpc, thread);
    host.rpc.close();
    if (startedHost) await dropOwner(paths.profileDir);
  }
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
