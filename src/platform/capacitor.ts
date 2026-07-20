import { App } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import { Capacitor, registerPlugin } from "@capacitor/core";
import { createIOSVectorPlatform, type IOSSecureStorageBridge } from "./ios";
import type { AppLifecycleCapability, VectorPlatform } from "./types";

const secureStorage = registerPlugin<IOSSecureStorageBridge>("VectorSecureStorage");

export async function setIOSBootstrapCredential(value: string): Promise<void> {
  await secureStorage.set({ value });
}

export async function deleteIOSBootstrapCredential(): Promise<void> {
  await secureStorage.delete();
}

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

  return createIOSVectorPlatform({
    backendBaseUrl: import.meta.env.VITE_VECTOR_BACKEND_URL ?? "",
    secureStorage,
    appLifecycle,
    openExternalUrl: async (url) => {
      await Browser.open({ url, presentationStyle: "popover" });
    },
  });
}
