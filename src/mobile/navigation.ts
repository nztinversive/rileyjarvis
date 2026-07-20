import type { VectorConnectionState, VectorMood } from "../lib/realtime";

export type MobileTab = "talk" | "artifacts" | "activity";

export type MobileNavigationState = {
  activeTab: MobileTab;
};

export type MobileNavigationAction = {
  type: "select";
  tab: MobileTab;
};

export const mobileTabs = [
  { id: "talk", label: "Talk" },
  { id: "artifacts", label: "Artifacts" },
  { id: "activity", label: "Activity" },
] as const satisfies ReadonlyArray<{ id: MobileTab; label: string }>;

export function mobileNavigationReducer(
  state: MobileNavigationState,
  action: MobileNavigationAction,
): MobileNavigationState {
  if (action.type === "select" && action.tab !== state.activeTab) {
    return { activeTab: action.tab };
  }
  return state;
}

export type ConnectionControlPresentation = {
  action: "connect" | "disconnect" | "wait";
  label: string;
  detail: string;
  disabled: boolean;
  tone: "idle" | "active" | "error";
};

export function connectionControlPresentation(
  connectionState: VectorConnectionState,
  mood: VectorMood,
): ConnectionControlPresentation {
  if (connectionState === "connecting") {
    return {
      action: "wait",
      label: "Connecting…",
      detail: "Preparing a secure Realtime session",
      disabled: true,
      tone: "active",
    };
  }

  if (connectionState === "error") {
    return {
      action: "connect",
      label: "Try again",
      detail: "Connection failed",
      disabled: false,
      tone: "error",
    };
  }

  if (connectionState === "connected") {
    if (mood === "listening") {
      return {
        action: "disconnect",
        label: "Listening",
        detail: "Tap to disconnect",
        disabled: false,
        tone: "active",
      };
    }
    return {
      action: "disconnect",
      label: "Disconnect",
      detail: mood === "speaking" ? "Vector is speaking" : "Conversation is connected",
      disabled: false,
      tone: "active",
    };
  }

  return {
    action: "connect",
    label: "Start conversation",
    detail: "Voice connects when you are ready",
    disabled: false,
    tone: "idle",
  };
}
