import { createHash } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAppPaths } from '../../config/app-paths';
import { loadRootConfig } from '../../config/profile-store';
import { writeFileAtomic } from '../../platform/atomic-write';
import { subagentRouteFingerprint } from '../../agent/subagents/types';

const POC_MARKERS = [
  'ARG_BRIDGE_LOCAL_POC_MANAGED',
  'arg-bridge-local-poc',
  'LOCAL_ARGBRIDGE_POC',
];
const KNOWN_CLEAN_HASHES: Record<string, Record<string, string>> = {
  '1.6.7': {
    'dist/cli.js': '758d8792cd8aca6eecfd3cbcfa0a8f2939e402eaf234303b42c32c94a8044d16',
  },
};

export interface MigrateLocalPocOptions {
  profile?: string;
  dryRun?: boolean;
  apply?: boolean;
  json?: boolean;
  packageDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface LocalPocMigrationReport {
  version: 1;
  mode: 'dry-run' | 'apply';
  status: 'clean' | 'planned' | 'applied' | 'conflict';
  profile: string;
  package: {
    directory: string;
    version?: string;
    patchedFiles: Array<{
      path: string;
      sha256: string;
      managementMarker: boolean;
      originalBackup?: string;
      action: 'restore-backup' | 'report-conflict' | 'none';
    }>;
  };
  sideMap?: {
    path: string;
    backup?: string;
    action: 'upgrade' | 'unchanged' | 'conflict';
    reason?: string;
  };
  configBackup?: string;
  markerFile?: string;
  conflicts: string[];
  rollback: string[];
}

/**
 * Migrate only recognized local PoC artifacts. Unknown installed-package edits
 * are reported and preserved; arg-bridge never patches or removes dist blindly.
 */
export async function runMigrateLocalPoc(
  options: MigrateLocalPocOptions = {},
): Promise<void> {
  const report = await migrateLocalPoc(options);
  if (options.json || !process.stdout.isTTY) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatReport(report));
  }
  if (report.status === 'conflict') process.exitCode = 1;
}

export async function migrateLocalPoc(
  options: MigrateLocalPocOptions = {},
): Promise<LocalPocMigrationReport> {
  if (options.dryRun && options.apply) {
    throw new Error('--dry-run and --apply are mutually exclusive');
  }
  const apply = options.apply === true;
  const env = options.env ?? process.env;
  const rootPaths = resolveAppPaths({ rootDir: env.LARK_CHANNEL_HOME });
  const root = await loadRootConfig(rootPaths.configFile);
  const profileName = options.profile ?? root?.activeProfile ?? rootPaths.profile;
  const paths = resolveAppPaths({ rootDir: env.LARK_CHANNEL_HOME, profile: profileName });
  const packageDir = options.packageDir ?? await locatePackageDir();
  const packageVersion = await readPackageVersion(packageDir);
  const timestamp = archiveTimestamp(options.now ?? new Date());
  const report: LocalPocMigrationReport = {
    version: 1,
    mode: apply ? 'apply' : 'dry-run',
    status: 'clean',
    profile: profileName,
    package: {
      directory: packageDir,
      ...(packageVersion ? { version: packageVersion } : {}),
      patchedFiles: [],
    },
    conflicts: [],
    rollback: [],
  };

  for (const relative of ['dist/cli.js', 'dist/broker-side.js']) {
    const path = join(packageDir, relative);
    const body = await readFile(path, 'utf8').catch(() => undefined);
    if (body === undefined) continue;
    const marker = POC_MARKERS.some(item => body.includes(item));
    const sha256 = createHash('sha256').update(body).digest('hex');
    const expectedHash = packageVersion ? KNOWN_CLEAN_HASHES[packageVersion]?.[relative] : undefined;
    const unknownOneVersionSevenFile = packageVersion === '1.6.7' && !expectedHash;
    const unknownModifiedKnownVersion = Boolean(expectedHash && expectedHash !== sha256);
    if (!marker) {
      report.package.patchedFiles.push({
        path,
        sha256,
        managementMarker: false,
        action: 'none',
      });
      if (unknownOneVersionSevenFile || unknownModifiedKnownVersion) {
        report.conflicts.push(
          `${path} does not match the published 1.6.7 checksum and has no management marker; ` +
            'preserving unknown custom edits. Reinstall the published package instead.',
        );
        report.package.patchedFiles.at(-1)!.action = 'report-conflict';
      }
      continue;
    }
    const originalBackup = await findOriginalBackup(path);
    if (!originalBackup) {
      report.package.patchedFiles.push({
        path,
        sha256,
        managementMarker: true,
        action: 'report-conflict',
      });
      report.conflicts.push(
        `${path} carries the local PoC marker but has no recognized original backup; ` +
          'reinstall arg-bridge from the registry instead of editing dist',
      );
      continue;
    }
    report.package.patchedFiles.push({
      path,
      sha256,
      managementMarker: true,
      originalBackup,
      action: 'restore-backup',
    });
  }

  const sideMapPath = join(paths.profileDir, 'structured', 'subagent-sides.json');
  let sideMap = await migrateSideMap(sideMapPath, false, timestamp);
  if (sideMap) {
    report.sideMap = sideMap;
    if (sideMap.action === 'conflict') {
      report.conflicts.push(`side map 无法识别：${sideMap.reason ?? sideMap.path}`);
    }
  }

  const changes = report.package.patchedFiles.some(file => file.action === 'restore-backup') ||
    report.sideMap?.action === 'upgrade';
  if (apply && report.conflicts.length === 0 && changes) {
    const hasConfig = await lstat(rootPaths.configFile).then(info => info.isFile()).catch(() => false);
    if (hasConfig) {
      const backup = `${rootPaths.configFile}.local-poc-${timestamp}`;
      await copyFile(rootPaths.configFile, backup);
      report.configBackup = backup;
      report.rollback.push(`cp ${backup} ${rootPaths.configFile}`);
    }
    for (const file of report.package.patchedFiles) {
      if (file.action !== 'restore-backup' || !file.originalBackup) continue;
      const backup = `${file.path}.local-poc-${timestamp}`;
      await copyFile(file.path, backup);
      await copyFile(file.originalBackup, file.path);
      report.rollback.push(`cp ${backup} ${file.path}`);
    }
    if (sideMap?.action === 'upgrade') {
      sideMap = await migrateSideMap(sideMapPath, true, timestamp);
      report.sideMap = sideMap;
      if (sideMap?.backup) report.rollback.push(`cp ${sideMap.backup} ${sideMap.path}`);
    }
  }

  if (apply && report.conflicts.length === 0 && changes) {
    const markerFile = join(paths.profileDir, '.arg-bridge', 'migrations', 'local-poc-v1.json');
    await mkdir(dirname(markerFile), { recursive: true, mode: 0o700 });
    await writeFile(markerFile, `${JSON.stringify({
      version: 1,
      appliedAt: new Date().toISOString(),
      profile: profileName,
      report,
    }, null, 2)}\n`, { mode: 0o600 });
    report.markerFile = markerFile;
  }
  report.status = report.conflicts.length > 0
    ? 'conflict'
    : apply
      ? changes
        ? 'applied'
        : 'clean'
      : changes
        ? 'planned'
        : 'clean';
  return report;
}

async function migrateSideMap(
  path: string,
  apply: boolean,
  timestamp: string,
): Promise<NonNullable<LocalPocMigrationReport['sideMap']> | undefined> {
  const raw = await readFile(path, 'utf8').catch(() => undefined);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path, action: 'conflict', reason: 'JSON 损坏' };
  }
  const normalized = normalizeSideMap(parsed);
  if (!normalized.ok) return { path, action: 'conflict', reason: normalized.reason };
  if (normalized.unchanged) return { path, action: 'unchanged' };
  if (!apply) return { path, action: 'upgrade' };
  const backup = `${path}.local-poc-${timestamp}`;
  await copyFile(path, backup);
  await writeFileAtomic(path, `${JSON.stringify(normalized.value, null, 2)}\n`, { mode: 0o600 });
  return { path, action: 'upgrade', backup };
}

function normalizeSideMap(
  input: unknown,
): { ok: true; value: { version: 1; sides: Record<string, unknown> }; unchanged: boolean } |
  { ok: false; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'side map 必须是对象' };
  }
  const raw = input as Record<string, unknown>;
  const candidate = raw.version === 1 && raw.sides && typeof raw.sides === 'object'
    ? raw.sides
    : raw.sides && typeof raw.sides === 'object'
      ? raw.sides
      : raw;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'side map 缺少 sides' };
  }
  const sides: Record<string, unknown> = {};
  let changed = raw.version !== 1;
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: `side ${key} 不是对象` };
    }
    const side = value as Record<string, unknown>;
    const agent = side.agent && typeof side.agent === 'object'
      ? side.agent as Record<string, unknown>
      : undefined;
    const route = side.route && typeof side.route === 'object'
      ? side.route as Record<string, unknown>
      : undefined;
    if (
      typeof agent?.agentId !== 'string' ||
      typeof route?.id !== 'string' ||
      typeof route.provider !== 'string' ||
      typeof route.model !== 'string' ||
      typeof side.cwd !== 'string' ||
      typeof side.scope !== 'string'
    ) {
      return { ok: false, reason: `side ${key} 缺少已知字段` };
    }
    const routeFingerprint = typeof side.routeFingerprint === 'string'
      ? side.routeFingerprint
      : subagentRouteFingerprint({
          id: route.id,
          provider: route.provider,
          model: route.model,
          maxAccess: route.maxAccess === 'workspace-write' ? 'workspace-write' : 'read-only',
          available: route.available !== false,
          missingEnvironment: Array.isArray(route.missingEnvironment)
            ? route.missingEnvironment.filter((item): item is string => typeof item === 'string')
            : [],
          tags: Array.isArray(route.tags)
            ? route.tags.filter((item): item is string => typeof item === 'string')
            : [],
          ...(typeof route.backend === 'string' ? { backend: route.backend } : {}),
          ...(typeof route.description === 'string' ? { description: route.description } : {}),
          ...(typeof route.revision === 'string' ? { revision: route.revision } : {}),
          ...(typeof route.targetFingerprint === 'string'
            ? { targetFingerprint: route.targetFingerprint }
            : {}),
        });
    changed ||= routeFingerprint !== side.routeFingerprint;
    sides[key] = {
      ...side,
      routeFingerprint,
      updatedAt: typeof side.updatedAt === 'number' ? side.updatedAt : Date.now(),
    };
  }
  return {
    ok: true,
    value: { version: 1, sides },
    unchanged: !changed && raw.version === 1 && raw.sides === candidate,
  };
}

async function findOriginalBackup(path: string): Promise<string | undefined> {
  const names = await readdir(dirname(path)).catch(() => []);
  const stem = basename(path);
  const candidates = names
    .filter(name =>
      [
        `${stem}.orig`,
        `${stem}.original`,
        `${stem}.arg-bridge-original`,
        `${stem}.bak`,
      ].includes(name)
    )
    .map(name => join(dirname(path), name));
  return candidates.length === 1 ? candidates[0] : undefined;
}

async function locatePackageDir(): Promise<string> {
  let current = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const packageFile = await readFile(join(current, 'package.json'), 'utf8').catch(() => undefined);
    if (packageFile) {
      try {
        const parsed = JSON.parse(packageFile) as { name?: string };
        if (parsed.name === 'arg-bridge') return current;
      } catch {
        // Continue upward.
      }
    }
    const parent = dirname(current);
    if (parent === current) throw new Error('无法定位已安装的 arg-bridge package');
    current = parent;
  }
}

async function readPackageVersion(packageDir: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      typeof (parsed as { version?: unknown }).version === 'string'
      ? (parsed as { version: string }).version
      : undefined;
  } catch {
    return undefined;
  }
}

function archiveTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/u, 'Z');
}

function formatReport(report: LocalPocMigrationReport): string {
  const lines = [
    `arg-bridge local PoC migration (${report.mode})`,
    `profile: ${report.profile}`,
    `package: ${report.package.directory}`,
    `status: ${report.status}`,
  ];
  for (const file of report.package.patchedFiles) {
    if (file.managementMarker) {
      lines.push(`- ${file.path}: marker=${file.managementMarker} action=${file.action}`);
    }
  }
  if (report.sideMap) {
    lines.push(`- side map ${report.sideMap.path}: ${report.sideMap.action}`);
  }
  if (report.conflicts.length) {
    lines.push('conflicts:', ...report.conflicts.map(item => `- ${item}`));
  }
  if (report.rollback.length) {
    lines.push('rollback:', ...report.rollback.map(item => `- ${item}`));
  }
  if (report.markerFile) lines.push(`migration marker: ${report.markerFile}`);
  return `${lines.join('\n')}\n`;
}
