import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from '../../platform/atomic-write';

export function dshHome(profileDir: string, configured?: string): string {
  return configured ?? join(profileDir, 'dsh-home');
}

function modelFile(home: string, id: string): string {
  const name = createHash('sha256').update(id).digest('hex');
  return join(home, 'bridge-models', `${name}.json`);
}

export async function readDshSessionModel(home: string, id: string): Promise<string | undefined> {
  try {
    const model: unknown = JSON.parse(await readFile(modelFile(home, id), 'utf8'));
    return typeof model === 'string' ? model : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
  }
}

export async function saveDshSessionModel(home: string, id: string, model: string): Promise<void> {
  const file = modelFile(home, id);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify(model), { mode: 0o600 });
}
