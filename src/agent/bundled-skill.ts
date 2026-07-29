import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../core/logger';

const SKILL_NAME = 'arg-bridge-sendfile';

/**
 * Make the bridge artifact workflow discoverable to Codex without requiring a
 * user to manually copy a skill after every package upgrade. Failure is
 * non-fatal because the same capability remains available through the bridge
 * system prompt and CLI command.
 */
export async function ensureBundledCodexSkill(codexHome?: string): Promise<void> {
  const source = await bundledSkillSource();
  if (!source) return;
  const root = codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const target = join(root, 'skills', SKILL_NAME, 'SKILL.md');
  try {
    const sourceContent = await readFile(source, 'utf8');
    const current = await readFile(target, 'utf8').catch(() => undefined);
    if (current === sourceContent) return;
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    log.info('agent-skill', 'installed', { name: SKILL_NAME, target });
  } catch (err) {
    log.warn('agent-skill', 'install-failed', {
      name: SKILL_NAME,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function bundledSkillSource(): Promise<string | undefined> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(moduleDir, '..', '..', 'skills', SKILL_NAME, 'SKILL.md'),
    join(moduleDir, '..', 'skills', SKILL_NAME, 'SKILL.md'),
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Try the layout used by source files and then the layout used by dist.
    }
  }
  return undefined;
}
