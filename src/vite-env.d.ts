/// <reference types="vite/client" />

import type { ElectronPreloadBridge } from "./platform/electron";

declare global {
  interface Window {
    ricky?: ElectronPreloadBridge;
  }
}
