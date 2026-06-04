/**
 * EngineRuntime — the shared NearBytes runtime core extracted from
 * nearbytes-cli/src/cli/context.ts. Owns the skeleton (crypto + log + sync),
 * the file service, the reactive-volume cache, the per-channel filesystem
 * watchers, and the sync inbound-refresh wiring. Contains NO command parsing,
 * NO result rendering, NO terminal/Electron concerns — those live in the
 * shells (nearbytes-cli, nearbytes-app). Both shells MUST reuse this.
 */
import {
  createFileService,
  createReactiveVolume,
  type FileReplayContext,
  type FileService,
  type ReactiveVolume,
  type TimelineEvent,
} from 'nearbytes-files';
import {
  createFilesystemSkeletonFromConfig,
  createFilesystemWatcher,
  type NearbytesSkeleton,
  type NearbytesConfig,
  type VolumeWatcher,
} from 'nearbytes-skeleton';
import { join } from 'node:path';
import { createSecret, bytesToHex } from 'nearbytes-crypto';
import { defaultPathMapper } from 'nearbytes-log';

export interface EngineRuntime {
  config: NearbytesConfig;
  readonly skeleton: NearbytesSkeleton;
  readonly fileService: FileService;
  readonly volumes: Map<string, ReactiveVolume>;
  readonly watchers: Map<string, VolumeWatcher>;
  /** keyHex → channel secret, populated by openAndWatch (drives refresh). */
  readonly secretsByKey: Map<string, string>;
  /** Cleared on any reload so timeline projections recompute lazily. */
  lastTimelineEvents: TimelineEvent[] | null;
  /** Called after {@link reloadVolumeFromDisk} completes for a volume secret. */
  readonly volumeRefreshHooks: Set<(secret: string) => void>;
  destroy(): Promise<void>;
}

/** Boots the shared runtime: skeleton log + sync, file service, empty caches. */
export async function createEngineRuntime(config: NearbytesConfig): Promise<EngineRuntime> {
  const skeleton = await createFilesystemSkeletonFromConfig(config);
  const fileService = createFileService({ log: skeleton.log, crypto: skeleton.crypto });
  const volumes = new Map<string, ReactiveVolume>();
  const watchers = new Map<string, VolumeWatcher>();
  const secretsByKey = new Map<string, string>();

  const rt: EngineRuntime = {
    config,
    skeleton,
    fileService,
    volumes,
    watchers,
    secretsByKey,
    lastTimelineEvents: null,
    volumeRefreshHooks: new Set(),
    async destroy(): Promise<void> {
      for (const w of watchers.values()) w.close();
      watchers.clear();
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
 * When this process owns the sync engine, reload open volumes after inbound
 * peer writes so file/chat views reflect synced data without manual refresh.
 * Writer-only processes (an nbsync daemon holds the lock) skip this.
 * Mirrors context.ts `attachSyncInboundRefresh` (reload-all variant).
 */
export function attachSyncInboundRefresh(
  rt: EngineRuntime,
  onAfterRefresh?: () => void,
): () => void {
  const writerOnly = (rt.skeleton.sync as { daemon?: unknown }).daemon !== undefined;
  if (writerOnly) return () => {};

  return rt.skeleton.sync.onEvent((event) => {
    if (event.kind === 'block-received' || event.kind === 'event-received') {
      void (async () => {
        for (const secret of rt.secretsByKey.values()) {
          await reloadVolumeFromDisk(rt, secret);
        }
        onAfterRefresh?.();
      })();
    }
  });
}
