import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { createIOSVectorPlatform, type IOSSecureStorageBridge } from "./ios";
import type {
  AppLifecycleCapability,
  VectorPlatform,
  VoiceSessionCapability,
  VoiceSessionEvent,
} from "./types";
import type { IOSVectorPlatformDependencies } from "./ios";

const secureStorage = registerPlugin<IOSSecureStorageBridge>("VectorSecureStorage");

export async function deleteIOSBootstrapCredential(): Promise<void> {
  await secureStorage.delete();
}

type IOSAudioSessionBridge = {
  prepare: () => Promise<{ route: string }>;
  deactivate: () => Promise<void>;
  addListener: (
    eventName: "stateChanged",
    listener: (event: VoiceSessionEvent) => void,
  ) => Promise<PluginListenerHandle>;
};

const audioSession = registerPlugin<IOSAudioSessionBridge>("VectorAudioSession");
const mobileData = registerPlugin<NonNullable<IOSVectorPlatformDependencies["mobileData"]>>("VectorMobileData");
const nativeShare = registerPlugin<NonNullable<IOSVectorPlatformDependencies["nativeShare"]>>("VectorShare");

export function getCapacitorIOSVectorPlatform(): VectorPlatform | null {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "ios") return null;

  const appLifecycle: AppLifecycleCapability = {
    subscribe(callback) {
      const handles = [
        App.addListener("pause", () => callback(false)),
        App.addListener("resume", () => callback(true)),
      ];
      return () => {
        void Promise.all(handles).then((listeners) => Promise.all(listeners.map((listener) => listener.remove())));
      };
    },
  };

  const voiceSession: VoiceSessionCapability = {
    prepare: () => audioSession.prepare(),
    deactivate: () => audioSession.deactivate(),
    subscribe(callback) {
      const handle = audioSession.addListener("stateChanged", callback);
      return () => {
        void handle.then((listener) => listener.remove());
      };
    },
  };

  return createIOSVectorPlatform({
    backendBaseUrl: import.meta.env.VITE_VECTOR_BACKEND_URL ?? "",
    secureStorage,
    appLifecycle,
    voiceSession,
    mobileData,
    nativeShare,
    openExternalUrl: async (url) => {
      await Browser.open({ url, presentationStyle: "popover" });
    },
  });
}
