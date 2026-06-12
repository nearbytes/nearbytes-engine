/**
 * EngineRuntime — the shared NearBytes runtime core extracted from
 * nearbytes-cli/src/cli/context.ts. Owns the skeleton (crypto + log + sync),
 * the file service, the reactive-volume cache, the per-channel filesystem
 * watchers, and the sync inbound-refresh wiring. Contains NO command parsing,
 * NO result rendering, NO terminal/Electron concerns — those live in the
 * shells (nearbytes-cli, nearbytes-app). Both shells MUST reuse this.
 */
import {
  attachSyncInboundRefresh as attachFilesSyncInboundRefresh,
  createFileService,
  createReactiveVolume,
  type FileReplayContext,
  type FileService,
  type ReactiveVolume,
  type TimelineEvent,
} from 'nearbytes-files';
import { createChatService, type ChatService } from 'nearbytes-chat';
import {
  createFilesystemSkeletonFromConfig,
  createFilesystemWatcher,
  type NearbytesSkeleton,
  type NearbytesConfig,
  type VolumeWatcher,
} from 'nearbytes-skeleton';
import { join } from 'node:path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { defaultPathMapper, createSqliteMaterializedStore, type MaterializedStore } from 'nearbytes-log';
import { createTimelineCursorMap, type TimelineCursorMap } from './timelineCursor.js';

export interface EngineRuntime {
  config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  /** Engine-backed chat (persisted projection per hub; no full reloads). */
  readonly chatService: ChatService;
  readonly volumes: Map<string, ReactiveVolume>;
  readonly watchers: Map<string, VolumeWatcher>;
  /** keyHex → channel secret, populated by openAndWatch (drives refresh). */
  readonly secretsByKey: Map<string, string>;
  /** Cleared on any reload so timeline projections recompute lazily. */
  lastTimelineEvents: TimelineEvent[] | null;
  /** Called after {@link reloadVolumeFromDisk} completes for a volume secret. */
  readonly volumeRefreshHooks: Set<(secret: string) => void>;
  /** Per-channel secret → inclusive timeline cursor event hash (read-only replay). */
  readonly timelineCursors: TimelineCursorMap;
  destroy(): Promise<void>;
}

/** Boots the shared runtime: skeleton log + sync, file service, empty caches. */
export async function createEngineRuntime(config: NearbytesConfig): Promise<EngineRuntime> {
  const skeleton = await createFilesystemSkeletonFromConfig(config);
  // Derived materialized state persists under dataDir/.nearbytes/ (deletable;
  // rebuilt by full re-materialization). See storage/projection-engine-v1.md.
  const nbDir = join(config.dataDir, '.nearbytes');
  const filesStore: MaterializedStore = createSqliteMaterializedStore(join(nbDir, 'files.sqlite3'));
  const chatStore: MaterializedStore = createSqliteMaterializedStore(join(nbDir, 'chat.sqlite3'));
  const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto, store: filesStore });
  const chatService = createChatService({ log: skeleton.log, crypto: skeleton.crypto, store: chatStore });
  const volumes = new Map<string, ReactiveVolume>();
  const watchers = new Map<string, VolumeWatcher>();
  const secretsByKey = new Map<string, string>();

  const rt: EngineRuntime = {
    config,
    skeleton,
    fileService,
    chatService,
    volumes,
    watchers,
    secretsByKey,
    lastTimelineEvents: null,
    volumeRefreshHooks: new Set(),
    timelineCursors: createTimelineCursorMap(),
    async destroy(): Promise<void> {
      for (const w of watchers.values()) w.close();
      watchers.clear();
      chatService.stop();
      filesStore.close?.();
      chatStore.close?.();
      await skeleton.destroy();
    },
  };
  return rt;
}

async function keyHexOf(rt: EngineRuntime, secret: string): Promise<string> {
  const kp = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
  return bytesToHex(kp.publicKey);
}

/**
 * Reload a volume after external writes (peer sync, nbsync, another process):
 * invalidate the replay cache and re-apply the materialized state to the
 * reactive volume. Mirrors context.ts `reloadVolumeFromDisk`.
 */
export async function reloadVolumeFromDisk(
  rt: EngineRuntime,
  secret: string,
): Promise<FileReplayContext> {
  rt.fileService.markReplayStale(secret);
  rt.lastTimelineEvents = null;
  const replay = await rt.fileService.getReplayContext(secret);
  const keyHex = await keyHexOf(rt, secret);
  rt.volumes.get(keyHex)?.applyMaterialized(replay.fs);
  for (const hook of rt.volumeRefreshHooks) {
    hook(secret);
  }
  return replay;
}

/** Open a volume (cached) and start a filesystem watcher that reloads on change. */
export async function openAndWatch(
  rt: EngineRuntime,
  secret: string,
  watch = true,
): Promise<ReactiveVolume> {
  const keyHex = await keyHexOf(rt, secret);
  const cached = rt.volumes.get(keyHex);
  if (cached !== undefined) return cached;

  const rv = await createReactiveVolume(createSecret(secret), rt.skeleton.crypto, rt.skeleton.log);
  rt.volumes.set(keyHex, rv);
  rt.secretsByKey.set(keyHex, secret);
  await rt.fileService.getReplayContext(secret);

  if (watch && !rt.watchers.has(keyHex)) {
    const kp = await rt.skeleton.crypto.deriveKeys(createSecret(secret));
    const channelDir = join(rt.config.dataDir, defaultPathMapper(kp.publicKey));
    const watcher = await createFilesystemWatcher(channelDir, {
      refresh: async () => { await reloadVolumeFromDisk(rt, secret); },
    });
    rt.watchers.set(keyHex, watcher);
  }
  return rv;
}

/** Refresh an already-open volume from the current replay (no log rescan). */
export async function refreshIfOpen(rt: EngineRuntime, secret: string): Promise<void> {
  const keyHex = await keyHexOf(rt, secret);
  if (!rt.volumes.has(keyHex)) return;
  const replay = await rt.fileService.getReplayContext(secret);
  rt.volumes.get(keyHex)!.applyMaterialized(replay.fs);
}

/** Forget a volume (close its watcher, drop caches). */
export async function closeVolume(rt: EngineRuntime, secret: string): Promise<void> {
  const keyHex = await keyHexOf(rt, secret);
  rt.watchers.get(keyHex)?.close();
  rt.watchers.delete(keyHex);
  rt.volumes.delete(keyHex);
  rt.secretsByKey.delete(keyHex);
}

/**
 * When this process owns the sync engine, refresh open volumes after inbound
 * peer writes (channel-scoped; incremental via FileService when possible).
 * Delegates to nearbytes-files `attachSyncInboundRefresh`.
 */
export function attachSyncInboundRefresh(
  rt: EngineRuntime,
  onAfterRefresh?: () => void,
): () => void {
  return attachFilesSyncInboundRefresh(
    {
      config: rt.config,
      skeleton: rt.skeleton,
      fileService: rt.fileService,
      volumes: rt.volumes,
      openVolumeSecrets(): Iterable<string> {
        return rt.secretsByKey.values();
      },
      onVolumeRefreshed(secret: string): void {
        rt.lastTimelineEvents = null;
        for (const hook of rt.volumeRefreshHooks) {
          hook(secret);
        }
      },
    },
    { onAfterRefresh },
  );
}
