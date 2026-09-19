import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ManagerState } from '../../../packages/contracts/src/index.js';
import { getPlatformPaths, type PlatformPaths } from '../../../packages/platform/src/index.js';
import { LEGAL_META } from '../../../packages/legal/src/index.js';
import { SILLYTAVERN_PORT } from './ports.js';
import { MANAGER_VERSION } from './version.js';

const STATE_FILE_NAME = 'manager-state.json';
const STATE_SCHEMA_VERSION = 1 as const;
/*
 * What an operator agreed to, named by the revision of the text they were
 * shown rather than by a date written here by hand. The legal package is the
 * one copy of that text, so when it is revised this record follows it and a
 * state file says which wording was actually on screen.
 */
const TERMS_VERSION = LEGAL_META.effective;
const TELEMETRY_NOTICE_VERSION = LEGAL_META.effective;

interface PersistedManagerState {
  readonly schemaVersion: 1;
  readonly managerVersion: string;
  readonly installId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly adminPasswordHash: string | null;
  /** The password the access gateway asks for, separate from the one above. */
  readonly accessPasswordHash: string | null;
  /** Whether that hash came from a six-digit passcode; see AccessGatewayState. */
  readonly accessPasscode: boolean;
  /** Whether that gateway binds to the local network or to this machine only. */
  readonly accessLanEnabled: boolean;
  /**
   * Which port SillyTavern is started on.
   *
   * Kept here rather than read back from config.yaml because the console is
   * what has to guarantee it does not collide with its own port or the
   * gateway's, and a config restored from another machine carries that
   * machine's answer.
   */
  readonly sillyTavernPort: number;
  readonly setupAcceptedAt: string | null;
  readonly termsVersion: string;
  readonly telemetryNoticeVersion: string;
  /**
   * Whether SillyTavern is started when the manager is.
   *
   * On, because the manager exists to run SillyTavern and a console that has
   * to be told to start it every time is one step in front of the thing
   * everybody actually opened it for. Off is for somebody who runs SillyTavern
   * themselves, or who opens the console to look at backups on a machine they
   * do not want a second process on.
   */
  readonly autoStartSillyTavern: boolean;
  /**
   * When the manager installed SillyTavern by itself, if it ever did.
   *
   * A fresh manager with a password just set has nothing installed and one
   * obvious next step, and making the reader find and press it is asking them
   * to confirm the only thing the program does. It is done once and recorded,
   * so somebody who later removes SillyTavern on purpose does not find it
   * installing itself again on the next start.
   */
  readonly firstInstallStartedAt: string | null;
}

export interface StateStoreOptions {
  readonly paths?: PlatformPaths;
  readonly managerVersion?: string;
  readonly now?: () => Date;
}

export class StateStore {
  readonly paths: PlatformPaths;
  private readonly managerVersion: string;
  private readonly now: () => Date;
  private state: PersistedManagerState | null = null;
  private adminWriteQueue: Promise<void> = Promise.resolve();

  public constructor(options: StateStoreOptions = {}) {
    this.paths = options.paths ?? getPlatformPaths();
    this.managerVersion = options.managerVersion ?? MANAGER_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  public async load(): Promise<PersistedManagerState> {
    if (this.state) {
      return this.state;
    }
    await this.ensureDirectories();
    try {
      const raw = await readFile(this.stateFile(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const stored = this.parsePersistedState(parsed);
      /*
       * The version is recorded when the file is created, and an installation
       * outlives many versions of the manager that reads it. Left alone, a
       * state file written on a first install reported that version for the
       * rest of its life - in the banner, in the health response, and on every
       * usage summary. It is refreshed here, once, on the start that finds it
       * stale.
       */
      this.state = stored.managerVersion === this.managerVersion
        ? stored
        : { ...stored, managerVersion: this.managerVersion, updatedAt: this.now().toISOString() };
      if (this.state !== stored) await this.write(this.state);
      return this.state;
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }
      const now = this.now().toISOString();
      const state: PersistedManagerState = {
        schemaVersion: STATE_SCHEMA_VERSION,
        managerVersion: this.managerVersion,
        installId: randomUUID(),
        createdAt: now,
        updatedAt: now,
        adminPasswordHash: null,
        accessPasswordHash: null,
        accessPasscode: false,
        accessLanEnabled: false,
        sillyTavernPort: SILLYTAVERN_PORT,
        setupAcceptedAt: null,
        termsVersion: TERMS_VERSION,
        telemetryNoticeVersion: TELEMETRY_NOTICE_VERSION,
        autoStartSillyTavern: true,
        firstInstallStartedAt: null,
      };
      await this.write(state);
      this.state = state;
      return state;
    }
  }

  public async saveAdminPassword(passwordHash: string, acceptedAt = this.now().toISOString()): Promise<boolean> {
    let saved = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.adminPasswordHash) {
        return;
      }
      const updated: PersistedManagerState = {
        ...state,
        adminPasswordHash: passwordHash,
        setupAcceptedAt: acceptedAt,
        updatedAt: acceptedAt,
      };
      await this.write(updated);
      this.state = updated;
      saved = true;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return saved;
  }

  /**
   * Save the password that opens SillyTavern, replacing any earlier one.
   *
   * Unlike the manager password this has no "only once" rule: it guards a door
   * that is meant to be handed out and taken back.
   */
  public async setAccessPassword(passwordHash: string, passcode: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      const updated: PersistedManagerState = { ...state, accessPasswordHash: passwordHash, accessPasscode: passcode, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /** Record the port SillyTavern is to be started on from now on. */
  public async setSillyTavernPort(port: number): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.sillyTavernPort === port) return;
      const updated: PersistedManagerState = { ...state, sillyTavernPort: port, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /** Whether SillyTavern comes up with the manager. */
  public async setAutoStartSillyTavern(enabled: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.autoStartSillyTavern === enabled) return;
      const updated: PersistedManagerState = { ...state, autoStartSillyTavern: enabled, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  /**
   * Claim the one automatic first install, or find that it is already claimed.
   *
   * True exactly once per installation of the manager. Written through the
   * same queue as everything else here, so two requests arriving together
   * cannot both be told to go ahead.
   */
  public async claimFirstInstall(): Promise<boolean> {
    let claimed = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.firstInstallStartedAt !== null) return;
      const now = this.now().toISOString();
      const updated: PersistedManagerState = { ...state, firstInstallStartedAt: now, updatedAt: now };
      await this.write(updated);
      this.state = updated;
      claimed = true;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return claimed;
  }

  public async setAccessLan(enabled: boolean): Promise<void> {
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (state.accessLanEnabled === enabled) return;
      const updated: PersistedManagerState = { ...state, accessLanEnabled: enabled, updatedAt: this.now().toISOString() };
      await this.write(updated);
      this.state = updated;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
  }

  public async bootstrapAdminPassword(passwordHash: string): Promise<boolean> {
    const state = await this.load();
    if (state.adminPasswordHash) {
      return false;
    }
    return this.saveAdminPassword(passwordHash);
  }

  public async changeAdminPassword(passwordHash: string): Promise<boolean> {
    let changed = false;
    const operation = async (): Promise<void> => {
      const state = await this.load();
      if (!state.adminPasswordHash) {
        return;
      }
      const updated: PersistedManagerState = {
        ...state,
        adminPasswordHash: passwordHash,
        updatedAt: this.now().toISOString(),
      };
      await this.write(updated);
      this.state = updated;
      changed = true;
    };
    const previous = this.adminWriteQueue;
    this.adminWriteQueue = previous.then(operation, operation);
    await this.adminWriteQueue;
    return changed;
  }

  public async getPersisted(): Promise<PersistedManagerState> {
    return this.load();
  }

  public toPublicState(): ManagerState {
    const state = this.state;
    if (!state) {
      throw new Error('State must be loaded before it can be read');
    }
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      managerVersion: state.managerVersion,
      installId: state.installId,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      adminConfigured: state.adminPasswordHash !== null,
      setupAcceptedAt: state.setupAcceptedAt,
      termsVersion: state.termsVersion,
      telemetryNoticeVersion: state.telemetryNoticeVersion,
      platform: this.paths.platform,
      storageRoot: this.paths.root,
      storageDurable: this.paths.platform !== 'unknown',
    };
  }

  private stateFile(): string {
    return join(this.paths.state, STATE_FILE_NAME);
  }

  private async ensureDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.paths.state, { recursive: true }),
      mkdir(this.paths.profiles, { recursive: true }),
      mkdir(this.paths.archives, { recursive: true }),
      mkdir(this.paths.logs, { recursive: true }),
      mkdir(this.paths.metrics, { recursive: true }),
      mkdir(this.paths.outbox, { recursive: true }),
      mkdir(this.paths.tmp, { recursive: true }),
      mkdir(this.paths.bin, { recursive: true }),
    ]);
  }

  private async write(state: PersistedManagerState): Promise<void> {
    await this.ensureDirectories();
    const target = this.stateFile();
    const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, target);
  }

  private parsePersistedState(input: unknown): PersistedManagerState {
    if (!isRecord(input) || input.schemaVersion !== STATE_SCHEMA_VERSION) {
      throw new Error('Unsupported manager state schema');
    }
    const requiredStrings = [
      'managerVersion',
      'installId',
      'createdAt',
      'updatedAt',
      'termsVersion',
      'telemetryNoticeVersion',
    ] as const;
    for (const key of requiredStrings) {
      if (typeof input[key] !== 'string' || input[key].length === 0) {
        throw new Error(`Invalid manager state field: ${key}`);
      }
    }
    if (!isNullableString(input.adminPasswordHash)) {
      throw new Error('Invalid manager state secret field');
    }
    if (!isNullableString(input.setupAcceptedAt)) {
      throw new Error('Invalid manager state timestamp field');
    }
    // State written before the access gateway existed has neither key, and a
    // missing one means the same as its default rather than a broken file.
    const accessPasswordHash = isNullableString(input.accessPasswordHash) ? input.accessPasswordHash : null;
    const accessLanEnabled = input.accessLanEnabled === true;
    // Absent in a file written before passcodes existed, which is exactly the
    // case that has to keep its password field.
    const accessPasscode = input.accessPasscode === true;
    // Written before the port could be moved, or written by a newer version and
    // read back by an older one: either way the shipped port is the answer that
    // matches what the file it describes actually says.
    const storedPort = input.sillyTavernPort;
    const sillyTavernPort = typeof storedPort === 'number' && Number.isInteger(storedPort) && storedPort > 0 && storedPort <= 65535
      ? storedPort
      : SILLYTAVERN_PORT;
    // Absent in a file written before these existed. The first is on by
    // default, so only an explicit `false` turns it off; the second says the
    // automatic install has not happened, which for an existing installation
    // is settled a moment later by there already being one.
    const autoStartSillyTavern = input.autoStartSillyTavern !== false;
    const firstInstallStartedAt = isNullableString(input.firstInstallStartedAt) ? input.firstInstallStartedAt : null;
    return { ...input, accessPasswordHash, accessPasscode, accessLanEnabled, sillyTavernPort, autoStartSillyTavern, firstInstallStartedAt } as unknown as PersistedManagerState;
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
