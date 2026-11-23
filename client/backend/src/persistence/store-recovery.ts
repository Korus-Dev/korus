import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { StoreRecovery } from '@workspace/core/contracts';
import { parseStoreFile, rosterSchemaVersion, storeSchemaVersion, type StoreFormatError } from './store-format';

const backupsDirectory = 'backups';
/** The files whose backups the daemon keeps; anything else a load refuses is reached through roster.json. */
const restorableFiles = ['roster.json', 'settings.json', 'tasks.json'];

/**
 * What a user can do about a home this build cannot open: the file at fault and the newest backup of it this build
 * can read. A backup holding the same bytes as the file is never offered: it is what just failed.
 */
export async function storeRecovery(home: string, error: StoreFormatError): Promise<StoreRecovery> {
  const file = error.file && restorableFiles.includes(error.file) ? error.file : 'roster.json';
  const current = await readFile(path.join(home, file), 'utf8').catch(() => null);
  const supported = file === 'roster.json' ? rosterSchemaVersion : storeSchemaVersion;
  const candidates = (await readdir(path.join(home, backupsDirectory)).catch(() => [] as string[]))
    .flatMap(name => {
      const createdAt = backupTime(file, name);
      return createdAt ? [{ name, createdAt }] : [];
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const candidate of candidates) {
    const text = await readFile(path.join(home, backupsDirectory, candidate.name), 'utf8').catch(() => null);
    if (text === null || text === current) continue;
    try { parseStoreFile(file, text, supported); } catch { continue; }
    return { file, reason: error.newer ? 'newer' : 'unreadable', message: error.message, backup: candidate };
  }
  return { file, reason: error.newer ? 'newer' : 'unreadable', message: error.message, backup: null };
}

/** Puts the offered backup in place of the file it was taken from. The file it replaces is not kept. */
export async function restoreStoreBackup(home: string, recovery: StoreRecovery, name: string): Promise<void> {
  if (!recovery.backup || recovery.backup.name !== name) throw new Error('Only the backup that was offered can be restored.');
  const text = await readFile(path.join(home, backupsDirectory, name), 'utf8');
  const target = path.join(home, recovery.file);
  const temporary = `${target}.${process.pid}.restore`;
  try {
    await writeFile(temporary, text, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** When a backup of `file` was taken, from the name the backups folder gives it; null for any other file. */
function backupTime(file: string, name: string): string | null {
  const base = path.basename(file, '.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^(?:provider-setup-)?${base}(?:-v\\d+)?-(\\d{4}-\\d{2}-\\d{2}T\\d{2})-(\\d{2})-(\\d{2}(?:\\.\\d+)?Z)\\.json$`).exec(name);
  return match ? `${match[1]}:${match[2]}:${match[3]}` : null;
}
