import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  FileText,
  Keyboard,
  List,
  LoaderCircle,
  MessageCircle,
  Mic,
  MicOff,
  Moon,
  Send,
  Sun,
  X,
  Zap,
} from "lucide-react";
import type {
  MouthShape,
  TranscriptEntry,
  VectorConnectionState,
  VectorMood,
} from "../lib/realtime";
import {
  connectionControlPresentation,
  mobileNavigationReducer,
  mobileTabs,
  type MobileTab,
} from "../mobile/navigation";
import type { MobileDataCapability, NativeShareCapability, VectorArtifact } from "../platform";
import { ArtifactPanel } from "./ArtifactPanel";
import { MobileLibrary } from "./MobileLibrary";
import { VectorOrb } from "./VectorOrb";

type MobileAppShellProps = {
  artifact: VectorArtifact | null;
  connectionState: VectorConnectionState;
  mood: VectorMood;
  mouthShape: MouthShape;
  status: string;
  textPrompt: string;
  theme: "day" | "night";
  transcript: TranscriptEntry[];
  showTypeInput: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenExternalUrl?: (url: string) => Promise<void>;
  onSendTextPrompt: () => void;
  onTextPromptChange: (value: string) => void;
  onToggleTheme: () => void;
  onToggleTypeInput: () => void;
  mobileData?: MobileDataCapability;
  nativeShare?: NativeShareCapability;
};

const tabIcons = {
  talk: MessageCircle,
  artifacts: FileText,
  activity: List,
} satisfies Record<MobileTab, typeof MessageCircle>;

export function MobileAppShell({
  artifact,
  connectionState,
  mood,
  mouthShape,
  status,
  textPrompt,
  theme,
  transcript,
  showTypeInput,
  onConnect,
  onDisconnect,
  onOpenExternalUrl,
  onSendTextPrompt,
  onTextPromptChange,
  onToggleTheme,
  onToggleTypeInput,
  mobileData,
  nativeShare,
}: MobileAppShellProps) {
  const [{ activeTab }, dispatchNavigation] = useReducer(mobileNavigationReducer, {
    activeTab: "talk",
  });
  const [unseenArtifact, setUnseenArtifact] = useState(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const previousArtifact = useRef(artifact);

  useEffect(() => {
    if (artifact && artifact !== previousArtifact.current && activeTab !== "artifacts") {
      setUnseenArtifact(true);
    }
    previousArtifact.current = artifact;
  }, [activeTab, artifact]);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [activeTab]);

  function selectTab(tab: MobileTab) {
    dispatchNavigation({ type: "select", tab });
    if (tab === "artifacts") setUnseenArtifact(false);
  }

  return (
    <main className="mobile-shell">
      <header className="mobile-app-header">
        <div className="mobile-brand">
          <span className="mobile-brand-mark" aria-hidden="true">
            <Zap size={19} strokeWidth={2.5} />
          </span>
          <div>
            <strong>Vector</strong>
            <span>Mobile companion · Voice preview</span>
          </div>
        </div>
        <button
          className="mobile-icon-button"
          type="button"
          onClick={onToggleTheme}
          aria-label={theme === "day" ? "Switch to night appearance" : "Switch to day appearance"}
        >
          {theme === "day" ? <Moon size={20} /> : <Sun size={20} />}
        </button>
      </header>

      <div className="mobile-page-scroll">
        {activeTab === "talk" ? (
          <TalkScreen
            connectionState={connectionState}
            headingRef={headingRef}
            mood={mood}
            mouthShape={mouthShape}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
            onSendTextPrompt={onSendTextPrompt}
            onTextPromptChange={onTextPromptChange}
            onToggleTypeInput={onToggleTypeInput}
            showTypeInput={showTypeInput}
            status={status}
            textPrompt={textPrompt}
          />
        ) : null}

        {activeTab === "artifacts" ? (
          <section
            className="mobile-screen mobile-artifact-screen"
            id="mobile-panel-artifacts"
            role="tabpanel"
            aria-labelledby="mobile-tab-artifacts"
          >
            <h1 className="sr-only" ref={headingRef} tabIndex={-1}>
              Artifacts
            </h1>
            {mobileData ? (
              <MobileLibrary artifact={artifact} mobileData={mobileData} nativeShare={nativeShare} onOpenExternalUrl={onOpenExternalUrl} />
            ) : (
              <ArtifactPanel artifact={artifact} visible fullscreen={false} presentation="mobile" onToggleVisible={() => selectTab("talk")} onToggleFullscreen={() => undefined} onOpenExternalUrl={onOpenExternalUrl} />
            )}
          </section>
        ) : null}

        {activeTab === "activity" ? (
          <ActivityScreen
            connectionState={connectionState}
            headingRef={headingRef}
            mood={mood}
            status={status}
            transcript={transcript}
          />
        ) : null}
      </div>

      <nav className="mobile-tab-bar" aria-label="Primary">
        <div role="tablist" aria-label="Vector sections">
          {mobileTabs.map((tab) => {
            const Icon = tabIcons[tab.id];
            const selected = activeTab === tab.id;
            const artifactAlert = tab.id === "artifacts" && unseenArtifact;
            return (
              <button
                className={selected ? "mobile-tab active" : "mobile-tab"}
                id={`mobile-tab-${tab.id}`}
                key={tab.id}
                type="button"
                role="tab"
                aria-controls={`mobile-panel-${tab.id}`}
                aria-selected={selected}
                aria-label={artifactAlert ? `${tab.label}, new artifact` : tab.label}
                onClick={() => selectTab(tab.id)}
              >
                <span className="mobile-tab-icon">
                  <Icon size={21} strokeWidth={selected ? 2.5 : 2} />
                  {artifactAlert ? <i aria-hidden="true" /> : null}
                </span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>
    </main>
  );
}

type TalkScreenProps = Pick<
  MobileAppShellProps,
  | "connectionState"
  | "mood"
  | "mouthShape"
  | "onConnect"
  | "onDisconnect"
  | "onSendTextPrompt"
  | "onTextPromptChange"
  | "onToggleTypeInput"
  | "showTypeInput"
  | "status"
  | "textPrompt"
> & {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
};

function TalkScreen({
  connectionState,
  headingRef,
  mood,
  mouthShape,
  onConnect,
  onDisconnect,
  onSendTextPrompt,
  onTextPromptChange,
  onToggleTypeInput,
  showTypeInput,
  status,
  textPrompt,
}: TalkScreenProps) {
  const control = useMemo(
    () => connectionControlPresentation(connectionState, mood),
    [connectionState, mood],
  );
  const connectionLabel =
    connectionState === "connected" && mood === "listening"
      ? "Connected and listening"
      : connectionState === "connected"
        ? `Connected, ${mood}`
        : connectionState;

  function handleConnectionControl() {
    if (control.action === "disconnect") onDisconnect();
    if (control.action === "connect") onConnect();
  }

  function handleInputFocus(event: React.FocusEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    window.setTimeout(() => {
      input.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 250);
  }

  return (
    <section
      className="mobile-screen mobile-talk-screen"
      id="mobile-panel-talk"
      role="tabpanel"
      aria-labelledby="mobile-tab-talk"
    >
      <h1 className="sr-only" ref={headingRef} tabIndex={-1}>
        Talk
      </h1>
      <div className="mobile-talk-stage">
        <div className={`mobile-state-pill mobile-state-${control.tone}`} aria-live="polite">
          <span className="mobile-state-dot" aria-hidden="true" />
          <strong>{connectionLabel}</strong>
        </div>

        <VectorOrb mood={mood} mouthShape={mouthShape} />

        <div className="mobile-status-copy" aria-live="polite" aria-atomic="true">
          <strong>{control.label}</strong>
          <p>{status}</p>
        </div>
      </div>

      <div className="mobile-talk-controls">
        <aside className="mobile-preview-note" aria-label="Voice preview status">
          <strong>Voice preview</strong>
          <span>Simulator-verified only; iPhone microphone and audio hardware are not yet validated.</span>
        </aside>
        <button
          className={`mobile-connect-button mobile-connect-${control.tone}`}
          type="button"
          disabled={control.disabled}
          onClick={handleConnectionControl}
          aria-label={`${control.label}. ${control.detail}`}
        >
          <span className="mobile-connect-icon" aria-hidden="true">
            {control.action === "wait" ? (
              <LoaderCircle className="mobile-spin" size={24} />
            ) : control.tone === "error" ? (
              <AlertCircle size={24} />
            ) : control.action === "disconnect" ? (
              <MicOff size={24} />
            ) : (
              <Mic size={24} />
            )}
          </span>
          <span>
            <strong>{control.label}</strong>
            <small>{control.detail}</small>
          </span>
        </button>

        {showTypeInput ? (
          <form
            className="mobile-composer"
            aria-label="Type a message to Vector"
            onSubmit={(event) => {
              event.preventDefault();
              onSendTextPrompt();
            }}
          >
            <label htmlFor="mobile-vector-prompt">Message</label>
            <div>
              <input
                id="mobile-vector-prompt"
                value={textPrompt}
                onChange={(event) => onTextPromptChange(event.target.value)}
                onFocus={handleInputFocus}
                autoFocus
                enterKeyHint="send"
                placeholder="Type to Vector"
              />
              <button
                type="submit"
                aria-label={
                  connectionState === "connected"
                    ? "Send message"
                    : "Connect a conversation before sending a message"
                }
                disabled={connectionState !== "connected" || !textPrompt.trim()}
              >
                <Send size={20} />
              </button>
              <button type="button" aria-label="Close message field" onClick={onToggleTypeInput}>
                <X size={20} />
              </button>
            </div>
          </form>
        ) : (
          <button className="mobile-type-button" type="button" onClick={onToggleTypeInput}>
            <Keyboard size={20} aria-hidden="true" />
            <span>Type a message</span>
          </button>
        )}
      </div>
    </section>
  );
}

function ActivityScreen({
  connectionState,
  headingRef,
  mood,
  status,
  transcript,
}: Pick<MobileAppShellProps, "connectionState" | "mood" | "status" | "transcript"> & {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <section
      className="mobile-screen mobile-activity-screen"
      id="mobile-panel-activity"
      role="tabpanel"
      aria-labelledby="mobile-tab-activity"
    >
      <header className="mobile-screen-heading">
        <div>
          <span className="mobile-eyebrow">Local session</span>
          <h1 ref={headingRef} tabIndex={-1}>
            Activity
          </h1>
        </div>
        <Activity size={23} aria-hidden="true" />
      </header>

      <section className="mobile-session-summary" aria-label="Session status">
        <div>
          <span>Connection</span>
          <strong>{connectionState}</strong>
        </div>
        <div>
          <span>Assistant</span>
          <strong>{mood}</strong>
        </div>
        <p aria-live="polite">{status}</p>
      </section>

      <section className="mobile-activity-list" aria-label="Conversation activity">
        <header>
          <h2>Recent activity</h2>
          <span>{transcript.length} events</span>
        </header>
        <div>
          {transcript.map((entry) => (
            <article className={`mobile-entry mobile-entry-${entry.role}`} key={entry.id}>
              <header>
                <strong>{entry.role === "assistant" ? "Vector" : entry.role}</strong>
                <time>{entry.at}</time>
              </header>
              <p>{entry.text}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}
