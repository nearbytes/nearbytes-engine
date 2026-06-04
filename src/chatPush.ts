/**
 * Push API for hub chat — one {@link ChatTimelineItem} at a time, no polling.
 *
 * Triggers:
 *   1. `sync.onEvent('event-received')` when this process owns the sync engine
 *   2. {@link EngineRuntime.volumeRefreshHooks} after a volume reload (local
 *      `say`, nbsync daemon writes, filesystem watcher) — scans only unseen hashes
 */

import type { Hash } from 'nearbytes-crypto';
import { bytesToHex, createSecret } from 'nearbytes-crypto';
import {
  parseChatPayload,
  readChatTimeline,
  verifyChatMessage,
  type ChatTimelineItem,
} from 'nearbytes-chat';
import { hydrateSignedEvent, openChannel } from 'nearbytes-log';
import type { EngineRuntime } from './runtime.js';

export type ChatPushHandler = (
  item: ChatTimelineItem,
  meta: { readonly channelHex: string; readonly secret: string },
) => void;

export interface ChatPushSubscription {
  /**
   * Mark existing hub messages as seen (no push). Call when the UI attaches
   * or the active hub changes.
   */
  seed(secret: string): Promise<{ readonly channelHex: string; readonly priorCount: number }>;
  /** Push a message the caller already has (e.g. local `say`). */
  notify(item: ChatTimelineItem, secret: string): void;
  stop(): void;
}

interface ChannelState {
  secret: string;
  seen: Set<string>;
}

type IngestResult = 'missing' | 'not-chat' | ChatTimelineItem;

async function chatItemFromEvent(
  rt: EngineRuntime,
  secret: string,
  eventHash: string,
): Promise<IngestResult> {
  try {
    const channel = await openChannel(createSecret(secret), rt.skeleton.crypto);
    const keyPair = await rt.skeleton.crypto.deriveKeys(channel.secret);
    const signedEvent = await rt.skeleton.log.events.retrieveEvent(
      keyPair.publicKey,
      eventHash as Hash,
    );
    const decrypted = await hydrateSignedEvent(
      rt.skeleton.crypto,
      keyPair.privateKey,
      signedEvent,
    );
    const extracted = parseChatPayload(decrypted.payload);
    if (extracted === null) {
      return 'not-chat';
    }
    const verified = await verifyChatMessage(rt.skeleton.crypto, extracted.message).catch(
      () => false,
    );
    return {
      eventHash: eventHash as Hash,
      channelPublicKey: bytesToHex(keyPair.publicKey).toLowerCase(),
      publishedAt: extracted.publishedAt,
      message: extracted.message,
      verified,
    };
  } catch {
    return 'missing';
  }
}

async function channelHexForSecret(rt: EngineRuntime, secret: string): Promise<string> {
  const channel = await openChannel(createSecret(secret), rt.skeleton.crypto);
  const keyPair = await rt.skeleton.crypto.deriveKeys(channel.secret);
  return bytesToHex(keyPair.publicKey).toLowerCase();
}

export function attachChatPush(rt: EngineRuntime, onChat: ChatPushHandler): ChatPushSubscription {
  const channels = new Map<string, ChannelState>();

  const stateFor = (channelHex: string, secret: string): ChannelState => {
    let state = channels.get(channelHex);
    if (state === undefined) {
      state = { secret, seen: new Set() };
      channels.set(channelHex, state);
    }
    return state;
  };

  const pushIfNew = async (secret: string, eventHash: string): Promise<void> => {
    const channelHex = await channelHexForSecret(rt, secret);
    const state = stateFor(channelHex, secret);
    if (state.seen.has(eventHash)) {
      return;
    }
    const result = await chatItemFromEvent(rt, secret, eventHash);
    if (result === 'missing') {
      return;
    }
    state.seen.add(eventHash);
    if (result === 'not-chat') {
      return;
    }
    onChat(result, { channelHex, secret });
  };

  const scanNewOnDisk = async (secret: string): Promise<void> => {
    const channel = await openChannel(createSecret(secret), rt.skeleton.crypto);
    const keyPair = await rt.skeleton.crypto.deriveKeys(channel.secret);
    const channelHex = bytesToHex(keyPair.publicKey).toLowerCase();
    const state = stateFor(channelHex, secret);
    const listed = await rt.skeleton.log.events.listEvents(keyPair.publicKey);
    for (const hash of listed) {
      if (state.seen.has(hash)) {
        continue;
      }
      await pushIfNew(secret, hash);
    }
  };

  const onVolumeRefresh = (secret: string): void => {
    void scanNewOnDisk(secret);
  };
  rt.volumeRefreshHooks.add(onVolumeRefresh);

  const writerOnly = (rt.skeleton.sync as { daemon?: unknown }).daemon !== undefined;
  const stopSync = writerOnly
    ? (): void => {}
    : rt.skeleton.sync.onEvent((event) => {
        if (event.kind !== 'event-received') {
          return;
        }
        const channelHex = event.channel.toLowerCase();
        const known = channels.get(channelHex);
        if (known !== undefined) {
          void pushIfNew(known.secret, event.eventHash);
          return;
        }
        for (const secret of rt.secretsByKey.values()) {
          void (async () => {
            const hex = await channelHexForSecret(rt, secret);
            if (hex === channelHex) {
              await pushIfNew(secret, event.eventHash);
            }
          })();
        }
      });

  return {
    async seed(secret: string): Promise<{ channelHex: string; priorCount: number }> {
      const channelHex = await channelHexForSecret(rt, secret);
      const timeline = await readChatTimeline(
        { log: rt.skeleton.log, crypto: rt.skeleton.crypto },
        secret,
      );
      const state = stateFor(channelHex, secret);
      state.seen = new Set(timeline.map((t) => t.eventHash));
      return { channelHex, priorCount: timeline.length };
    },
    notify(item: ChatTimelineItem, secret: string): void {
      void (async () => {
        const channelHex = await channelHexForSecret(rt, secret);
        stateFor(channelHex, secret).seen.add(item.eventHash);
        onChat(item, { channelHex, secret });
      })();
    },
    stop(): void {
      stopSync();
      rt.volumeRefreshHooks.delete(onVolumeRefresh);
    },
  };
}
