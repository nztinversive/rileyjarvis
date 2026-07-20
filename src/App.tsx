import { useEffect, useRef, useState, type CSSProperties } from "react";
import { BrainCircuit, Expand, History, Keyboard, Mic, MicOff, MonitorCog, Moon, PanelRight, Send, Sun, Zap } from "lucide-react";
import { ArtifactPanel } from "./components/ArtifactPanel";
import { VectorOrb } from "./components/VectorOrb";
import { newEntry, VectorRealtimeClient, type MouthShape, type TranscriptEntry, type VectorConnectionState, type VectorMood } from "./lib/realtime";
import { getVectorPlatform, type RemoteCodexLifecycleEvent, type VectorArtifact } from "./platform";

type VectorMode = "display" | "computer";
type VectorTheme = "day" | "night";
const autoSleepMs = 5 * 60 * 1000;
const autoSleepMessage = "Went to standby after 5 minutes of silence. Connect to resume.";
const missingElectronBridgeMessage = "Open Vector in the Electron app window to use voice and local tools. The browser preview cannot access Electron's secure local bridge.";
const vectorPlatform = getVectorPlatform();

function initialTheme(): VectorTheme {
  try {
    const saved = window.localStorage.getItem("vector-theme");
    if (saved === "day" || saved === "night") return saved;
  } catch {
    // localStorage can be unavailable; fall through to time-based default.
  }
  const hour = new Date().getHours();
  return hour >= 19 || hour < 7 ? "night" : "day";
}

export default function App() {
  const platformAvailable = Boolean(vectorPlatform);
  const [connectionState, setConnectionState] = useState<VectorConnectionState>("idle");
  const [mood, setMood] = useState<VectorMood>("idle");
  const [mode, setMode] = useState<VectorMode>("display");
  const [artifact, setArtifact] = useState<VectorArtifact | null>(null);
  const [artifactVisible, setArtifactVisible] = useState(true);
  const [artifactFullscreen, setArtifactFullscreen] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showTypeInput, setShowTypeInput] = useState(false);
  const [mouthShape, setMouthShape] = useState<MouthShape>({ open: 0, width: 0.18, round: 0, teeth: 0 });
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([
    newEntry("system", platformAvailable ? "Vector is ready. Connect voice, then talk naturally." : missingElectronBridgeMessage),
  ]);
  const [status, setStatus] = useState(platformAvailable ? "Idle" : missingElectronBridgeMessage);
  const [textPrompt, setTextPrompt] = useState("");
  const [uptime, setUptime] = useState("STANDBY");
  const [theme, setTheme] = useState<VectorTheme>(initialTheme);
  const clientRef = useRef<VectorRealtimeClient | null>(null);
  const artifactKeyRef = useRef("");
  const lastActivityRef = useRef(Date.now());

  const isConnected = connectionState === "connected";

  useEffect(() => {
    if (!isConnected) return;
    const busy = mood === "speaking" || mood === "thinking" || mood === "working";
    const timer = window.setInterval(() => {
      if (!busy && Date.now() - lastActivityRef.current > autoSleepMs) {
        disconnect();
        setStatus(autoSleepMessage);
        setTranscript((items) => [newEntry("system", autoSleepMessage), ...items].slice(0, 80));
      }
    }, 15000);
    return () => window.clearInterval(timer);
  }, [isConnected, mood]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "day" ? "night" : "day";
      try {
        window.localStorage.setItem("vector-theme", next);
      } catch {
        // Persistence is best-effort.
      }
      return next;
    });
  }

  function announceArtifact(nextArtifact: VectorArtifact) {
    const key = `${nextArtifact.kind}:${nextArtifact.title}`;
    if (key !== artifactKeyRef.current) {
      artifactKeyRef.current = key;
      playArrivalSound();
    }
  }

  useEffect(() => {
    if (!isConnected) {
      setUptime("STANDBY");
      return;
    }
    const startedAt = Date.now();
    const tick = () => {
      const seconds = Math.floor((Date.now() - startedAt) / 1000);
      const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
      const ss = String(seconds % 60).padStart(2, "0");
      setUptime(`${mm}:${ss}`);
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [isConnected]);
  const statusTone = connectionState === "error" || mood === "error" ? "blocked" : mood === "working" || mood === "thinking" ? "active" : "idle";

  useEffect(() => {
    if (!vectorPlatform?.remoteCodex) return;
    return vectorPlatform.remoteCodex.subscribeToLifecycle((event: RemoteCodexLifecycleEvent) => {
      announceArtifact(event.artifact);
      setArtifact(event.artifact);
      setArtifactVisible(true);
      const taskStatus = event.task.status === "needs_input" ? "needs input" : event.task.status.replace("_", " ");
      setStatus(`${event.task.project}: ${taskStatus}. ${event.task.lastAction || ""}`.trim());
      if (event.announcement) {
        setTranscript((items) => [newEntry("system", event.announcement), ...items].slice(0, 80));
        clientRef.current?.announceRemoteCodexEvent(event);
      }
    });
  }, []);

  function reportPlatformMissing() {
    setConnectionState("error");
    setMood("error");
    setStatus(missingElectronBridgeMessage);
    setTranscript((items) => [newEntry("system", missingElectronBridgeMessage), ...items].slice(0, 80));
  }

  async function connect() {
    if (!vectorPlatform) {
      reportPlatformMissing();
      return;
    }
    const client = new VectorRealtimeClient(vectorPlatform, {
      onConnectionState: (state) => {
        setConnectionState(state);
        if (state === "connected") {
          lastActivityRef.current = Date.now();
          playConnectSound();
        }
      },
      onMood: (nextMood) => {
        if (nextMood !== "idle") lastActivityRef.current = Date.now();
        setMood(nextMood);
      },
      onMouthShape: setMouthShape,
      onTranscript: (entry) => {
        lastActivityRef.current = Date.now();
        setTranscript((items) => [entry, ...items].slice(0, 80));
      },
      onArtifact: (nextArtifact) => {
        announceArtifact(nextArtifact);
        setArtifact(nextArtifact);
        setArtifactVisible(true);
        if (nextArtifact.fullscreen) setArtifactFullscreen(true);
      },
      onMode: (nextMode) => {
        setMode(nextMode);
        if (nextMode === "computer") {
          setArtifactVisible(false);
          setArtifactFullscreen(false);
          setShowLog(false);
          setShowTypeInput(false);
        } else {
          setArtifactVisible(true);
        }
      },
      onStatus: (message) => {
        setStatus(message);
        setTranscript((items) => [newEntry("system", message), ...items].slice(0, 80));
      },
      onThumbnailReady: playThumbnailReadySound,
    });
    clientRef.current = client;
    await client.connect();
  }

  function disconnect() {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setStatus("Disconnected");
    playDisconnectSound();
  }

  async function switchMode(nextMode: VectorMode) {
    if (!vectorPlatform) {
      reportPlatformMissing();
      return;
    }
    setMode(nextMode);
    const result = await vectorPlatform.executeTool({ name: "set_mode", arguments: { mode: nextMode } });
    if (result.artifact) setArtifact(result.artifact);
    if (nextMode === "computer") {
      setArtifactVisible(false);
      setArtifactFullscreen(false);
      setShowLog(false);
      setShowTypeInput(false);
    } else {
      setArtifactVisible(true);
    }
    setTranscript((items) => [newEntry("system", `Mode switched to ${nextMode}.`), ...items].slice(0, 80));
  }

  function sendTextPrompt() {
    const trimmed = textPrompt.trim();
    if (!trimmed) return;
    lastActivityRef.current = Date.now();
    clientRef.current?.sendText(trimmed);
    setTextPrompt("");
    setShowTypeInput(false);
  }

  if (mode === "computer") {
    return (
      <main className="app-shell app-shell-mini">
        <section className="mini-companion" aria-label="Vector computer use mini mode">
          <VectorOrb mood={mood} mouthShape={mouthShape} />
          <button
            className="mini-restore-button"
            onClick={() => void switchMode("display")}
            aria-label="Return to full Vector window"
            title="Return to full Vector window"
          >
            <Expand size={14} />
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="window-drag-strip" aria-hidden="true" />
      <div className="window-drag-left-zone" aria-hidden="true" />
      <section className="companion-window">
        <header className="hub-bar">
          <div className="hub-brand">
            <span className="hub-badge" aria-hidden="true">
              <Zap size={13} strokeWidth={2.6} />
            </span>
            <div>
              <span>Vector Command Hub</span>
              <small>Realtime voice operator</small>
            </div>
          </div>
          <p className={`hub-state hub-state-${statusTone}`}>{mood}</p>
        </header>

        <div className="hero-plate">
          <span className={`hero-tag hero-tag-${statusTone}`}>
            <i aria-hidden="true" />
            Unit VCT-01
          </span>
          <h1 className="hero-name">
            <span className="hero-letters" aria-label="Vector">
              {"Vector".split("").map((letter, index) => (
                <span key={index} aria-hidden="true" style={{ "--l": index } as CSSProperties}>
                  {letter}
                </span>
              ))}
            </span>
            <b aria-hidden="true">◆</b>
          </h1>
          <p className="hero-role">The Desktop Operator</p>
        </div>

        <section className="orb-stage">
          <VectorOrb mood={mood} mouthShape={mouthShape} />
          <div className="orb-plinth" aria-hidden="true" style={{ "--audio-open": mouthShape.open.toFixed(3) } as CSSProperties} />
          <div className="orb-status">
            <span>{connectionState}</span>
            <p>{status}</p>
            <dl className="status-stats">
              <div>
                <dt>Uptime</dt>
                <dd>{uptime}</dd>
              </div>
              <div>
                <dt>Mode</dt>
                <dd>{mode}</dd>
              </div>
              <div>
                <dt>Events</dt>
                <dd>{transcript.length}</dd>
              </div>
              <div>
                <dt>Model</dt>
                <dd>RT-2.1M</dd>
              </div>
            </dl>
          </div>
        </section>

        <footer className="bottom-console">
          {showTypeInput ? (
            <section className="prompt-box">
              <input
                value={textPrompt}
                onChange={(event) => setTextPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") sendTextPrompt();
                }}
                autoFocus
                placeholder="Type to Vector..."
              />
              <button onClick={sendTextPrompt} aria-label="Send typed prompt" title="Send typed prompt">
                <Send size={15} />
              </button>
            </section>
          ) : null}

          <section className="control-dock">
            <button
              className={isConnected ? "deploy-button deploy-live" : "deploy-button"}
              onClick={isConnected ? disconnect : connect}
              disabled={connectionState === "connecting"}
              aria-label={isConnected ? "Disconnect voice" : "Connect voice"}
              title={isConnected ? "Disconnect voice" : "Connect voice"}
            >
              {isConnected ? <MicOff size={15} strokeWidth={2.4} /> : <Mic size={15} strokeWidth={2.4} />}
              <span>{connectionState === "connecting" ? "Linking" : isConnected ? "Disconnect" : "Connect"}</span>
              <em aria-hidden="true">{isConnected ? "■" : "»"}</em>
            </button>
            <div className="ability-row">
              <button
                className={showTypeInput ? "ability-card active" : "ability-card"}
                onClick={() => setShowTypeInput((value) => !value)}
                aria-label="Type to Vector"
                title="Type to Vector"
              >
                <span className="ability-icon">
                  <Keyboard size={15} />
                </span>
                <small>Type</small>
              </button>
              <button
                className={mode === "display" ? "ability-card active" : "ability-card"}
                onClick={() => void switchMode("display")}
                aria-label="Display mode"
                title="Display mode"
              >
                <span className="ability-icon">
                  <PanelRight size={15} />
                </span>
                <small>Display</small>
              </button>
              <button
                className="ability-card danger"
                onClick={() => void switchMode("computer")}
                aria-label="Computer use mode"
                title="Computer use mode"
              >
                <span className="ability-icon">
                  <MonitorCog size={15} />
                </span>
                <small>Computer</small>
              </button>
              <button
                className={artifactVisible ? "ability-card active" : "ability-card"}
                onClick={() => setArtifactVisible((value) => !value)}
                aria-label="Toggle artifacts"
                title="Toggle artifacts"
              >
                <span className="ability-icon">
                  <BrainCircuit size={15} />
                </span>
                <small>Artifacts</small>
              </button>
              <button
                className={showLog ? "ability-card active" : "ability-card"}
                onClick={() => setShowLog((value) => !value)}
                aria-label="Toggle live log"
                title="Toggle live log"
              >
                <span className="ability-icon">
                  <History size={15} />
                </span>
                <small>Log</small>
              </button>
              <button
                className="ability-card"
                onClick={toggleTheme}
                aria-label={theme === "day" ? "Switch to night mode" : "Switch to day mode"}
                title={theme === "day" ? "Switch to night mode" : "Switch to day mode"}
              >
                <span className="ability-icon">{theme === "day" ? <Moon size={15} /> : <Sun size={15} />}</span>
                <small>{theme === "day" ? "Night" : "Day"}</small>
              </button>
            </div>
          </section>
        </footer>

        {showLog ? (
          <section className="transcript">
            <div className="section-title">
              <span>Live Log</span>
              <small>{transcript.length} events</small>
            </div>
            <div className="transcript-list">
              {transcript.map((entry) => (
                <article className={`entry entry-${entry.role}`} key={entry.id}>
                  <div>
                    <strong>{entry.role === "assistant" ? "Vector" : entry.role}</strong>
                    <time>{entry.at}</time>
                  </div>
                  <p>{entry.text}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </section>

      <ArtifactPanel
        artifact={artifact}
        visible={artifactVisible}
        fullscreen={artifactFullscreen}
        onToggleVisible={() => setArtifactVisible((value) => !value)}
        onToggleFullscreen={() => setArtifactFullscreen((value) => !value)}
      />
    </main>
  );
}

function playTone(freqStart: number, freqEnd: number, duration: number, volume: number, type: OscillatorType = "sine") {
  try {
    const audio = new window.AudioContext();
    const gain = audio.createGain();
    const osc = audio.createOscillator();

    osc.type = type;
    osc.frequency.setValueAtTime(freqStart, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freqEnd, audio.currentTime + duration * 0.6);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(volume, audio.currentTime + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + duration);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + duration + 0.02);
    window.setTimeout(() => void audio.close(), (duration + 0.12) * 1000);
  } catch {
    // Audio cues are optional; ignore browsers that block short sounds.
  }
}

function playConnectSound() {
  playTone(520, 880, 0.14, 0.03);
}

function playDisconnectSound() {
  playTone(660, 330, 0.16, 0.025);
}

function playArrivalSound() {
  playTone(980, 1240, 0.09, 0.018, "triangle");
}

function playThumbnailReadySound() {
  try {
    const AudioContextClass = window.AudioContext;
    const audio = new AudioContextClass();
    const gain = audio.createGain();
    const osc = audio.createOscillator();

    osc.type = "sine";
    osc.frequency.setValueAtTime(880, audio.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, audio.currentTime + 0.08);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.035, audio.currentTime + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.13);

    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 0.14);
    window.setTimeout(() => void audio.close(), 220);
  } catch {
    // Audio cues are optional; ignore browsers that block short sounds.
  }
}
