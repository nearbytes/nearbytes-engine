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
  publishChatMessage,
  readChatTimeline,
  type ChatTimelineItem,
} from 'nearbytes-chat';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  type EngineRuntime,
  createEngineRuntime,
  openAndWatch,
  closeVolume,
} from './runtime.js';

export interface VolumeView {
  readonly files: ReadonlyArray<FileMetadata>;
  readonly directories: ReadonlyArray<DirectoryMetadata>;
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

export class NearbytesEngine {
  private readonly listeners = new Set<EngineListener>();
  private activeHub: string | null = null;

  private constructor(private readonly rt: EngineRuntime) {}

  static async boot(): Promise<NearbytesEngine> {
    const config = await readConfig().catch(() => emptyConfig(defaultDataDir()));
    const rt = await createEngineRuntime(config);
    const engine = new NearbytesEngine(rt);
    rt.skeleton.sync.onEvent(() => {
      engine.emit({ kind: 'status', status: engine.status() });
      void engine.refreshActive();
    });
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
  private async viewOf(secret: string): Promise<VolumeView> {
    const [files, directories] = await Promise.all([
      this.rt.fileService.listFiles(secret),
      this.rt.fileService.listDirectories(secret),
    ]);
    return { files, directories };
  }
  private async chatOf(secret: string): Promise<ChatTimelineItem[]> {
    return readChatTimeline({ log: this.rt.skeleton.log, crypto: this.rt.skeleton.crypto }, secret);
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
    if (this.activeHub === label) this.activeHub = null;
    await writeConfig(this.config);
  }
  async hubUse(label: string): Promise<VolumeView> {
    const secret = this.hubSecret(label);
    if (secret === null) throw new Error(`Unknown hub ${label}`);
    this.activeHub = label;
    await openAndWatch(this.rt, secret);
    this.emit({ kind: 'status', status: this.status() });
    const [view, items] = await Promise.all([this.viewOf(secret), this.chatOf(secret)]);
    this.emit({ kind: 'volume', hub: label, view });
    this.emit({ kind: 'chat', hub: label, items });
    return view;
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

  // ── files ──────────────────────────────────────────────────────────────────
  async fileView(): Promise<VolumeView> {
    const secret = this.hubSecret(this.activeHub);
    return secret === null ? { files: [], directories: [] } : this.viewOf(secret);
  }
  async fileAdd(localPath: string, name?: string): Promise<void> {
    const secret = this.requireHub();
    const data = await readFile(localPath);
    await this.rt.fileService.addFile(secret, name ?? localPath.split(/[\\/]/).pop() ?? 'file', data);
    await this.refreshActive();
  }
  async fileAddBytes(name: string, data: Buffer): Promise<void> {
    const secret = this.requireHub();
    await this.rt.fileService.addFile(secret, name, data);
    await this.refreshActive();
  }
  async fileBytes(name: string): Promise<Buffer> {
    return this.rt.fileService.getFileByPath(this.requireHub(), name);
  }
  async fileGet(name: string, outputPath: string): Promise<void> {
    await writeFile(outputPath, await this.fileBytes(name));
  }
  async fileRemove(name: string): Promise<void> {
    await this.rt.fileService.delete(this.requireHub(), name);
    await this.refreshActive();
  }
  async fileMkdir(path: string): Promise<void> {
    await this.rt.fileService.mkdir(this.requireHub(), path);
    await this.refreshActive();
  }
  async fileRename(from: string, to: string): Promise<void> {
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
    const secret = this.requireHub();
    const text = body.trim();
    if (text.length === 0) return;
    await publishChatMessage({ log: this.rt.skeleton.log, crypto: this.rt.skeleton.crypto }, secret, text);
    if (this.activeHub !== null) this.emit({ kind: 'chat', hub: this.activeHub, items: await this.chatOf(secret) });
  }
}
