import { RepositoryStore } from '../repository-store';
import type { TelemetryConsentState } from '@workspace/core/telemetry-consent';
import { createHash } from 'node:crypto';
import type { DelegatedTask } from '@workspace/core/delegated-task';
import { tasksSchema } from './task-schema';
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppSnapshot, Automation } from '@workspace/core/contracts';
import { projectClientSnapshot } from '@workspace/core/client-preferences';
import { createEmptySnapshot } from '@workspace/core/snapshot-construction';
import { product } from '@workspace/core/product';
import { dropFinishedRunProposals } from '@workspace/core/mission-execution';
import type { Mission } from '@workspace/core/missions';
import { persistedStateFromSnapshot, readPersistedMission, snapshotFromPersistedState } from '../state-persistence';
import { backupContent, backupFile } from './backup';
import { UnchangedWrites } from './unchanged-writes';
import { isSupportedRosterAgent, joinMissionDocuments, joinPersistedState, preserveUnsupportedAgents, splitMissionDocuments, splitPersistedState, type RosterData, type StoreFiles, type StoredMission, type StoredRosterAgent, type VisualizationData } from './layout';
import { migrateData, renameProviderFields, rosterMigrations, storeMigrations } from './migrations';
import { automationLogSchema, designSchema, missionDocumentsSchema, parseData, rosterSchema, settingsSchema, visualizationSchema } from './schema';
import { StoreFormatError, parseStoreFile, serializeStoreFile, storeSchemaVersion, rosterSchemaVersion } from './store-format';

const rosterFile = 'roster.json';
const settingsFile = 'settings.json';
const visualizationsDirectory = 'visualizations';
/**
 * Mission documents, one file per version, named by the digest of its bytes. A file is never rewritten: a save writes
 * the new versions, then commits roster.json, which names them, and only then removes the versions it no longer
 * names. A failed save therefore always leaves the roster and the documents it names together. The folder belongs to
 * the daemon, unlike `missions/<id>`, where Mission agents work.
 */
const missionDocumentsDirectory = 'mission-documents';
/** One file per design, named by its id. roster.json names the designs of each agent; a design it no longer names is deleted. */
const designsDirectory = 'designs';
/** The run log of each automation that has one, named by its id; the automation itself stays in roster.json. */
const automationLogsDirectory = 'automations';
const incompleteSuffix = '-incomplete';
const backupsDirectory = 'backups';
const legacyFile = 'state.json';
const desktopRosterSchemaFloor = 6; // First written by 0.57.0.

/** Left in place of the legacy file: it is not JSON, so builds that predate the store refuse to start. */
const retiredMarker = '# agent-workspace: this file was replaced by roster.json, settings.json and visualizations/.\n# It is not JSON on purpose, so an older build fails to start instead of creating an empty state.\n';

const fileMigrations = {
  roster: rosterMigrations,
  settings: storeMigrations,
  visualization: storeMigrations,
  tasks: storeMigrations,
};

function desktopUpgradeError(file: string): StoreFormatError {
  return new StoreFormatError(`${file} predates the desktop upgrade floor (${product.name} 0.57.0). Open the home once with ${product.name} 0.59.0 to migrate it before upgrading.`);
}

export type AppStateStoreOptions = {
  log?: (message: string) => void;
};

export class AppStateStore {
  private telemetrySettings: unknown;

  getTelemetrySettings(): TelemetryConsentState | undefined {
    if (this.telemetrySettings === undefined) return undefined;
    const state = this.telemetrySettings as TelemetryConsentState;
    if (!state || typeof state !== 'object' || Array.isArray(state)
      || typeof state.installId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(state.installId)
      || (state.enabled !== undefined && typeof state.enabled !== 'boolean')
      || (state.enabledAt !== undefined && (!Number.isSafeInteger(state.enabledAt) || state.enabledAt < 0))) {
      throw new Error('Telemetry settings are unavailable.');
    }
    return { installId: state.installId, ...(state.enabled !== undefined ? { enabled: state.enabled } : {}), ...(state.enabledAt !== undefined ? {enabledAt:state.enabledAt} : {}) };
  }

  saveTelemetrySettings(snapshot: AppSnapshot, state: TelemetryConsentState): Promise<void> {
    this.telemetrySettings = { ...state };
    return this.save(snapshot);
  }

  private taskWrites: Promise<void> = Promise.resolve();
  private readonly files = new UnchangedWrites();

  async loadTasks(): Promise<DelegatedTask[]> {
    const content = await readIfExists(this.absolute('tasks.json'));
    if (content === null) return [];
    this.files.remember(this.absolute('tasks.json'), content);
    const envelope = parseStoreFile('tasks.json', content);
    if (envelope.schemaVersion < storeSchemaVersion) await backupFile(this.absolute('tasks.json'), this.absolute(backupsDirectory), `tasks-v${envelope.schemaVersion}`);
    return parseData('tasks.json', tasksSchema, migrateData('tasks.json', envelope.data, envelope.schemaVersion, storeSchemaVersion, fileMigrations.tasks)).tasks;
  }

  saveTasks(tasks: DelegatedTask[]): Promise<void> {
    // Capture and validate now; tasks have a separate lifetime from roster snapshots.
    const content = serializeStoreFile(parseData('tasks.json', tasksSchema, { tasks }));
    const operation = this.taskWrites.then(() => this.files.writeIfChanged(this.absolute('tasks.json'), content, writeFileAtomically).then(() => undefined));
    this.taskWrites = operation.catch(() => undefined);
    return operation;
  }
  private pending: { files: Map<string, string>; icons: Record<string, string> } | null = null;
  private writtenIcons: Record<string, string> = {};
  private get repositories() { return new RepositoryStore(this.absolute('repositories.json')); }
  private waiters: Array<{ resolve(): void; reject(error: unknown): void }> = [];
  private writeInFlight = false;
  /** Relative path to the content last known to be on disk. */
  private written = new Map<string, string>();
  private unsupportedRoster: RosterData | null = null;

  constructor(private readonly home: string, private readonly options: AppStateStoreOptions = {}) {}

  async load({ allowLegacyStartup = true } = {}): Promise<AppSnapshot> {
    const legacy = await readIfExists(this.absolute(legacyFile));
    if (legacy !== null && !legacy.startsWith('#')) {
      if (!allowLegacyStartup) throw desktopUpgradeError(legacyFile);
      return this.migrateLegacy(legacy);
    }
    const roster = await readIfExists(this.absolute(rosterFile));
    if (roster === null) {
      if (legacy !== null) throw new StoreFormatError(`${legacyFile} was retired but ${rosterFile} is missing. Restore ${rosterFile} or a state backup from the ${backupsDirectory} folder.`);
      if (await readIfExists(this.absolute(settingsFile)) !== null) throw new StoreFormatError(`${settingsFile} exists without ${rosterFile}. Restore ${rosterFile} from the ${backupsDirectory} folder.`);
      return createEmptySnapshot();
    }
    return this.readLayout(roster, allowLegacyStartup);
  }

  save(snapshot: AppSnapshot): Promise<void> {
    const desired = this.serialize(snapshot);
    const effective = projectClientSnapshot(snapshot, 'desktop');
    if (!this.writeInFlight && this.pending === null && sameFiles(desired, this.written) && JSON.stringify(effective.general.repositoryIcons) === JSON.stringify(this.writtenIcons)) return Promise.resolve();
    this.pending = { files: desired, icons: { ...effective.general.repositoryIcons } };
    const operation = new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
    void this.flush();
    return operation;
  }

  /**
   * Verified recovery copies before an explicit destructive provider reset. The roster copy holds its Missions'
   * documents inline, so it restores on its own after later saves have removed the versions it would name.
   */
  async backupProviderSetup(snapshot: AppSnapshot): Promise<void> {
    await this.save(snapshot);
    const { roster } = this.persistedFiles(snapshot);
    await backupContent(serializeStoreFile(this.withUnsupportedAgents(roster), rosterSchemaVersion), this.absolute(backupsDirectory), 'provider-setup-roster');
    await backupFile(this.absolute(settingsFile), this.absolute(backupsDirectory), 'provider-setup-settings');
  }

  private async migrateLegacy(text: string): Promise<AppSnapshot> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new StoreFormatError(`${legacyFile} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Restore it from a backup before starting.`);
    }
    const snapshot = snapshotFromPersistedState(renameProviderFields(parsed));
    // Nothing else is touched unless a verified copy of the original exists.
    const backup = await backupFile(this.absolute(legacyFile), this.absolute(backupsDirectory), 'state-v0');
    await this.archiveExistingLayout();
    for (const name of [rosterFile, settingsFile]) this.files.forget(this.absolute(name));
    this.written = new Map();
    await this.apply(this.serialize(snapshot), snapshot.general.repositoryIcons);
    const migrated = await this.readLayout(await readFile(this.absolute(rosterFile), 'utf8'));
    await writeFileAtomically(this.absolute(legacyFile), retiredMarker);
    this.options.log?.(`Migrated ${legacyFile} to ${rosterFile}, ${settingsFile} and ${visualizationsDirectory}/. Backup: ${backup}`);
    return migrated;
  }

  /** A restored legacy file replaces the layout, so keep whatever was there. */
  private async archiveExistingLayout(): Promise<void> {
    const existing: string[] = [];
    for (const name of [rosterFile, settingsFile, visualizationsDirectory, missionDocumentsDirectory, designsDirectory, automationLogsDirectory]) {
      if (await stat(this.absolute(name)).then(() => true, ignoreMissing(false))) existing.push(name);
    }
    // An archive is staged under an incomplete name and only named once it holds the whole layout. An interrupted
    // archive is resumed in the same folder, so the roster and the documents it names are never split apart.
    const backups = this.absolute(backupsDirectory);
    const staged = (await readdir(backups).catch(ignoreMissing([] as string[]))).find(name => name.startsWith('layout-before-migration-') && name.endsWith(incompleteSuffix));
    if (existing.length === 0 && !staged) return;
    const directory = path.join(backups, staged ?? `layout-before-migration-${new Date().toISOString().replace(/:/g, '-')}${incompleteSuffix}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const name of existing) await rename(this.absolute(name), path.join(directory, name));
    await rename(directory, directory.slice(0, -incompleteSuffix.length));
  }

  private async readLayout(rosterText: string, allowLegacyStartup = true): Promise<AppSnapshot> {
    const rosterEnvelope = parseStoreFile(rosterFile, rosterText, rosterSchemaVersion);
    if (!allowLegacyStartup && rosterEnvelope.schemaVersion < desktopRosterSchemaFloor) {
      throw desktopUpgradeError(rosterFile);
    }
    let settingsText = await readIfExists(this.absolute(settingsFile));
    if (settingsText === null) throw new StoreFormatError(`${settingsFile} is missing. Restore it from the ${backupsDirectory} folder.`, settingsFile);
    const settingsEnvelope = parseStoreFile(settingsFile, settingsText);
    const migratedSettings = migrateData(settingsFile, settingsEnvelope.data, settingsEnvelope.schemaVersion, storeSchemaVersion, fileMigrations.settings);
    const files: StoreFiles = {
      roster: parseData(rosterFile, rosterSchema, migrateData(rosterFile, rosterEnvelope.data, rosterEnvelope.schemaVersion, rosterSchemaVersion, fileMigrations.roster)),
      settings: parseData(settingsFile, settingsSchema, migratedSettings),
      visualizations: [],
    };
    this.telemetrySettings = files.settings.telemetry;
    // Keep the original bytes in a verified backup before the file is rewritten at the current schema.
    if (settingsEnvelope.schemaVersion < storeSchemaVersion) {
      await backupFile(this.absolute(settingsFile), this.absolute(backupsDirectory), `settings-v${settingsEnvelope.schemaVersion}`);
      settingsText = serializeStoreFile(migratedSettings);
      await writeFileAtomically(this.absolute(settingsFile), settingsText);
    }
    const icons = await this.repositories.icons();
    files.settings.settings.repositoryIcons = icons;
    this.writtenIcons = icons;
    const unsupported = files.roster.agents.filter(agent => !isSupportedRosterAgent(agent));
    this.unsupportedRoster = unsupported.length ? files.roster : null;
    for (const agent of unsupported) {
      this.options.log?.(`Skipping agent ${agent.id}: unsupported provider ${agent.engine.kind}; its stored data will be preserved.`);
    }
    const written = new Map([[settingsFile, settingsText]]);
    // Establish downgrade protection on load, before any ordinary snapshot save.
    // Keep the original bytes in a verified backup before changing the envelope.
    if (rosterEnvelope.schemaVersion < rosterSchemaVersion) {
      await backupFile(this.absolute(rosterFile), this.absolute(backupsDirectory), `roster-v${rosterEnvelope.schemaVersion}`);
      // Documents still inline move to their own files before the roster that names them is written.
      if (files.roster.missions) {
        const split = storeMissionDocuments(files.roster.missions);
        // The new roster must reopen: each Mission is checked as a fresh start would, before anything is written.
        const texts = new Map(split.files);
        for (const stored of split.missions) await this.withDocuments(stored, texts, true);
        for (const [relative, text] of split.files) {
          await writeFileAtomically(this.absolute(...relative.split('/')), text);
          written.set(relative, text);
        }
        files.roster = { ...files.roster, missions: split.missions };
      }
      rosterText = serializeStoreFile(files.roster, rosterSchemaVersion);
      await writeFileAtomically(this.absolute(rosterFile), rosterText);
    }
    if (files.roster.missions) {
      const missions: StoredMission[] = [];
      // A roster this layout wrote names documents for every Mission; one that names none has lost them.
      const writtenWithDocuments = rosterEnvelope.schemaVersion >= rosterSchemaVersion;
      for (const stored of files.roster.missions) missions.push(await this.withDocuments(stored, written, writtenWithDocuments));
      for (const mission of missions) dropFinishedRunProposals(mission as Mission);
      files.roster = { ...files.roster, missions };
    }
    // Every agent, unsupported ones included: their designs are kept for the build that can run them.
    files.roster = { ...files.roster, agents: await Promise.all(files.roster.agents.map(agent => this.withDesigns(agent, written))) };
    files.roster = { ...files.roster, automations: await Promise.all(files.roster.automations.map(automation => this.withLog(automation, written))) };
    written.set(rosterFile, rosterText);
    for (const { relative, text } of await this.readVisualizationFiles()) {
      try {
        const envelope = parseStoreFile(relative, text);
        files.visualizations.push(parseData(relative, visualizationSchema, migrateData(relative, envelope.data, envelope.schemaVersion, storeSchemaVersion, fileMigrations.visualization)));
        written.set(relative, text);
      } catch (error) {
        // An unreadable visualization is user content: skip it, never delete it.
        this.options.log?.(`Skipping ${relative}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.written = written;
    for (const [relative, text] of written) this.files.remember(this.absolute(...relative.split('/')), text);
    const snapshot = snapshotFromPersistedState(joinPersistedState(files));
    snapshot.general.repositoryIcons = icons;
    return snapshot;
  }

  /**
   * A Mission with the documents its roster entry names. Anything short of the exact file stops the load: the next
   * save would otherwise drop what is missing, or the whole Mission.
   */
  private async withDocuments(stored: StoredMission, written: Map<string, string>, documentsRequired: boolean): Promise<StoredMission> {
    const restore = `Restore roster.json and the ${missionDocumentsDirectory} folder from the ${backupsDirectory} folder.`;
    if (stored.documents === undefined) {
      if (documentsRequired && !stored.artifacts) throw new StoreFormatError(`Mission ${stored.id} in ${rosterFile} names no documents. ${restore}`);
      return stored;
    }
    // The reference becomes a path: only a digest may.
    if (!/^[a-f0-9]{64}$/.test(stored.documents)) throw new StoreFormatError(`Mission ${stored.id} in ${rosterFile} names invalid documents. ${restore}`);
    const relative = missionDocumentsPath(stored.documents);
    const text = written.get(relative) ?? await readIfExists(this.absolute(...relative.split('/')));
    if (text === null) throw new StoreFormatError(`${relative}, the documents of Mission ${stored.id}, is missing. ${restore}`);
    if (sha256(text) !== stored.documents) throw new StoreFormatError(`${relative}, the documents of Mission ${stored.id}, is damaged. ${restore}`);
    const envelope = parseStoreFile(relative, text);
    const mission = joinMissionDocuments(stored, parseData(relative, missionDocumentsSchema, envelope.data));
    if (!mission || !readPersistedMission(mission)) throw new StoreFormatError(`${relative} does not hold valid documents for Mission ${stored.id}. ${restore}`);
    written.set(relative, text);
    return mission;
  }

  /** An agent with the designs its roster entry names. A missing design stops the load: the next save would drop it. */
  private async withDesigns<Agent extends StoredRosterAgent>(agent: Agent, written: Map<string, string>): Promise<Agent> {
    if (!Array.isArray(agent.designWorkspaces) || !agent.designWorkspaces.some(isDesignReference)) return agent;
    const designWorkspaces = [];
    for (const stored of agent.designWorkspaces as unknown[]) {
      if (!isDesignReference(stored)) { designWorkspaces.push(stored); continue; }
      const relative = designPath(stored.design);
      const text = written.get(relative) ?? await readIfExists(this.absolute(...relative.split('/')));
      if (text === null) throw new StoreFormatError(`${relative}, a design of agent ${agent.id}, is missing. Restore roster.json and the ${designsDirectory} folder from the ${backupsDirectory} folder.`);
      const { document, checkpoints } = parseData(relative, designSchema, parseStoreFile(relative, text).data);
      const { design: _design, ...state } = stored;
      designWorkspaces.push({ ...state, document, checkpoints });
      written.set(relative, text);
    }
    return { ...agent, designWorkspaces };
  }

  /** An automation with its log. A log is history, not content: one that cannot be read is left empty. */
  private async withLog(automation: Automation, written: Map<string, string>): Promise<Automation> {
    const relative = automationLogPath(automation.id);
    const text = await readIfExists(this.absolute(...relative.split('/')));
    if (text === null) return automation;
    try {
      const { executionLog } = parseData(relative, automationLogSchema, parseStoreFile(relative, text).data);
      written.set(relative, text);
      return { ...automation, executionLog };
    } catch (error) {
      this.options.log?.(`Skipping ${relative}: ${error instanceof Error ? error.message : String(error)}`);
      return automation;
    }
  }

  private async readVisualizationFiles(): Promise<Array<{ relative: string; text: string }>> {
    const root = this.absolute(visualizationsDirectory);
    const directories = await readdir(root, { withFileTypes: true }).catch(ignoreMissing([]));
    const found: Array<{ relative: string; text: string }> = [];
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const entries = await readdir(path.join(root, directory.name), { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const relative = `${visualizationsDirectory}/${directory.name}/${entry.name}`;
        found.push({ relative, text: await readFile(this.absolute(relative), 'utf8') });
      }
    }
    return found;
  }

  private persistedFiles(snapshot: AppSnapshot): StoreFiles {
    // One shared view: the desktop profile is the effective selection, order and preferences.
    return splitPersistedState(persistedStateFromSnapshot(projectClientSnapshot(snapshot, 'desktop')));
  }

  private withUnsupportedAgents(roster: RosterData): RosterData {
    return this.unsupportedRoster ? preserveUnsupportedAgents(roster, this.unsupportedRoster) : roster;
  }

  private serialize(snapshot: AppSnapshot): Map<string, string> {
    const { roster, settings, visualizations } = this.persistedFiles(snapshot);
    const files = new Map<string, string>();
    for (const visualization of visualizations) files.set(visualizationPath(visualization), serializeStoreFile(visualization));
    delete (settings.settings as Partial<typeof settings.settings>).repositoryIcons;
    files.set(settingsFile, serializeStoreFile({ ...settings, ...(this.telemetrySettings !== undefined ? { telemetry: this.telemetrySettings } : {}) }));
    const missions = roster.missions && storeMissionDocuments(roster.missions);
    for (const [relative, text] of missions?.files ?? []) files.set(relative, text);
    const agents = roster.agents.map(agent => storeDesigns(agent, files));
    const automations = roster.automations.map(({ executionLog, ...automation }) => {
      if (executionLog.length) files.set(automationLogPath(automation.id), serializeStoreFile({ executionLog }));
      return automation as Automation;
    });
    const stored = this.withUnsupportedAgents({ ...roster, agents, automations, ...(missions ? { missions: missions.missions } : {}) });
    // Designs of agents this build cannot run are kept as they were read.
    for (const agent of stored.agents) {
      for (const workspace of Array.isArray(agent.designWorkspaces) ? agent.designWorkspaces as unknown[] : []) {
        const relative = isDesignReference(workspace) ? designPath(workspace.design) : null;
        const text = relative && this.written.get(relative);
        if (relative && text && !files.has(relative)) files.set(relative, text);
      }
    }
    files.set(rosterFile, serializeStoreFile(stored, rosterSchemaVersion));
    return files;
  }

  private async flush(): Promise<void> {
    if (this.writeInFlight) return;
    this.writeInFlight = true;
    try {
      while (this.pending !== null) {
        const desired = this.pending;
        this.pending = null;
        const waiters = this.waiters.splice(0);
        try {
          await this.apply(desired.files, desired.icons);
          for (const waiter of waiters) waiter.resolve();
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        }
      }
    } finally {
      this.writeInFlight = false;
      if (this.pending !== null) void this.flush();
    }
  }

  /**
   * Writes what changed, roster.json last, then removes the visualization files and the Mission document versions
   * the new roster no longer names. Nothing is removed unless roster.json was written.
   */
  private async apply(desired: Map<string, string>, icons: Record<string, string>): Promise<void> {
    if (JSON.stringify(icons) !== JSON.stringify(this.writtenIcons)) {
      await this.repositories.replaceIcons(icons);
      this.writtenIcons = icons;
    }
    for (const [relative, content] of [...desired].sort(([left], [right]) => Number(left === rosterFile) - Number(right === rosterFile))) {
      await this.files.writeIfChanged(this.absolute(...relative.split('/')), content, writeFileAtomically);
      this.written.set(relative, content);
    }
    for (const relative of [...this.written.keys()]) {
      if (desired.has(relative) || !relative.startsWith(`${visualizationsDirectory}/`)) continue;
      await unlink(this.absolute(...relative.split('/'))).catch(ignoreMissing(undefined));
      this.files.forget(this.absolute(...relative.split('/')));
      this.written.delete(relative);
      await rmdir(path.dirname(this.absolute(...relative.split('/')))).catch(() => undefined);
    }
    // Versions a failed save or an interrupted migration left behind are collected too. The save is committed by
    // now: a version that cannot be removed is reported and collected by a later save, never failing this one.
    for (const directory of [missionDocumentsDirectory, designsDirectory, automationLogsDirectory]) {
      for (const name of await readdir(this.absolute(directory)).catch(() => [] as string[])) {
        const relative = `${directory}/${name}`;
        if (desired.has(relative)) continue;
        try {
          await unlink(this.absolute(directory, name)).catch(ignoreMissing(undefined));
          this.files.forget(this.absolute(directory, name));
          this.written.delete(relative);
        } catch (error) {
          this.options.log?.(`Could not remove ${relative}; a later save will: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  private absolute(...segments: string[]): string {
    return path.join(this.home, ...segments);
  }
}

function visualizationPath(data: VisualizationData): string {
  const repository = data.repository;
  const slug = (repository.split('/').filter(Boolean).pop() ?? 'repository').replace(/[^a-zA-Z0-9._-]/g, '-');
  const hash = createHash('sha1').update(repository).digest('hex').slice(0, 8);
  const id = data.visualization.id;
  return `${visualizationsDirectory}/${slug}-${hash}/${safeFileName(id)}.json`;
}

/** An id as a file name: as it is when it is safe, otherwise made safe and kept unique. */
function safeFileName(id: string): string {
  return /^[a-zA-Z0-9._-]+$/.test(id) ? id : `${id.replace(/[^a-zA-Z0-9._-]/g, '_')}-${createHash('sha1').update(id).digest('hex').slice(0, 8)}`;
}

function automationLogPath(id: string): string {
  return `${automationLogsDirectory}/${safeFileName(id)}.json`;
}

function designPath(id: string): string {
  return `${designsDirectory}/${safeFileName(id)}.json`;
}

/** A design workspace as roster.json holds it once its design has its own file. */
type DesignReference = Record<string, unknown> & { design: string };
function isDesignReference(value: unknown): value is DesignReference {
  return Boolean(value) && typeof value === 'object' && typeof (value as { design?: unknown }).design === 'string';
}

/** Moves each design of an agent to its file, leaving the agent the workspace state and the design's id. */
function storeDesigns<Agent extends StoredRosterAgent>(agent: Agent, files: Map<string, string>): Agent {
  if (!Array.isArray(agent.designWorkspaces)) return agent;
  const designWorkspaces = (agent.designWorkspaces as Array<Record<string, unknown>>).map(workspace => {
    const document = workspace.document as { id?: unknown } | null | undefined;
    if (!document || typeof document.id !== 'string') return workspace;
    const { document: _document, checkpoints, ...state } = workspace;
    files.set(designPath(document.id), serializeStoreFile({ document, checkpoints }));
    return { ...state, design: document.id };
  });
  return { ...agent, designWorkspaces };
}

function missionDocumentsPath(digest: string): string {
  return `${missionDocumentsDirectory}/${digest}.json`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Each Mission's documents as the file that holds them, and the Missions as roster.json names those files. */
function storeMissionDocuments(missions: readonly StoredMission[]): { missions: StoredMission[]; files: Array<[string, string]> } {
  const files: Array<[string, string]> = [];
  const stored = missions.map(mission => {
    const split = splitMissionDocuments(mission);
    if (!split.documents) return split.stored;
    const text = serializeStoreFile(split.documents);
    const digest = sha256(text);
    files.push([missionDocumentsPath(digest), text]);
    return { ...split.stored, documents: digest };
  });
  return { missions: stored, files };
}

function sameFiles(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

async function writeFileAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch(ignoreMissing(undefined));
  }
}

async function readIfExists(file: string): Promise<string | null> {
  return readFile(file, 'utf8').catch(ignoreMissing(null));
}

function ignoreMissing<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  };
}
