import { getCapacitorIOSVectorPlatform } from "./capacitor";
import { getElectronVectorPlatform } from "./electron";
import { resolveVectorPlatform } from "./resolver";

export type {
  AppLifecycleCapability,
  RealtimeCredential,
  RemoteCodexCapability,
  RemoteCodexLifecycleEvent,
  RemoteCodexTask,
  VectorArtifact,
  VectorPlatform,
  VectorPresentation,
  VectorToolCall,
  VectorToolResult,
  VectorToolSpec,
} from "./types";

export function getVectorPlatform() {
  return resolveVectorPlatform(getCapacitorIOSVectorPlatform(), getElectronVectorPlatform(window));
}
