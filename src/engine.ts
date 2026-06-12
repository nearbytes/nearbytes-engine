/**
 * NearbytesEngine — high-level, shell-agnostic operations layer over
 * EngineRuntime. This is the ONE place the profile/hub/friend/file/chat/sync
 * logic lives. The CLI renders its results as text; the desktop app pushes them
 * to a renderer. Neither re-implements any of it. No parsing, no rendering, no
 * terminal/Electron dependency here.
 */
import {
  readConfig,
  writeConfig,
  emptyConfig,
  defaultDataDir,
  type NearbytesConfig,
  type ProfileConfig,
  type VolumeConfig,
} from 'nearbytes-skeleton';
import type {
  FileMetadata,
  DirectoryMetadata,
  TimelineEvent,
} from 'nearbytes-files';
import {
  IDENTITY_RECORD_PROTOCOL,
  createIdentityRecord,
  serializeIdentityRecord,
  verifyIdentityRecord,
  type ChatTimelineItem,
} from 'nearbytes-chat';
import { EventType, createSecret, bytesToHex, type AppRecordPayload } from 'nearbytes-crypto';
import { createSignedEvent } from 'nearbytes-log';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type EngineRuntime,
  createEngineRuntime,
  openAndWatch,
  closeVolume,
} from './runtime.js';

export interface VolumeView {
  readonly files: ReadonlyArray<FileMetadata>;
  readonly directories: ReadonlyArray<DirectoryMetadata>;
  /** `null` = live head; non-null = read-only historical view at this event. */
  readonly cursorHash: string | null;
}
export interface EngineStatus {
  readonly text: string;
  readonly connectedPeers: number;
  readonly serving: boolean;
}
export interface Whoami {
  readonly peerId: string;
  readonly instanceKey: string;
  readonly activeProfile: string | null;
  readonly activeProfileKey: string;
}

/** Sync-driven change notifications consumed by either shell. */
export type EngineEvent =
  | { readonly kind: 'status'; readonly status: EngineStatus }
  | { readonly kind: 'volume'; readonly hub: string; readonly view: VolumeView }
  | { readonly kind: 'chat'; readonly hub: string; readonly items: ReadonlyArray<ChatTimelineItem> };

export type EngineListener = (e: EngineEvent) => void;

function reorderNamed<T>(
  items: readonly T[],
  keys: readonly string[],
  keyOf: (item: T) => string,
): T[] {
  const map = new Map(items.map((item) => [keyOf(item), item]));
  const ordered: T[] = [];
  for (const key of keys) {
    const item = map.get(key);
    if (item === undefined) throw new Error(`Unknown item key ${key}`);
    ordered.push(item);
    map.delete(key);
  }
  for (const item of map.values()) ordered.push(item);
  return ordered;
}

function reorderKeys(items: readonly string[], keys: readonly string[]): string[] {
  const set = new Set(items);
  const ordered: string[] = [];
  for (const key of keys) {
    if (!set.has(key)) throw new Error(`Unknown friend key ${key}`);
    ordered.push(key);
    set.delete(key);
  }
  for (const key of items) {
    if (set.has(key)) ordered.push(key);
  }
  return ordered;
}

export class NearbytesEngine {
  private readonly listeners = new Set<EngineListener>();
  private activeHub: string | null = null;
  private timelineCursorHash: string | null = null;

  private constructor(private readonly rt: EngineRuntime) {}

  private uiStatePath(): string {
    return join(this.rt.config.dataDir, '.nearbytes', 'ui-state.json');
  }
  private async readUiState(): Promise<{ activeHub?: string }> {
    try { return JSON.parse(await readFile(this.uiStatePath(), 'utf8')) as { activeHub?: string }; }
    catch { return {}; }
  }
  private async writeUiState(patch: { activeHub: string | null }): Promise<void> {
    try {
      await mkdir(join(this.rt.config.dataDir, '.nearbytes'), { recursive: true });
      const prev = await this.readUiState();
      await writeFile(this.uiStatePath(), JSON.stringify({ ...prev, ...patch }), 'utf8');
    } catch { /* best-effort */ }
  }

  static async boot(): Promise<NearbytesEngine> {
    const config = await readConfig().catch(() => emptyConfig(defaultDataDir()));
    const rt = await createEngineRuntime(config);
    const engine = new NearbytesEngine(rt);
    rt.skeleton.sync.onEvent(() => {
      engine.emit({ kind: 'status', status: engine.status() });
      void engine.refreshActive();
    });
    // Restore last-used hub so files + chat are live immediately on restart.
    const { activeHub } = await engine.readUiState();
    if (activeHub && config.volumes.some((v) => v.label === activeHub)) {
      await engine.hubUse(activeHub).catch(() => { /* ignore stale entry */ });
    }
    return engine;
  }

  /** Reuse an already-built runtime (e.g. the CLI Context shares one). */
  static fromRuntime(rt: EngineRuntime): NearbytesEngine { return new NearbytesEngine(rt); }

  on(fn: EngineListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(e: EngineEvent): void { for (const fn of this.listeners) fn(e); }

  async destroy(): Promise<void> { await this.rt.destroy(); }

  private get config(): NearbytesConfig { return this.rt.config; }
  private set config(c: NearbytesConfig) { this.rt.config = c; }

  // ── helpers ───────────────────────────────────────────────────────────
  private hubSecret(label: string | null): string | null {
    if (label === null) return null;
    return this.config.volumes.find((v) => v.label === label)?.secret ?? null;
  }
  private requireHub(): string {
    const s = this.hubSecret(this.activeHub);
    if (s === null) throw new Error('No active hub — select one first');
    return s;
  }
  private async deriveKeyHex(secret: string): Promise<string> {
    const kp = await this.rt.skeleton.crypto.deriveKeys(createSecret(secret));
    return bytesToHex(kp.publicKey);
  }
  private assertTimelineWritesAllowed(): void {
    if (this.timelineCursorHash !== null) {
      throw new Error('Timeline is not at live head — return to live before changing files');
    }
  }
  private async viewOf(secret: string): Promise<VolumeView> {
    const opts =
      this.timelineCursorHash !== null
        ? { throughEventHash: this.timelineCursorHash }
        : undefined;
    const replay = await this.rt.fileService.getReplayContext(secret, opts);
    const files = [...replay.fs.files.values()].sort((a, b) => a.path.localeCompare(b.path));
    const directories = [...replay.fs.directories.values()].sort((a, b) => a.path.localeCompare(b.path));
    return { files, directories, cursorHash: this.timelineCursorHash };
  }
  private async chatOf(secret: string): Promise<ChatTimelineItem[]> {
    // Warm, persisted projection — no full channel reload (chat-v1 §5).
    return this.rt.chatService.timeline(secret);
  }
  private async refreshActive(): Promise<void> {
    const secret = this.hubSecret(this.activeHub);
    if (secret === null || this.activeHub === null) return;
    this.rt.fileService.markReplayStale(secret);
    const [view, items] = await Promise.all([this.viewOf(secret), this.chatOf(secret)]);
    this.emit({ kind: 'volume', hub: this.activeHub, view });
    this.emit({ kind: 'chat', hub: this.activeHub, items });
  }

  // ── status ──────────────────────────────────────────────────────────────
  status(): EngineStatus {
    const serving = this.config.profiles.length > 0;
    const snap = this.rt.skeleton.sync.snapshot();
    const text = !serving
      ? 'No profile — add one to enable sync'
      : `Profile ${this.config.activeProfile} · ${snap.connectedPeers} peer(s)${this.activeHub ? ` · hub ${this.activeHub}` : ''}`;
    return { text, connectedPeers: snap.connectedPeers, serving };
  }
  whoami(): Whoami {
    const s = this.rt.skeleton.sync;
    return { peerId: s.peerId, instanceKey: s.instancePublicKey, activeProfile: this.config.activeProfile, activeProfileKey: s.activeProfilePublicKey };
  }
  peers(): ReadonlyArray<unknown> { return this.rt.skeleton.sync.peers(); }

  // ── persistence + live sync reconfiguration (CLI-identical) ──────────────
  private async persistAndReload(): Promise<void> {
    await writeConfig(this.config);
    await this.rt.skeleton.reloadSync(this.config.friends, {
      profiles: this.config.profiles,
      activeProfile: this.config.activeProfile,
    });
    this.emit({ kind: 'status', status: this.status() });
  }

  // ── profiles ──────────────────────────────────────────────────────────────
  profileList(): ProfileConfig[] { return [...this.config.profiles]; }
  activeProfile(): string | null { return this.config.activeProfile; }
  async profilePublicKey(name?: string): Promise<string> {
    const target = name ?? this.config.activeProfile;
    const p = this.config.profiles.find((x) => x.name === target);
    if (p === undefined) throw new Error(`Unknown profile ${target}`);
    return this.deriveKeyHex(p.secret);
  }
  async profileAdd(name: string, secret: string): Promise<void> {
    if (this.config.profiles.some((p) => p.name === name)) throw new Error(`Profile ${name} exists`);
    this.config = { ...this.config, profiles: [...this.config.profiles, { name, secret }], activeProfile: this.config.activeProfile ?? name };
    await this.persistAndReload();
  }
  async profileUse(name: string): Promise<void> {
    if (!this.config.profiles.some((p) => p.name === name)) throw new Error(`Unknown profile ${name}`);
    this.config = { ...this.config, activeProfile: name };
    await this.persistAndReload();
  }
  async profileRemove(name: string): Promise<void> {
    const profiles = this.config.profiles.filter((p) => p.name !== name);
    const activeProfile = this.config.activeProfile === name ? (profiles[0]?.name ?? null) : this.config.activeProfile;
    this.config = { ...this.config, profiles, activeProfile };
    await this.persistAndReload();
  }
  async profileUpdate(name: string, patch: { readonly name?: string; readonly secret?: string }): Promise<void> {
    const idx = this.config.profiles.findIndex((p) => p.name === name);
    if (idx < 0) throw new Error(`Unknown profile ${name}`);
    const current = this.config.profiles[idx]!;
    const newName = (patch.name ?? name).trim();
    const secretPatch = patch.secret?.trim() ?? '';
    const newSecret = secretPatch.length > 0 ? secretPatch : current.secret;
    if (newName.length === 0) throw new Error('Profile name is required');
    if (newName !== name && this.config.profiles.some((p) => p.name === newName)) {
      throw new Error(`Profile ${newName} exists`);
    }
    const profiles = [...this.config.profiles];
    profiles[idx] = { name: newName, secret: newSecret };
    const activeProfile = this.config.activeProfile === name ? newName : this.config.activeProfile;
    this.config = { ...this.config, profiles, activeProfile };
    await this.persistAndReload();
  }
  async profileReorder(names: readonly string[]): Promise<void> {
    this.config = { ...this.config, profiles: reorderNamed(this.config.profiles, names, (p) => p.name) };
    await writeConfig(this.config);
  }
  /** Publish a signed identity record (display name + bio) to the profile's own channel. */
  async profilePublish(displayName: string, bio?: string, asProfile?: string): Promise<void> {
    const target = asProfile ?? this.config.activeProfile;
    const profile = this.config.profiles.find((p) => p.name === target);
    if (profile === undefined) throw new Error(`Unknown profile ${target ?? '(none)'}`);
    const name = displayName.trim();
    if (name.length === 0) throw new Error('Display name must be non-empty');

    const crypto = this.rt.skeleton.crypto;
    const keyPair = await crypto.deriveKeys(createSecret(profile.secret));
    const publicKey = bytesToHex(keyPair.publicKey);
    const record = await createIdentityRecord(
      crypto,
      keyPair,
      { displayName: name, ...(bio && bio.trim().length > 0 ? { bio: bio.trim() } : {}) },
      Date.now(),
    );
    if (!(await verifyIdentityRecord(crypto, record))) {
      throw new Error('Identity record signature check failed');
    }
    const payload: AppRecordPayload = {
      type: EventType.APP_RECORD,
      protocol: IDENTITY_RECORD_PROTOCOL,
      authorPublicKey: publicKey,
      record: serializeIdentityRecord(record),
      publishedAt: Date.now(),
    };
    const signedEvent = await createSignedEvent(crypto, keyPair, payload, []);
    await this.rt.skeleton.log.events.storeEvent(keyPair.publicKey, signedEvent);
  }

  // ── hubs / volumes ──────────────────────────────────────────────────────────
  hubList(): VolumeConfig[] { return [...this.config.volumes]; }
  hubActive(): string | null { return this.activeHub; }
  async hubAdd(label: string, secret: string): Promise<void> {
    if (this.config.volumes.some((v) => v.label === label)) throw new Error(`Hub ${label} exists`);
    this.config = { ...this.config, volumes: [...this.config.volumes, { label, secret }] };
    await writeConfig(this.config);
  }
  async hubForget(label: string): Promise<void> {
    const secret = this.hubSecret(label);
    this.config = { ...this.config, volumes: this.config.volumes.filter((v) => v.label !== label) };
    if (secret !== null) await closeVolume(this.rt, secret);
    if (this.activeHub === label) {
      this.activeHub = null;
      this.timelineCursorHash = null;
      void this.writeUiState({ activeHub: null });
    }
    await writeConfig(this.config);
  }
  async hubUse(label: string): Promise<VolumeView> {
    const secret = this.hubSecret(label);
    if (secret === null) throw new Error(`Unknown hub ${label}`);
    this.timelineCursorHash = null;
    this.activeHub = label;
    void this.writeUiState({ activeHub: label });
    await openAndWatch(this.rt, secret);
    this.emit({ kind: 'status', status: this.status() });
    const [view, items] = await Promise.all([this.viewOf(secret), this.chatOf(secret)]);
    this.emit({ kind: 'volume', hub: label, view });
    this.emit({ kind: 'chat', hub: label, items });
    return view;
  }
  async hubUpdate(label: string, patch: { readonly label?: string; readonly secret?: string }): Promise<void> {
    const idx = this.config.volumes.findIndex((v) => v.label === label);
    if (idx < 0) throw new Error(`Unknown hub ${label}`);
    const current = this.config.volumes[idx]!;
    const newLabel = (patch.label ?? label).trim();
    const secretPatch = patch.secret?.trim() ?? '';
    const newSecret = secretPatch.length > 0 ? secretPatch : current.secret;
    if (newLabel.length === 0) throw new Error('Hub label is required');
    if (newLabel !== label && this.config.volumes.some((v) => v.label === newLabel)) {
      throw new Error(`Hub ${newLabel} exists`);
    }
    const secretChanged = newSecret !== current.secret;
    if (secretChanged) await closeVolume(this.rt, current.secret);
    const volumes = [...this.config.volumes];
    volumes[idx] = { label: newLabel, secret: newSecret };
    this.config = { ...this.config, volumes };
    if (this.activeHub === label) this.activeHub = newLabel;
    await writeConfig(this.config);
    if (secretChanged && this.activeHub === newLabel) {
      await openAndWatch(this.rt, newSecret);
      await this.refreshActive();
    }
  }
  async hubReorder(labels: readonly string[]): Promise<void> {
    this.config = { ...this.config, volumes: reorderNamed(this.config.volumes, labels, (v) => v.label) };
    await writeConfig(this.config);
  }

  // ── friends ────────────────────────────────────────────────────────────────
  friendList(): string[] { return [...this.config.friends]; }
  async friendAdd(publicKeyHex: string): Promise<void> {
    const key = publicKeyHex.trim().toLowerCase();
    if (key.length === 0 || this.config.friends.includes(key)) return;
    this.config = { ...this.config, friends: [...this.config.friends, key] };
    await this.persistAndReload();
  }
  async friendRemove(prefix: string): Promise<void> {
    const p = prefix.trim().toLowerCase();
    this.config = { ...this.config, friends: this.config.friends.filter((f) => f !== p && !f.startsWith(p)) };
    await this.persistAndReload();
  }
  async friendReorder(keys: readonly string[]): Promise<void> {
    this.config = { ...this.config, friends: reorderKeys(this.config.friends, keys) };
    await this.persistAndReload();
  }

  // ── timeline cursor (read-only historical volume view) ───────────────────
  timelineCursor(): string | null {
    return this.timelineCursorHash;
  }
  async timelineGoto(eventHash: string): Promise<VolumeView> {
    const secret = this.requireHub();
    const replay = await this.rt.fileService.getReplayContext(secret);
    const replayIdx = replay.orderedEntries.findIndex((e) => e.eventHash === eventHash);
    if (replayIdx < 0) throw new Error(`Event not in replay log: ${eventHash}`);
    const atHead = replayIdx === replay.orderedEntries.length - 1;
    this.timelineCursorHash = atHead ? null : eventHash;
    const view = await this.viewOf(secret);
    if (this.activeHub !== null) this.emit({ kind: 'volume', hub: this.activeHub, view });
    return view;
  }
  async timelineLive(): Promise<VolumeView> {
    this.timelineCursorHash = null;
    const secret = this.hubSecret(this.activeHub);
    const view = secret === null ? { files: [], directories: [], cursorHash: null } : await this.viewOf(secret);
    if (this.activeHub !== null) this.emit({ kind: 'volume', hub: this.activeHub, view });
    return view;
  }

  // ── files ──────────────────────────────────────────────────────────────────
  async fileView(): Promise<VolumeView> {
    const secret = this.hubSecret(this.activeHub);
    return secret === null ? { files: [], directories: [], cursorHash: null } : this.viewOf(secret);
  }
  async fileAdd(localPath: string, name?: string): Promise<void> {
    this.assertTimelineWritesAllowed();
    const secret = this.requireHub();
    const data = await readFile(localPath);
    await this.rt.fileService.addFile(secret, name ?? localPath.split(/[\\/]/).pop() ?? 'file', data);
    await this.refreshActive();
  }
  async fileAddBytes(name: string, data: Buffer): Promise<void> {
    this.assertTimelineWritesAllowed();
    const secret = this.requireHub();
    await this.rt.fileService.addFile(secret, name, data);
    await this.refreshActive();
  }
  async fileBytes(name: string): Promise<Buffer> {
    const secret = this.requireHub();
    const opts =
      this.timelineCursorHash !== null
        ? { throughEventHash: this.timelineCursorHash }
        : undefined;
    const replay = await this.rt.fileService.getReplayContext(secret, opts);
    return this.rt.fileService.readFileAtReplay(secret, name, replay);
  }
  async fileGet(name: string, outputPath: string): Promise<void> {
    await writeFile(outputPath, await this.fileBytes(name));
  }
  async fileRemove(name: string): Promise<void> {
    this.assertTimelineWritesAllowed();
    await this.rt.fileService.delete(this.requireHub(), name);
    await this.refreshActive();
  }
  async fileMkdir(path: string): Promise<void> {
    this.assertTimelineWritesAllowed();
    await this.rt.fileService.mkdir(this.requireHub(), path);
    await this.refreshActive();
  }
  async fileRename(from: string, to: string): Promise<void> {
    this.assertTimelineWritesAllowed();
    await this.rt.fileService.rename(this.requireHub(), from, to);
    await this.refreshActive();
  }
  async fileTimeline(): Promise<TimelineEvent[]> {
    const secret = this.hubSecret(this.activeHub);
    return secret === null ? [] : this.rt.fileService.getTimeline(secret);
  }

  // ── chat ─────────────────────────────────────────────────────────────────
  async chatRead(): Promise<ChatTimelineItem[]> {
    const secret = this.hubSecret(this.activeHub);
    return secret === null ? [] : this.chatOf(secret);
  }
  async chatSay(body: string): Promise<void> {
    this.assertTimelineWritesAllowed();
    const secret = this.requireHub();
    const text = body.trim();
    if (text.length === 0) return;
    await this.rt.chatService.publish(secret, text);
    if (this.activeHub !== null) this.emit({ kind: 'chat', hub: this.activeHub, items: await this.chatOf(secret) });
  }
}
