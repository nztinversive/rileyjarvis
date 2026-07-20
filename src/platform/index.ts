import { getElectronVectorPlatform } from "./electron";

export type {
  RealtimeCredential,
  RemoteCodexCapability,
  RemoteCodexLifecycleEvent,
  RemoteCodexTask,
  VectorArtifact,
  VectorPlatform,
  VectorToolCall,
  VectorToolResult,
  VectorToolSpec,
} from "./types";

export function getVectorPlatform() {
  return getElectronVectorPlatform(window);
}
