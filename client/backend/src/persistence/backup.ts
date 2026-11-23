import { createHash } from 'node:crypto';
import { copyFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/**
 * Copies `source` into `directory` and proves the copy is byte-identical. Any failure
 * throws, so callers can abort before touching anything else.
 */
export async function backupFile(source: string, directory: string, label: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  const target = path.join(directory, `${label}-${stamp}${path.extname(source)}`);
  await copyFile(source, target);
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  const [original, copy] = await Promise.all([readFile(source), readFile(target)]);
  if (original.length !== copy.length || sha256(original) !== sha256(copy)) {
    throw new Error(`Backup verification failed for ${source}; ${target} does not match the original.`);
  }
  return target;
}

/** Writes `content` into `directory` as a backup and proves the file holds exactly those bytes. */
export async function backupContent(content: string, directory: string, label: string, extension = '.json'): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:]/g, '-');
  const target = path.join(directory, `${label}-${stamp}${extension}`);
  await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
  const handle = await open(target, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if ((await readFile(target, 'utf8')) !== content) throw new Error(`Backup verification failed: ${target} does not hold what was written.`);
  return target;
}
