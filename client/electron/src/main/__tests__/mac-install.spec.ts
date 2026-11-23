import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const volume = '/Volumes/Korus Installer';
const mount = '/private/var/folders/test/T/AppTranslocation/installer-id';
const executable = `${volume}/Korus.app/Contents/MacOS/Korus`;
const native = vi.hoisted(() => ({
  userData: '',
  executable: '',
  dmg: '',
  mounted: true,
  response: 0,
  execFile: vi.fn(),
  moveToApplicationsFolder: vi.fn(),
  trashItem: vi.fn(async () => undefined),
  showMessageBox: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    isPackaged: true, getPath: (name: string) => name === 'exe' ? native.executable : native.userData,
    isInApplicationsFolder: () => false, moveToApplicationsFolder: native.moveToApplicationsFolder,
    whenReady: async () => undefined, quit: vi.fn(),
  },
  dialog: { showMessageBox: native.showMessageBox },
  shell: { trashItem: native.trashItem },
}));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const overrides = {
    accessSync: vi.fn(),
    existsSync: (file: string) => file === volume ? native.mounted : original.existsSync(file),
  };
  return { ...original, ...overrides, default: { ...original, ...overrides } };
});
/** hdiutil lists the mounted images as a plist and plutil turns it into JSON; detach just succeeds. */
native.execFile.mockImplementation((command: string, args: string[], callback: (error: Error | null, stdout?: string) => void) => {
  const stdout = command === 'hdiutil' && args[0] === 'info' ? 'PLIST'
    : command === 'plutil' ? JSON.stringify({ images: native.mounted ? [{ 'image-path': native.dmg, 'system-entities': [{ 'mount-point': volume }] }] : [] })
    : command === '/sbin/mount' ? `/Volumes/Other/Korus.app on ${mount}-other (nullfs, local)\n${volume}/Korus.app on ${mount} (nullfs, local, read-only)`
    : '';
  queueMicrotask(() => callback(null, stdout));
  return { stdin: { end: vi.fn() } };
});
vi.mock('node:child_process', () => ({ execFile: native.execFile, default: { execFile: native.execFile } }));
vi.mock('../log', () => ({ logMain: vi.fn(), warnMain: vi.fn() }));

import { installMacAppBeforeStartup, offerToTrashInstaller } from '../mac-install';

describe('offering to eject the installer', () => {
  let marker: string;
  const installFrom = async (exe = executable) => {
    native.executable = exe;
    expect(installMacAppBeforeStartup()).toBe(true);
    await vi.waitFor(() => expect(native.moveToApplicationsFolder).toHaveBeenCalledOnce());
  };

  beforeEach(async () => {
    vi.stubGlobal('process', Object.create(process, { platform: { value: 'darwin' } }));
    native.userData = await mkdtemp(path.join(os.tmpdir(), 'mac-install-'));
    native.dmg = path.join(native.userData, 'Korus.dmg');
    await writeFile(native.dmg, 'installer');
    native.mounted = true;
    marker = path.join(native.userData, 'pending-installer-eject.json');
    native.moveToApplicationsFolder.mockReturnValue(true);
    native.showMessageBox.mockImplementation(async () => ({ response: native.response }));
    native.response = 0;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    await rm(native.userData, { recursive: true, force: true });
  });

  it('offers to eject and trash the original installer after launching the app through Gatekeeper translocation', async () => {
    await installFrom(`${mount.replace('/private/var/', '/var/')}/d/Korus.app/Contents/MacOS/Korus`);

    await offerToTrashInstaller();

    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(native.execFile).toHaveBeenCalledWith('hdiutil', ['detach', volume], expect.any(Function));
    expect(native.trashItem).toHaveBeenCalledExactlyOnceWith(native.dmg);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('offers to trash the disk image after macOS has already ejected it', async () => {
    await installFrom();
    native.mounted = false;
    native.execFile.mockClear();

    await offerToTrashInstaller();

    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(native.execFile).not.toHaveBeenCalledWith('hdiutil', ['detach', volume], expect.any(Function));
    expect(native.trashItem).toHaveBeenCalledExactlyOnceWith(native.dmg);
  });

  it('keeps the disk image mounted when the user declines, and asks only once', async () => {
    await installFrom();
    native.execFile.mockClear();
    native.response = 1;

    await offerToTrashInstaller();
    await offerToTrashInstaller();

    expect(native.showMessageBox).toHaveBeenCalledOnce();
    expect(native.execFile).not.toHaveBeenCalled();
    expect(native.trashItem).not.toHaveBeenCalled();
  });

  it('does not offer cleanup after installing from Downloads', async () => {
    await installFrom('/Users/test/Downloads/Korus.app/Contents/MacOS/Korus');

    await offerToTrashInstaller();

    expect(native.showMessageBox).not.toHaveBeenCalled();
    expect(native.execFile).not.toHaveBeenCalled();
  });

  it('keeps a different file that replaced the installer while the prompt was open', async () => {
    await installFrom();
    native.showMessageBox.mockImplementationOnce(async () => {
      await rename(native.dmg, `${native.dmg}.original`);
      await writeFile(native.dmg, 'different file');
      return { response: 0 };
    });

    await offerToTrashInstaller();

    expect(native.execFile).not.toHaveBeenCalledWith('hdiutil', ['detach', volume], expect.any(Function));
    expect(native.trashItem).not.toHaveBeenCalled();
  });
});
