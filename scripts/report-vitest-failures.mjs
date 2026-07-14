import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const reportPath = process.argv[2];

function escapeWorkflowCommand(value) {
  return String(value)
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

if (!reportPath || !existsSync(reportPath)) {
  console.log('::error title=Vitest report unavailable::Vitest did not produce a JSON report.');
  process.exitCode = 1;
} else {
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  let failures = 0;

  for (const testFile of report.testResults ?? []) {
    const file = relative(process.cwd(), testFile.name ?? reportPath) || reportPath;
    for (const assertion of testFile.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      failures += 1;
      const title = assertion.fullName ?? assertion.title ?? 'Vitest failure';
      const message = (assertion.failureMessages ?? []).join('\n').slice(0, 4_000) || 'Test failed.';
      console.log(
        `::error file=${escapeWorkflowCommand(file)},title=${escapeWorkflowCommand(title)}::${escapeWorkflowCommand(message)}`,
      );
    }
  }

  if (!report.success || failures > 0) {
    if (failures === 0) {
      console.log('::error title=Vitest failed::Vitest exited unsuccessfully without a failed assertion.');
    }
    process.exitCode = 1;
  }
}
