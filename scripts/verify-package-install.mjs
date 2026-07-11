#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(
  await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
);
const temporaryRoot = await mkdtemp(join(tmpdir(), 'arg-bridge-package-'));

try {
  const archive = process.argv[2]
    ? resolve(process.argv[2])
    : await createArchive(temporaryRoot);
  const prefix = join(temporaryRoot, 'prefix');
  const checksum = await createChecksum(archive, temporaryRoot);

  await createInstallConflicts(prefix, temporaryRoot, packageJson.name);

  execFileSync(
    'sh',
    [
      join(repositoryRoot, 'scripts', 'install-global.sh'),
      '--archive',
      archive,
      '--checksum',
      checksum,
      '--prefix',
      prefix,
    ],
    { cwd: repositoryRoot, stdio: 'inherit' },
  );

  const installedRoot = join(
    prefix,
    'lib',
    'node_modules',
    packageJson.name,
  );
  const installedPackageJson = JSON.parse(
    await readFile(join(installedRoot, 'package.json'), 'utf8'),
  );
  if (installedPackageJson.version !== packageJson.version) {
    throw new Error(
      `installed ${installedPackageJson.version}; expected ${packageJson.version}`,
    );
  }

  const installedRootStats = await lstat(installedRoot);
  if (installedRootStats.isSymbolicLink()) {
    throw new Error(`installed package must not be a temporary symlink: ${installedRoot}`);
  }

  const command = join(prefix, 'bin', 'arg-bridge');
  const commandTarget = await realpath(command);
  const expectedTarget = join(installedRoot, 'bin', 'arg-bridge.mjs');
  if (commandTarget !== expectedTarget) {
    throw new Error(`command points to ${commandTarget}; expected ${expectedTarget}`);
  }

  const reportedVersion = execFileSync(command, ['--version'], {
    encoding: 'utf8',
  }).trim();
  if (reportedVersion !== packageJson.version) {
    throw new Error(
      `command reported ${reportedVersion}; expected ${packageJson.version}`,
    );
  }

  process.stdout.write(
    `Verified arg-bridge ${reportedVersion} tarball install at ${installedRoot}\n`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createArchive(destination) {
  const output = execFileSync(
    'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', destination],
    { cwd: repositoryRoot, encoding: 'utf8' },
  );
  const result = JSON.parse(output);
  const filename = result[0]?.filename;
  if (!filename) {
    throw new Error('npm pack did not report an archive filename');
  }
  return join(destination, filename);
}

async function createChecksum(archive, destination) {
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  const checksum = join(destination, 'archive.sha256');
  await writeFile(checksum, `${digest}  archive.tgz\n`);
  return checksum;
}

async function createInstallConflicts(prefix, destination, packageName) {
  const globalRoot = join(prefix, 'lib', 'node_modules');
  const binRoot = join(prefix, 'bin');
  const missingTarget = join(destination, 'removed-git-clone');
  await mkdir(globalRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });
  await symlink(missingTarget, join(globalRoot, packageName));
  await writeFile(
    join(binRoot, 'arg-bridge'),
    '#!/bin/sh\nexec node "/tmp/legacy-arg-bridge/dist/cli.js" "$@"\n',
    { mode: 0o755 },
  );
  await symlink(missingTarget, join(binRoot, 'lark-channel-bridge'));
}
