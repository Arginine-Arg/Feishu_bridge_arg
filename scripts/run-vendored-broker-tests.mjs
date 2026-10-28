#!/usr/bin/env node

import { spawn } from 'node:child_process';

const files = [
  'vendor/mixagents-broker/test/broker.test.mjs',
  'vendor/mixagents-broker/test/mcp.test.mjs',
  'vendor/mixagents-broker/test/release.test.mjs',
];
const child = spawn(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
const retain = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);
  output = `${output}${text}`.slice(-120_000);
};
child.stdout.on('data', retain);
child.stderr.on('data', retain);
const [code, signal] = await new Promise((resolve) => {
  child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
});
if (code !== 0 && process.env.GITHUB_ACTIONS === 'true') {
  const summary = output.trim() || `Broker tests exited with ${signal ?? code}`;
  const encoded = summary
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
  for (let offset = 0; offset < encoded.length; offset += 3_000) {
    process.stdout.write(
      `::error title=Vendored Broker test failure::${encoded.slice(offset, offset + 3_000)}\n`,
    );
  }
}
if (signal) {
  process.kill(process.pid, signal);
} else {
  process.exitCode = code ?? 1;
}
