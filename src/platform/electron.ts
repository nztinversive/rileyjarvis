import type {
  RealtimeCredential,
  RemoteCodexLifecycleEvent,
  VectorPlatform,
  VectorToolCall,
  VectorToolResult,
  VectorToolSpec,
} from "./types";

export type ElectronPreloadBridge = {
  createRealtimeToken: () => Promise<RealtimeCredential>;
  executeTool: (toolCall: VectorToolCall) => Promise<VectorToolResult>;
  getToolSpecs: () => Promise<VectorToolSpec[]>;
  onRemoteCodexEvent?: (callback: (event: RemoteCodexLifecycleEvent) => void) => () => void;
};

export function createElectronVectorPlatform(bridge: ElectronPreloadBridge): VectorPlatform {
  const subscribeToRemoteCodexLifecycle = bridge.onRemoteCodexEvent;

  return {
    presentation: "desktop",
    createRealtimeCredential: () => bridge.createRealtimeToken(),
    executeTool: (toolCall) => bridge.executeTool(toolCall),
    listToolSpecs: () => bridge.getToolSpecs(),
    ...(subscribeToRemoteCodexLifecycle
      ? {
          remoteCodex: {
            subscribeToLifecycle: (callback: (event: RemoteCodexLifecycleEvent) => void) => subscribeToRemoteCodexLifecycle(callback),
          },
        }
      : {}),
  };
}

export function getElectronVectorPlatform(host: { ricky?: ElectronPreloadBridge }): VectorPlatform | null {
  return host.ricky ? createElectronVectorPlatform(host.ricky) : null;
}
