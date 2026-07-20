import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Zap } from "lucide-react";
import mermaid from "mermaid";
import type { VectorArtifact } from "../platform";

type ArtifactPanelProps = {
  artifact: VectorArtifact | null;
  visible: boolean;
  fullscreen: boolean;
  onToggleVisible: () => void;
  onToggleFullscreen: () => void;
  onOpenExternalUrl?: (url: string) => Promise<void>;
};

type MermaidState = {
  svg: string;
  error: string | null;
  source: string;
};

type NoteCard = {
  id?: string;
  text?: string;
  tags?: string[];
  createdAt?: string;
};

type ThumbnailBoardData = {
  view?: "grid" | "selected";
  selectedId?: string | null;
  references?: Array<{ id?: string; label?: string; path?: string }>;
  page?: {
    page?: number;
    pageSize?: number;
    totalImages?: number;
    totalPages?: number;
    nextNumber?: number;
  };
  images?: Array<{
    id?: string;
    number?: number;
    src?: string;
    prompt?: string;
    type?: string;
    status?: "loading" | string;
    loadingLabel?: string;
    createdAt?: string;
    selected?: boolean;
  }>;
};

type ProjectCockpitData = {
  state?: "OK" | "WARN" | "BLOCKED" | string;
  project?: string;
  path?: string;
  generatedAt?: string;
  sections?: {
    state?: string[];
    dirtyWorktree?: string[];
    remoteDrift?: string[];
    docsVision?: string[];
    verification?: string[];
    blockers?: string[];
    nextAction?: string[];
  };
  git?: {
    branch?: string;
    head?: string;
    upstream?: string;
    dirtyCount?: number;
    ahead?: number;
    behind?: number;
  };
  package?: {
    manager?: string;
    scripts?: string[];
    verificationCommands?: string[];
  };
};

mermaid.initialize({
  startOnLoad: false,
  theme: "neutral",
  securityLevel: "strict",
});

export function ArtifactPanel({ artifact, visible, fullscreen, onToggleVisible, onToggleFullscreen, onOpenExternalUrl }: ArtifactPanelProps) {
  const [mermaidState, setMermaidState] = useState<MermaidState>({ svg: "", error: null, source: "" });
  const rawId = useId();
  const mermaidId = useMemo(() => `mermaid-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`, [rawId]);

  useEffect(() => {
    let cancelled = false;
    if (artifact?.kind !== "mermaid") {
      setMermaidState({ svg: "", error: null, source: "" });
      return;
    }

    const source = normalizeMermaidSource(artifact.content, artifact.title);
    mermaid
      .render(mermaidId, source)
      .then((result) => {
        if (!cancelled) setMermaidState({ svg: result.svg, error: null, source });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const fallback = fallbackMermaidSource(artifact.title);
        mermaid
          .render(`${mermaidId}-fallback`, fallback)
          .then((result) => {
            if (!cancelled) setMermaidState({ svg: result.svg, error: message, source });
          })
          .catch(() => {
            if (!cancelled) setMermaidState({ svg: "", error: message, source });
          });
      });

    return () => {
      cancelled = true;
    };
  }, [artifact, mermaidId]);

  if (!visible) {
    return (
      <button className="artifact-tab" onClick={onToggleVisible}>
        Show Artifacts
      </button>
    );
  }

  return (
    <aside className={`artifact-panel ${fullscreen ? "artifact-fullscreen" : ""}`}>
      <header className="artifact-header">
        <div>
          <span className="eyebrow">Artifacts</span>
          <h2>{artifact?.title || "Ready"}</h2>
          <small className="artifact-serial">VCT-01 // LOCAL OPERATOR // 127.0.0.1</small>
        </div>
        <div className="artifact-actions">
          <button onClick={onToggleFullscreen}>{fullscreen ? "Window" : "Fullscreen"}</button>
          <button onClick={onToggleVisible}>Hide</button>
        </div>
      </header>
      <div className="artifact-body">
        {artifact ? (
          <div className="artifact-arrival" key={`${artifact.kind}:${artifact.title}:${artifact.content.length}`}>
            {renderArtifact(artifact, mermaidState, onOpenExternalUrl)}
          </div>
        ) : (
          <EmptyArtifact />
        )}
      </div>
    </aside>
  );
}

function EmptyArtifact() {
  return (
    <div className="empty-artifact">
      <div className="empty-artifact-grid" aria-hidden="true" />
      <div className="empty-artifact-inner">
        <span className="empty-artifact-chip" aria-hidden="true">
          <Zap size={16} strokeWidth={2.4} />
        </span>
        <strong className="empty-artifact-code">Awaiting signal</strong>
        <p>Ask Vector to show web results, charts, notes, records, code, images, or progress here.</p>
      </div>
    </div>
  );
}

function renderArtifact(
  artifact: VectorArtifact,
  mermaidState: MermaidState,
  onOpenExternalUrl?: (url: string) => Promise<void>,
) {
  if (artifact.kind === "table") {
    return <JsonTable content={artifact.content} />;
  }

  if (artifact.kind === "notes") {
    return <NotesGrid content={artifact.content} />;
  }

  if (artifact.kind === "mermaid") {
    return (
      <div className="mermaid-stack">
        <div className="mermaid-output" dangerouslySetInnerHTML={{ __html: mermaidState.svg }} />
        {mermaidState.error ? (
          <details className="mermaid-repair">
            <summary>Vector repaired this chart so it would still display.</summary>
            <p>The original Mermaid syntax did not parse, so a safe fallback chart was shown.</p>
            <pre>{mermaidState.source}</pre>
          </details>
        ) : null}
      </div>
    );
  }

  if (artifact.kind === "image") {
    const src = imageSource(artifact.content);
    return <img className="artifact-image" src={src} alt={artifact.title} />;
  }

  if (artifact.kind === "imageLoading") {
    return (
      <div className="image-loading-artifact">
        <div className="image-loading-frame">
          <div className="image-loading-grid" />
          <div className="image-loading-orb" />
          <div className="image-loading-scan" />
        </div>
        <div className="image-loading-copy">
          <span>Generating image</span>
          <p>{artifact.content}</p>
        </div>
      </div>
    );
  }

  if (artifact.kind === "thumbnailBoard") {
    return <ThumbnailBoard content={artifact.content} />;
  }

  if (artifact.kind === "projectCockpit") {
    return <ProjectCockpit content={artifact.content} />;
  }

  if (artifact.kind === "codexReview") {
    return <CodexReview content={artifact.content} />;
  }

  if (artifact.kind === "code") {
    return (
      <pre className="code-artifact">
        <code>{artifact.content}</code>
      </pre>
    );
  }

  if (artifact.kind === "markdown") {
    return <MarkdownArtifact content={artifact.content} onOpenExternalUrl={onOpenExternalUrl} />;
  }

  if (artifact.kind === "progress") {
    return (
      <div className="progress-card">
        <div className="progress-pulse" />
        <p>{artifact.content}</p>
      </div>
    );
  }

  return <pre className="text-artifact">{artifact.content}</pre>;
}

function imageSource(content: string) {
  if (/^(https?:|file:|data:)/i.test(content)) return content;
  const normalized = content.replace(/\\/g, "/");
  const prefix = /^[A-Za-z]:\//.test(normalized) ? "file:///" : "file://";
  return encodeURI(`${prefix}${normalized}`);
}

function ThumbnailBoard({ content }: { content: string }) {
  const board = parseThumbnailBoard(content);
  if (!board) return <pre className="text-artifact">{content}</pre>;

  const images = board.images || [];
  const selected = images.find((image) => image.selected) || images.find((image) => image.id === board.selectedId) || null;
  const page = board.page || {};

  if (board.view === "selected" && selected) {
    return (
      <section className="thumbnail-selected">
        <div className="thumbnail-selected-frame">
          <img src={selected.src} alt={`Thumbnail ${selected.number || ""}`} />
          <span className="thumbnail-number-large">{selected.number}</span>
        </div>
        <div className="thumbnail-selected-copy">
          <span>{selected.type || "thumbnail"}</span>
          <p>{selected.prompt || "Selected thumbnail"}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="thumbnail-board">
      <header className="thumbnail-board-meta">
        <div>
          <span>{page.totalImages ?? images.length} thumbnails</span>
          <p>{(board.references || []).length} Noah reference image{(board.references || []).length === 1 ? "" : "s"} loaded</p>
        </div>
        <small>Page {page.page || 1}/{page.totalPages || 1} · next #{page.nextNumber || "?"}</small>
      </header>
      {images.length > 0 ? (
        <div className="thumbnail-grid">
          {images.map((image) => (
            <article className={image.status === "loading" ? "thumbnail-card thumbnail-card-loading" : "thumbnail-card"} key={image.id || image.number}>
              {image.status === "loading" ? (
                <div className="thumbnail-loading-wrap">
                  <div className="thumbnail-loading-grid" />
                  <div className="thumbnail-loading-orb" />
                  <span>{image.number}</span>
                </div>
              ) : (
                <div className="thumbnail-image-wrap">
                  <img src={image.src} alt={`Thumbnail ${image.number || ""}`} />
                  <span>{image.number}</span>
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        <div className="thumbnail-empty">
          <p>Noah reference image loaded. Ask Vector: “Generate a 16:9 thumbnail of me about Cursor agents.”</p>
        </div>
      )}
    </section>
  );
}

function ProjectCockpit({ content }: { content: string }) {
  const report = parseProjectCockpit(content);
  if (!report) return <pre className="text-artifact">{content}</pre>;

  const state = report.state || "WARN";
  const sections = report.sections || {};
  const sectionItems = [
    ["State", sections.state || []],
    ["Dirty Worktree", sections.dirtyWorktree || []],
    ["Remote Drift", sections.remoteDrift || []],
    ["Docs / Vision", sections.docsVision || []],
    ["Verification", sections.verification || []],
    ["Blockers", sections.blockers || []],
    ["Next Action", sections.nextAction || []],
  ] as const;

  return (
    <section className="project-cockpit">
      <header className="project-cockpit-hero">
        <div>
          <span className={`project-state project-state-${state.toLowerCase()}`}>{state}</span>
          <h3>{report.project || "Project"}</h3>
          <p>{report.path || "No path reported"}</p>
        </div>
        <dl>
          <div className="cockpit-cell-wide">
            <dt>Branch</dt>
            <dd>{report.git?.branch || "unknown"}</dd>
            <small>{report.git?.head || "no head"}</small>
          </div>
          <div>
            <dt>Dirty</dt>
            <dd className="cockpit-num">{report.git?.dirtyCount ?? 0}</dd>
          </div>
          <div>
            <dt>Ahead</dt>
            <dd className="cockpit-num">{report.git?.ahead ?? 0}</dd>
          </div>
          <div>
            <dt>Behind</dt>
            <dd className="cockpit-num">{report.git?.behind ?? 0}</dd>
          </div>
        </dl>
      </header>

      <div className="project-cockpit-grid">
        {sectionItems.map(([title, items]) => (
          <article className={title === "Blockers" && items.length > 0 ? "project-section project-section-blocked" : "project-section"} key={title}>
            <h4>{title}</h4>
            {items.length > 0 ? (
              <ul>
                {items.map((item, index) => (
                  <li key={`${title}-${index}`}>{item}</li>
                ))}
              </ul>
            ) : (
              <p>No issues reported.</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

type CodexReviewData = {
  project?: string;
  target?: string;
  status?: string;
  requested?: string;
  branch?: string;
  head?: string;
  tracking?: string;
  filesChanged?: number | null;
  insertions?: number;
  deletions?: number;
  statText?: string;
  statusLines?: string[];
  commits?: string[];
  diff?: string;
  reviewError?: string;
  outcome?: string;
  changedFiles?: string;
  verification?: string;
  gitActions?: string;
  remainingIssues?: string;
};

function CodexReview({ content }: { content: string }) {
  const review = parseCodexReview(content);
  if (!review) return <pre className="text-artifact">{content}</pre>;

  const reportSections = [
    ["Outcome", review.outcome],
    ["Verification", review.verification],
    ["Git actions", review.gitActions],
    ["Remaining issues", review.remainingIssues],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return (
    <section className="codex-review">
      <header className="project-cockpit-hero">
        <div>
          <span className={review.status === "completed" ? "project-state" : "project-state project-state-warn"}>
            {review.status || "unknown"}
          </span>
          <h3>{review.project || "Codex task"}</h3>
          <p>{review.requested || "No request recorded"}</p>
        </div>
        <dl>
          <div className="cockpit-cell-wide">
            <dt>Branch</dt>
            <dd>{review.branch || "unknown"}</dd>
            <small>
              {review.head || "no head"}
              {review.tracking ? ` · ${review.tracking}` : ""}
            </small>
          </div>
          <div>
            <dt>Files</dt>
            <dd className="cockpit-num">{review.filesChanged ?? "—"}</dd>
          </div>
          <div>
            <dt>Added</dt>
            <dd className="cockpit-num">+{review.insertions ?? 0}</dd>
          </div>
          <div>
            <dt>Removed</dt>
            <dd className="cockpit-num">−{review.deletions ?? 0}</dd>
          </div>
        </dl>
      </header>

      {review.reviewError ? (
        <article className="project-section project-section-blocked">
          <h4>Review fetch failed</h4>
          <p>{review.reviewError}</p>
        </article>
      ) : null}

      {reportSections.length > 0 ? (
        <div className="project-cockpit-grid">
          {reportSections.map(([title, body]) => (
            <article
              className={title === "Remaining issues" ? "project-section project-section-blocked" : "project-section"}
              key={title}
            >
              <h4>{title}</h4>
              <p className="codex-review-body">{body}</p>
            </article>
          ))}
        </div>
      ) : null}

      {review.commits && review.commits.length > 0 ? (
        <article className="project-section">
          <h4>Recent commits</h4>
          <ul>
            {review.commits.map((line, index) => (
              <li className="codex-review-mono" key={index}>
                {line}
              </li>
            ))}
          </ul>
        </article>
      ) : null}

      {review.diff ? (
        <article className="project-section codex-diff-card">
          <h4>Diff{review.statText ? ` · ${review.statText.trim().split("\n").at(-1)}` : ""}</h4>
          <pre className="codex-diff">
            <code>{renderDiff(review.diff)}</code>
          </pre>
        </article>
      ) : review.statusLines && review.statusLines.length > 0 ? (
        <article className="project-section">
          <h4>Worktree status</h4>
          <ul>
            {review.statusLines.map((line, index) => (
              <li className="codex-review-mono" key={index}>
                {line}
              </li>
            ))}
          </ul>
        </article>
      ) : null}
    </section>
  );
}

function renderDiff(diff: string) {
  return diff.split("\n").map((line, index) => {
    const tone = line.startsWith("+++") || line.startsWith("---")
      ? "codex-diff-file"
      : line.startsWith("@@")
        ? "codex-diff-hunk"
        : line.startsWith("+")
          ? "codex-diff-add"
          : line.startsWith("-")
            ? "codex-diff-del"
            : line.startsWith("diff ")
              ? "codex-diff-file"
              : "";
    return (
      <span className={tone || undefined} key={index}>
        {line}
        {"\n"}
      </span>
    );
  });
}

function parseCodexReview(content: string): CodexReviewData | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== "object") return null;
    return value as CodexReviewData;
  } catch {
    return null;
  }
}

function parseProjectCockpit(content: string): ProjectCockpitData | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== "object") return null;
    return value as ProjectCockpitData;
  } catch {
    return null;
  }
}

function parseThumbnailBoard(content: string): ThumbnailBoardData | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (!value || typeof value !== "object") return null;
    return value as ThumbnailBoardData;
  } catch {
    return null;
  }
}

function MarkdownArtifact({
  content,
  onOpenExternalUrl,
}: {
  content: string;
  onOpenExternalUrl?: (url: string) => Promise<void>;
}) {
  const [visibleContent, setVisibleContent] = useState("");

  useEffect(() => {
    setVisibleContent("");
    let index = 0;
    const step = Math.max(8, Math.ceil(content.length / 180));
    const timer = window.setInterval(() => {
      index = Math.min(content.length, index + step);
      setVisibleContent(content.slice(0, index));
      if (index >= content.length) window.clearInterval(timer);
    }, 14);

    return () => window.clearInterval(timer);
  }, [content]);

  return (
    <div className="markdown-artifact">
      <div className="stream-line" />
      {renderMarkdown(visibleContent, onOpenExternalUrl)}
    </div>
  );
}

function renderMarkdown(content: string, onOpenExternalUrl?: (url: string) => Promise<void>) {
  return content.split("\n").map((line, index) => {
    if (line.startsWith("# ")) {
      return <h1 key={index}>{renderInline(line.slice(2), onOpenExternalUrl)}</h1>;
    }
    if (line.startsWith("## ")) {
      return <h2 key={index}>{renderInline(line.slice(3), onOpenExternalUrl)}</h2>;
    }
    if (line.startsWith("### ")) {
      return <h3 key={index}>{renderInline(line.slice(4), onOpenExternalUrl)}</h3>;
    }
    const bullet = line.match(/^(\s*)[-*] (.*)$/);
    if (bullet) {
      const depth = Math.min(3, Math.floor(bullet[1].length / 2));
      return (
        <li key={index} style={depth > 0 ? { marginLeft: `${18 + depth * 16}px` } : undefined}>
          {renderInline(bullet[2], onOpenExternalUrl)}
        </li>
      );
    }
    const numbered = line.match(/^\s*(\d+)\. (.*)$/);
    if (numbered) {
      return (
        <li className="markdown-numbered" key={index} data-number={`${numbered[1]}.`}>
          {renderInline(numbered[2], onOpenExternalUrl)}
        </li>
      );
    }
    if (!line.trim()) {
      return <div className="markdown-gap" key={index} />;
    }
    return <p key={index}>{renderInline(line, onOpenExternalUrl)}</p>;
  });
}

function renderInline(text: string, onOpenExternalUrl?: (url: string) => Promise<void>) {
  const parts: ReactNode[] = [];
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const url = match[2];
    parts.push(
      <a
        href={url}
        key={`${url}-${match.index}`}
        target="_blank"
        rel="noreferrer"
        onClick={
          onOpenExternalUrl
            ? (event) => {
                event.preventDefault();
                void onOpenExternalUrl(url).catch(() => undefined);
              }
            : undefined
        }
      >
        {match[1]}
      </a>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

function NotesGrid({ content }: { content: string }) {
  const notes = parseNotes(content);
  if (notes.length === 0) return <pre className="text-artifact">{content}</pre>;

  return (
    <div className="notes-grid">
      {notes.map((note, index) => (
        <article className="note-card" key={note.id || index}>
          <p>{note.text || "Untitled note"}</p>
          <footer>
            <span>{formatDate(note.createdAt)}</span>
            {note.tags && note.tags.length > 0 ? <small>{note.tags.map((tag) => `#${tag}`).join(" ")}</small> : null}
          </footer>
        </article>
      ))}
    </div>
  );
}

function parseNotes(content: string): NoteCard[] {
  try {
    const value = JSON.parse(content) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((note): note is NoteCard => note !== null && typeof note === "object");
  } catch {
    return [];
  }
}

function formatDate(value: string | undefined): string {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function normalizeMermaidSource(content: string, title: string): string {
  const stripped = content
    .replace(/```mermaid/gi, "")
    .replace(/```/g, "")
    .replace(/\r/g, "")
    .trim();

  if (!stripped) return fallbackMermaidSource(title);

  const lines = stripped
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, "-"));

  const first = lines[0] || "";
  const hasHeader = /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/i.test(first);
  return hasHeader ? lines.join("\n") : `flowchart TD\n${lines.join("\n")}`;
}

function fallbackMermaidSource(title: string): string {
  const safeTitle = title.replace(/["<>]/g, "") || "Chart";
  return `flowchart TD\n  A["${safeTitle}"] --> B["Chart syntax issue"]\n  B --> C["Fallback displayed"]`;
}

function JsonTable({ content }: { content: string }) {
  const parsed = parseRows(content);
  if (!parsed) return <pre className="text-artifact">{content}</pre>;

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const keys = Array.from(
    rows.reduce<Set<string>>((set, row) => {
      Object.keys(row).forEach((key) => set.add(key));
      return set;
    }, new Set()),
  );

  if (rows.length === 0 || keys.length === 0) {
    return <pre className="text-artifact">{content}</pre>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{keys.map((key) => <th key={key}>{key}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.id || index}`}>
              {keys.map((key) => (
                <td key={key}>{formatCell(row[key])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseRows(content: string): Array<Record<string, unknown>> | Record<string, unknown> | null {
  try {
    const value = JSON.parse(content) as unknown;
    if (Array.isArray(value) && value.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      return value as Array<Record<string, unknown>>;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
