import { app, dialog, shell } from 'electron';
import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mainT } from './i18n';
import { logMain, warnMain } from './log';

const installerMarker = 'pending-installer-eject.json';
const markerPath = () => path.join(app.getPath('userData'), installerMarker);
type Installer = { volume: string; file: string; fileId: string };

function volumeRoot(file: string): string | undefined {
  return /^\/Volumes\/[^/]+/.exec(file)?.[0];
}

async function installerVolume(executable: string): Promise<string | undefined> {
  const direct = volumeRoot(executable);
  if (direct) return direct;
  // Gatekeeper can expose the app through a read-only nullfs mount. Use only the
  // backing path of this exact mount, and verify its disk image separately.
  const mountRoot = /^(.*\/AppTranslocation\/[^/]+)\/d\/[^/]+\.app\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1];
  if (!mountRoot) return undefined;
  const canonical = (file: string) => file.replace(/^\/var\//, '/private/var/');
  for (const line of (await run('/sbin/mount', ['-t', 'nullfs'])).split('\n')) {
    const match = /^(.+) on (.+) \(nullfs(?:,|\))/.exec(line);
    if (match && canonical(match[2]!) === canonical(mountRoot)) return volumeRoot(match[1]!);
  }
  return undefined;
}

function diskImageIdentity(file: string): string | undefined {
  if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.dmg') return undefined;
  const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  return stat?.isFile() ? `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` : undefined;
}

/** Save the backing file before relocation. Electron may eject the volume itself. */
async function rememberInstaller(executable: string): Promise<void> {
  try {
    const volume = await installerVolume(executable);
    if (!volume || !existsSync(volume)) return;
    const file = await diskImageFile(volume);
    const fileId = file && diskImageIdentity(file);
    if (!file || !fileId) return;
    const installer: Installer = { volume, file, fileId };
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(markerPath(), JSON.stringify(installer));
  } catch (error) {
    warnMain('install', 'could not remember the installer', { detail: String(error) });
  }
}

/** Claims startup while Electron installs/relaunches the packaged Mac app. */
export function installMacAppBeforeStartup(): boolean {
  if (process.platform !== 'darwin' || !app.isPackaged || app.isInApplicationsFolder()) return false;

  void app.whenReady().then(async () => {
    try {
      // Match Electron's destination using the actual bundle name, even if renamed.
      const applications = '/Applications';
      const executable = app.getPath('exe');
      const bundleName = path.basename(path.resolve(executable, '../../..'));
      const destination = path.join(applications, bundleName);
      let blockedPath = applications;
      try {
        accessSync(applications, constants.W_OK);
        blockedPath = destination;
        if (existsSync(destination)) accessSync(destination, constants.W_OK);
      } catch (error) {
        // Electron's privileged path deletes the old app before copying and
        // bypasses conflictHandler. Let Finder handle this case instead.
        warnMain('install', 'manual installation required', { path: blockedPath, detail: String(error) });
        const choice = dialog.showMessageBoxSync({
          type: 'info',
          title: mainT('install.title'),
          message: mainT('install.finderRequired'),
          detail: mainT('install.manual'),
          buttons: [mainT('install.openApplications'), mainT('install.cancel')],
          defaultId: 0,
          cancelId: 1,
        });
        if (choice === 0) {
          const openError = await shell.openPath(applications);
          if (openError) throw new Error(openError);
        }
        app.quit();
        return;
      }
      logMain('install', 'installing without elevated permissions', { destination });
      // The copy in Applications relaunches as a new process, so it carries the offer to eject.
      await rememberInstaller(executable);
      const moved = app.moveToApplicationsFolder({
        conflictHandler: (conflict) => {
          if (conflict === 'existsAndRunning') {
            rmSync(markerPath(), { force: true });
            return true;
          }
          return dialog.showMessageBoxSync({
            type: 'question',
            title: mainT('install.title'),
            message: mainT('install.replace'),
            detail: mainT('install.replaceDetail'),
            buttons: [mainT('install.replaceButton'), mainT('install.cancel')],
            defaultId: 1,
            cancelId: 1,
          }) === 0;
        },
      });
      // Electron owns successful relaunch (or focuses an already running copy).
      if (!moved) {
        rmSync(markerPath(), { force: true });
        app.quit();
      }
    } catch (error) {
      rmSync(markerPath(), { force: true });
      warnMain('install', 'installation failed', { detail: String(error) });
      dialog.showErrorBox(mainT('install.failed'), `${mainT('install.manual')}\n\n${String(error)}`);
      app.quit();
    }
  });
  return true;
}

function run(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, (error, stdout) => error ? reject(error) : resolve(String(stdout)));
    if (input !== undefined) child.stdin?.end(input);
  });
}

/** The .dmg file a mounted volume comes from. */
async function diskImageFile(volume: string): Promise<string | undefined> {
  const info = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', '-'], await run('hdiutil', ['info', '-plist']))) as {
    images?: { 'image-path'?: string; 'system-entities'?: { 'mount-point'?: string }[] }[];
  };
  return info.images?.find(image => image['system-entities']?.some(entity => entity['mount-point'] === volume))?.['image-path'];
}

/** After an install from a disk image, offers to eject that image and move its .dmg file to the Trash. */
export async function offerToTrashInstaller(): Promise<void> {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  let installer: Installer;
  try {
    installer = JSON.parse(readFileSync(markerPath(), 'utf8')) as Installer;
    rmSync(markerPath(), { force: true });
    if (typeof installer?.volume !== 'string' || volumeRoot(installer.volume) !== installer.volume
      || typeof installer.file !== 'string' || typeof installer.fileId !== 'string'
      || diskImageIdentity(installer.file) !== installer.fileId) return;
  } catch {
    return;
  }
  const { volume, file, fileId } = installer;
  await app.whenReady();
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: mainT('install.title'),
    message: mainT('install.done'),
    detail: mainT('install.trashDetail'),
    buttons: [mainT('install.trash'), mainT('install.keep')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    if (diskImageIdentity(file) !== fileId) return;
    if (existsSync(volume) && await diskImageFile(volume) === file) {
      try {
        await run('hdiutil', ['detach', volume]);
      } catch (error) {
        if (await diskImageFile(volume) === file) throw error;
      }
    }
    if (diskImageIdentity(file) === fileId) await shell.trashItem(file);
  } catch (error) {
    warnMain('install', 'could not remove the installer', { volume, detail: String(error) });
  }
}
