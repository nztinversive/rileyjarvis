import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rileyjarvis.vector",
  appName: "Vector",
  webDir: "dist",
  ios: {
    allowsLinkPreview: false,
    preferredContentMode: "mobile",
  },
  server: {
    hostname: "localhost",
    iosScheme: "capacitor",
  },
};

export default config;
