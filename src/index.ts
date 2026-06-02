// nearbytes-engine — shared core reused by nearbytes-cli (terminal shell) and
// nearbytes-app (UI shell). Runtime + sync + config + file/chat operations.
export type { EngineRuntime } from './runtime.js';
export {
  createEngineRuntime,
  openAndWatch,
  reloadVolumeFromDisk,
  refreshIfOpen,
  closeVolume,
  attachSyncInboundRefresh,
} from './runtime.js';

export { NearbytesEngine } from './engine.js';
export type {
  VolumeView,
  EngineStatus,
  Whoami,
  EngineEvent,
  EngineListener,
} from './engine.js';
