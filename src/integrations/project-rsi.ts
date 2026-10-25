import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { spawnProcess } from '../platform/spawn';
import { redactSecrets } from '../agent/subagents/mcp-client';
import type { RsiConfig } from '../config/profile-schema';

const CONFIG_RELATIVE_PATH = join('.project-rsi', 'config.json');
const EVIDENCE_RELATIVE_PATH = join('.agent', 'rsi');
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

export interface ProjectRsiConfigDocument {
  version?: number;
  projectRoot?: string;
  runsDir?: string;
  ledgerPath?: string;
  validator?: {
    command?: string;
    args?: string[];
    path?: string;
  };
  runner?: {
    command?: string;
    args?: string[];
    path?: string;
  };
  [key: string]: unknown;
}

export interface ProjectRsiProject {
  root: string;
  configPath: string;
  config: ProjectRsiConfigDocument;
  evidenceDir: string;
}

export interface ProjectRsiRun {
  runId: string;
  dir: string;
  manifestPath: string;
  validatorPath: string;
  manifestMtimeMs: number;
  validatorMtimeMs?: number;
  validatorPassed: boolean;
  validatorExitCode?: number;
  validatorReason?: string;
  threadId?: string;
  turnId?: string;
  taskHash?: string;
}

export interface RsiTurnContext {
  turnStartedAt: number;
  threadId?: string;
  turnId?: string;
  taskHash?: string;
}

export interface ProjectRsiStatus {
  mode: RsiConfig['mode'];
  projectRoot: string | null;
  configPath: string | null;
  initialized: boolean;
  runner: 'available' | 'missing' | 'unknown';
  validator: 'available' | 'missing' | 'unknown';
  validatorPath?: string;
  reviewerRouteMode: RsiConfig['reviewerRouteMode'];
  reviewerRoute: string | null;
  bridgeGate: 'enforced-on-substantive-bridge-turns';
  nativeTerminalGate: 'requires-trusted-hook';
  historicalTaskRsi: 'not-imported';
  latestRun?: {
    runId: string;
    manifestPath: string;
    validatorPath: string;
    validated: boolean;
    updatedAt: number;
    reason?: string;
  };
  error?: string;
}

export interface RsiFreshnessResult {
  ok: boolean;
  reason: string;
  projectRoot?: string;
  runId?: string;
  runDir?: string;
  manifestPath?: string;
  validatorPath?: string;
}

/**
 * Find an explicitly initialized Project RSI project. Discovery walks upward
 * from cwd; an explicit root is honored only when it already contains a
 * config. This function never initializes a project or writes to one.
 */
export async function discoverProjectRsi(
  cwd: string,
  configuredRoot?: string | null,
): Promise<ProjectRsiProject | undefined> {
  if (configuredRoot) {
    const root = await canonicalSafeProjectRoot(configuredRoot);
    if (!root) return undefined;
    const configPath = join(root, CONFIG_RELATIVE_PATH);
    try {
      return await readProject(root, configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  let current = resolve(cwd);
  for (;;) {
    const configPath = join(current, CONFIG_RELATIVE_PATH);
    const exists = await stat(configPath).then(info => info.isFile()).catch(() => false);
    if (!exists) {
      const parent = dirname(current);
      if (parent === current) return undefined;
      current = parent;
      continue;
    }
    try {
      return await readProject(current, configPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export async function projectRsiStatus(
  config: RsiConfig,
  cwd: string,
): Promise<ProjectRsiStatus> {
  const base = {
    mode: config.mode,
    projectRoot: config.projectRoot,
    reviewerRouteMode: config.reviewerRouteMode,
    reviewerRoute: config.reviewerRoute,
    bridgeGate: 'enforced-on-substantive-bridge-turns' as const,
    nativeTerminalGate: 'requires-trusted-hook' as const,
    historicalTaskRsi: 'not-imported' as const,
  };
  if (config.mode === 'off') {
    return {
      ...base,
      configPath: null,
      initialized: false,
      runner: 'missing',
      validator: 'missing',
    };
  }
  let project: ProjectRsiProject | undefined;
  try {
    project = await discoverProjectRsi(cwd, config.projectRoot);
  } catch (error) {
    return {
      ...base,
      configPath: null,
      initialized: false,
      runner: 'unknown',
      validator: 'unknown',
      error: safeError(error),
    };
  }
  if (!project) {
    return {
      ...base,
      configPath: null,
      initialized: false,
      runner: 'missing',
      validator: 'missing',
    };
  }
  const validatorPath = resolveValidatorPath(project, config);
  const validatorState: ProjectRsiStatus['validator'] = !validatorPath
    ? 'missing'
    : !validatorPath.includes('/')
      ? 'unknown'
      : await isRegularFile(validatorPath)
        ? 'available'
        : 'missing';
  const runnerCommand = config.runnerCommand
    ?? project.config.runner?.command
    ?? project.config.runner?.path;
  const runnerState: ProjectRsiStatus['runner'] = !runnerCommand
    ? 'missing'
    : !runnerCommand.includes('/')
      ? 'unknown'
      : await isRegularFile(resolve(project.root, runnerCommand))
        ? 'available'
        : 'missing';
  const latest = await latestRsiRun(project);
  return {
    ...base,
    projectRoot: project.root,
    configPath: project.configPath,
    initialized: true,
    runner: runnerState,
    validator: validatorState,
    ...(validatorPath ? { validatorPath } : {}),
    ...(latest
      ? {
          latestRun: {
            runId: latest.runId,
            manifestPath: latest.manifestPath,
            validatorPath: latest.validatorPath,
            validated: latest.validatorPassed,
            updatedAt: latest.manifestMtimeMs,
            ...(latest.validatorReason ? { reason: latest.validatorReason } : {}),
          },
        }
      : {}),
  };
}

/**
 * Mechanical completion gate. A run is fresh only if its manifest belongs to
 * this project, its runId matches the directory, it was written after this turn
 * started, and the upstream validator receipt reports success.
 */
export async function verifyFreshRsiRun(
  project: ProjectRsiProject,
  context: number | RsiTurnContext,
): Promise<RsiFreshnessResult> {
  const turn = typeof context === 'number' ? { turnStartedAt: context } : context;
  const runs = await listRuns(project);
  const fresh = runs.filter(run =>
    run.manifestMtimeMs >= turn.turnStartedAt &&
    run.validatorPassed &&
    (run.validatorMtimeMs ?? 0) >= run.manifestMtimeMs &&
    runMatchesTurn(run, turn)
  );
  const valid = fresh.sort((a, b) => b.manifestMtimeMs - a.manifestMtimeMs)[0];
  if (!valid) {
    const newest = runs.sort((a, b) => b.manifestMtimeMs - a.manifestMtimeMs)[0];
    const suffix = newest
      ? `；最新 run ${newest.runId} 不满足 fresh+validator 条件`
      : '；未找到 Project RSI run';
    return {
      ok: false,
      projectRoot: project.root,
      reason: `本轮产生了持久修改，但没有 fresh validator receipt${suffix}`,
    };
  }
  return {
    ok: true,
    reason: `fresh validator receipt: ${valid.runId}`,
    projectRoot: project.root,
    runId: valid.runId,
    runDir: valid.dir,
    manifestPath: valid.manifestPath,
    validatorPath: valid.validatorPath,
  };
}

export async function latestRsiRun(
  project: ProjectRsiProject,
): Promise<ProjectRsiRun | undefined> {
  const runs = await listRuns(project);
  return runs.sort((a, b) => b.manifestMtimeMs - a.manifestMtimeMs)[0];
}

export async function writeRsiReviewEvidence(
  runDir: string,
  review: {
    route: string;
    provider: string;
    model: string;
    access: 'read-only';
    agentId: string;
    verdict: string;
    response: string;
    startedAt: number;
    completedAt: number;
  },
): Promise<string> {
  const safeResponse = redactSecrets(review.response);
  const body = {
    version: 1,
    route: review.route,
    provider: review.provider,
    model: review.model,
    access: review.access,
    agentId: review.agentId,
    verdict: redactSecrets(review.verdict).slice(0, 80),
    responseHash: createHash('sha256').update(safeResponse).digest('hex'),
    response: safeResponse.slice(0, 16_000),
    startedAt: review.startedAt,
    completedAt: review.completedAt,
  };
  const path = join(runDir, 'review.json');
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Run only the validator selected by the project itself. The implementation
 * is never copied into arg-bridge, so project-specific policy remains upstream.
 */
export async function runUpstreamValidator(
  project: ProjectRsiProject,
  run: ProjectRsiRun,
  config: RsiConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; reason: string; path: string }> {
  const command = config.validatorCommand
    ?? project.config.validator?.command
    ?? project.config.validator?.path
    ?? resolveValidatorPath(project, config);
  if (!command) {
    return { ok: false, reason: '未配置 Project RSI validator 入口', path: run.validatorPath };
  }
  if (signal?.aborted) throw abortError();
  const args = [
    ...(project.config.validator?.args ?? config.validatorArgs ?? []),
    '--run-dir',
    run.dir,
    '--json',
  ];
  const executable = upstreamExecutable(command, args);
  const child = spawnProcess(executable.command, executable.args, {
    cwd: project.root,
    env: {
      ...process.env,
      PROJECT_RSI_ROOT: project.root,
      PROJECT_RSI_RUN_ID: run.runId,
      PROJECT_RSI_RUN_DIR: run.dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
  child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
  const code = await waitForChild(child, signal, 120_000);
  const output = redactSecrets(Buffer.concat(stdout).toString('utf8')).slice(-16_000);
  const errorOutput = redactSecrets(Buffer.concat(stderr).toString('utf8')).slice(-4_000);
  return {
    ok: code === 0,
    reason: code === 0 ? 'validator exitCode=0' : (errorOutput || output || `validator exitCode=${code ?? 'signal'}`),
    path: run.validatorPath,
  };
}

/**
 * Start a fresh run through an explicitly configured upstream runner. The task
 * is passed in a 0600 request file, never in argv or an environment variable.
 * A development-only bridge wrapper is not a validator and never writes a
 * success receipt.
 */
export async function runUpstreamRsi(
  project: ProjectRsiProject,
  task: string,
  config: RsiConfig,
  context: Omit<RsiTurnContext, 'turnStartedAt'>,
  signal?: AbortSignal,
): Promise<{ attempted: boolean; ok: boolean; reason: string }> {
  const command = config.runnerCommand
    ?? project.config.runner?.command
    ?? project.config.runner?.path;
  if (!command) {
    return {
      attempted: false,
      ok: false,
      reason: '未配置上游 Project RSI runner；不会由 bridge 生成 manifest 或 receipt',
    };
  }
  if (signal?.aborted) throw abortError();
  const tempDir = await mkdtemp(join(tmpdir(), 'arg-bridge-rsi-run-'));
  const requestPath = join(tempDir, 'request.json');
  await writeFile(requestPath, `${JSON.stringify({
    version: 1,
    task: redactSecrets(task).slice(0, 16_000),
    ...(context.threadId ? { threadId: context.threadId } : {}),
    ...(context.turnId ? { turnId: context.turnId } : {}),
    ...(context.taskHash ? { taskHash: context.taskHash } : {}),
    cwd: project.root,
    requestedBy: 'arg-bridge',
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    const args = [
      ...(project.config.runner?.args ?? config.runnerArgs ?? []),
      'run',
      '--request-file',
      requestPath,
      '--json',
    ];
    const executable = upstreamExecutable(command, args);
    const child = spawnProcess(executable.command, executable.args, {
      cwd: project.root,
      env: {
        ...process.env,
        PROJECT_RSI_ROOT: project.root,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)));
    const code = await waitForChild(child, signal, 180_000);
    const output = redactSecrets(Buffer.concat(stdout).toString('utf8')).slice(-8_000);
    const errorOutput = redactSecrets(Buffer.concat(stderr).toString('utf8')).slice(-4_000);
    return {
      attempted: true,
      ok: code === 0,
      reason: code === 0 ? 'runner exitCode=0' : (errorOutput || output || `runner exitCode=${code ?? 'signal'}`),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function readProject(root: string, configPath: string): Promise<ProjectRsiProject> {
  const info = await stat(configPath);
  if (!info.isFile() || info.size > MAX_CONFIG_BYTES) {
    throw new Error(`Project RSI 配置无效或过大：${configPath}`);
  }
  const safeRoot = await canonicalSafeProjectRoot(root);
  if (!safeRoot) throw new Error(`不安全的 Project RSI 根目录：${root}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析 Project RSI 配置 ${configPath}: ${safeError(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Project RSI 配置必须是对象：${configPath}`);
  }
  const config = parsed as ProjectRsiConfigDocument;
  if (config.projectRoot) {
    const declared = resolve(safeRoot, config.projectRoot);
    const canonicalDeclared = await realpath(declared).catch(() => undefined);
    if (canonicalDeclared !== safeRoot) {
      throw new Error('Project RSI 配置中的 projectRoot 与发现目录不一致');
    }
  }
  const evidence = typeof config.runsDir === 'string' && config.runsDir.trim()
    ? resolve(safeRoot, config.runsDir)
    : join(safeRoot, EVIDENCE_RELATIVE_PATH, 'runs');
  if (!isWithin(safeRoot, evidence)) throw new Error('Project RSI runsDir 超出项目根目录');
  return {
    root: safeRoot,
    configPath,
    config,
    evidenceDir: evidence,
  };
}

async function canonicalSafeProjectRoot(input: string): Promise<string | undefined> {
  if (!input.trim()) return undefined;
  const candidate = resolve(input);
  if (!isAbsolute(candidate) || candidate === parse(candidate).root) return undefined;
  const canonical = await realpath(candidate).catch(() => undefined);
  if (!canonical) return undefined;
  const home = resolve(homedir());
  if (canonical === home || canonical === parse(canonical).root) return undefined;
  if (dirname(canonical) === parse(canonical).root) return undefined;
  const info = await lstat(canonical);
  return info.isDirectory() && !info.isSymbolicLink() ? canonical : undefined;
}

async function listRuns(project: ProjectRsiProject): Promise<ProjectRsiRun[]> {
  let entries;
  try {
    entries = await readdir(project.evidenceDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const runs: ProjectRsiRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(project.evidenceDir, entry.name);
    const manifestPath = join(dir, 'manifest.json');
    const info = await stat(manifestPath).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) continue;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) continue;
    const raw = manifest as Record<string, unknown>;
    const manifestRunId = typeof raw.runId === 'string' ? raw.runId.trim() : '';
    if (manifestRunId !== entry.name) continue;
    const declaredRoot = typeof raw.projectRoot === 'string'
      ? raw.projectRoot.trim()
      : typeof raw.project === 'object' && raw.project && !Array.isArray(raw.project)
        ? (raw.project as Record<string, unknown>).root
        : undefined;
    const canonicalDeclared = typeof declaredRoot === 'string' && declaredRoot.trim()
      ? await realpath(resolve(project.root, declaredRoot.trim())).catch(() => undefined)
      : undefined;
    if (canonicalDeclared !== project.root) {
      continue;
    }
    const rawManifest = await readFile(manifestPath, 'utf8');
    const manifestHash = createHash('sha256').update(rawManifest).digest('hex');
    const receipt = await readValidatorReceipt(dir, entry.name, manifestHash);
    const task = isRecordValue(raw.task);
    const turnContext = isRecordValue(raw.turn);
    const threadId = stringField(raw.threadId)
      ?? stringField(task?.threadId)
      ?? stringField(turnContext?.threadId);
    const turnId = stringField(raw.turnId)
      ?? stringField(task?.turnId)
      ?? stringField(turnContext?.turnId);
    const taskHash = stringField(raw.taskHash)
      ?? stringField(task?.hash)
      ?? stringField(turnContext?.taskHash);
    runs.push({
      runId: entry.name,
      dir,
      manifestPath,
      validatorPath: receipt.path,
      manifestMtimeMs: info.mtimeMs,
      ...(receipt.mtimeMs !== undefined ? { validatorMtimeMs: receipt.mtimeMs } : {}),
      validatorPassed: receipt.passed,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(taskHash ? { taskHash } : {}),
      ...(receipt.exitCode !== undefined ? { validatorExitCode: receipt.exitCode } : {}),
      ...(receipt.reason ? { validatorReason: receipt.reason } : {}),
    });
  }
  return runs;
}

async function readValidatorReceipt(
  runDir: string,
  runId: string,
  manifestHash: string,
): Promise<{
  path: string;
  passed: boolean;
  mtimeMs?: number;
  exitCode?: number;
  reason?: string;
}> {
  for (const name of ['validator.json', 'receipt.json']) {
    const path = join(runDir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) continue;
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { path, passed: false, mtimeMs: info.mtimeMs, reason: 'validator receipt 不是对象' };
      }
      const raw = parsed as Record<string, unknown>;
      const exitCode = typeof raw.exitCode === 'number' ? raw.exitCode : undefined;
      const receiptRunId = typeof raw.runId === 'string' ? raw.runId.trim() : undefined;
      const receiptHash = typeof raw.manifestSha256 === 'string'
        ? raw.manifestSha256.trim().toLowerCase()
        : typeof raw.sha256 === 'string'
          ? raw.sha256.trim().toLowerCase()
          : undefined;
      const identityMismatch = Boolean(
        (receiptRunId && receiptRunId !== runId) ||
        (receiptHash && receiptHash !== manifestHash),
      );
      const passed = !identityMismatch && (
        raw.passed === true ||
        raw.ok === true ||
        raw.valid === true ||
        exitCode === 0
      );
      return {
        path,
        passed,
        mtimeMs: info.mtimeMs,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...((identityMismatch
          ? 'validator receipt 的 runId/manifest hash 与当前 run 不一致'
          : typeof raw.reason === 'string'
            ? redactSecrets(raw.reason)
            : undefined)
          ? {
              reason: identityMismatch
                ? 'validator receipt 的 runId/manifest hash 与当前 run 不一致'
                : redactSecrets(String(raw.reason)),
            }
          : {}),
      };
    } catch (error) {
      return { path, passed: false, reason: safeError(error) };
    }
  }
  return { path: join(runDir, 'validator.json'), passed: false, reason: '缺少 validator receipt' };
}

function resolveValidatorPath(project: ProjectRsiProject, config: RsiConfig): string | undefined {
  const configured = config.validatorCommand
    ?? project.config.validator?.path
    ?? project.config.validator?.command;
  if (configured) {
    return configured.includes('/') ? resolve(project.root, configured) : configured;
  }
  const conventional = join(project.root, '.project-rsi', 'project_rsi.py');
  return conventional;
}

function runMatchesTurn(run: ProjectRsiRun, turn: RsiTurnContext): boolean {
  if (turn.threadId && run.threadId && run.threadId !== turn.threadId) return false;
  if (turn.turnId && run.turnId && run.turnId !== turn.turnId) return false;
  if (turn.taskHash && run.taskHash && run.taskHash !== turn.taskHash) return false;
  if (turn.threadId && !run.threadId && !run.taskHash) return false;
  if (turn.turnId && !run.turnId && !run.taskHash) return false;
  return true;
}

function isRecordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function upstreamExecutable(
  command: string,
  args: string[],
): { command: string; args: string[] } {
  if (/\.py$/iu.test(command)) {
    return {
      command: command === 'python' || command === 'python3' ? command : 'python3',
      args: [command, ...args],
    };
  }
  if (/\.m?js$/iu.test(command)) {
    return { command: process.execPath, args: [command, ...args] };
  }
  return { command, args };
}

async function isRegularFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined))?.isFile() ?? false;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function safeError(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

function abortError(): Error {
  const error = new Error('Project RSI 操作已取消');
  error.name = 'AbortError';
  return error;
}

function waitForChild(
  child: ReturnType<typeof spawnProcess>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<number | null> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolvePromise(value);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    };
    const abort = () => {
      child.kill('SIGTERM');
      fail(abortError());
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1_000).unref?.();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', fail);
    child.once('exit', code => finish(code));
  });
}
