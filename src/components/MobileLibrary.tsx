import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { BookOpen, Database, Download, FileText, Library, Pencil, Plus, RefreshCw, Share2, Trash2 } from "lucide-react";
import {
  artifactSharePayload,
  emptyMobileStore,
  mobileDataLimits,
  mobileLibraryReducer,
  recordCollectionNames,
  recordMatchesSearch,
  savedItemSharePayload,
  stableJSONStringify,
  validateSavableArtifact,
  type VectorMobileNote,
  type VectorMobileRecord,
  type VectorSavedArtifact,
} from "../mobile/data";
import type { MobileDataCapability, NativeShareCapability, VectorArtifact } from "../platform";
import { ArtifactPanel } from "./ArtifactPanel";

type LibrarySection = "current" | "saved" | "notes" | "records";

type MobileLibraryProps = {
  artifact: VectorArtifact | null;
  mobileData: MobileDataCapability;
  nativeShare?: NativeShareCapability;
  onOpenExternalUrl?: (url: string) => Promise<void>;
};

const sections: Array<{ id: LibrarySection; label: string; icon: typeof FileText }> = [
  { id: "current", label: "Current", icon: FileText },
  { id: "saved", label: "Saved", icon: Library },
  { id: "notes", label: "Notes", icon: BookOpen },
  { id: "records", label: "Records", icon: Database },
];

export function MobileLibrary({ artifact, mobileData, nativeShare, onOpenExternalUrl }: MobileLibraryProps) {
  const [section, setSection] = useState<LibrarySection>("current");
  const [state, dispatch] = useReducer(mobileLibraryReducer, {
    status: "loading",
    store: emptyMobileStore,
    error: null,
  });
  const [notice, setNotice] = useState("");
  const [mutationError, setMutationError] = useState("");
  const [mutating, setMutating] = useState(false);
  const mutationInFlight = useRef(false);
  const libraryReady = state.status === "ready";

  async function refresh() {
    setMutationError("");
    dispatch({ type: "loading" });
    try {
      dispatch({ type: "loaded", store: await mobileData.list() });
    } catch (error) {
      dispatch({ type: "failed", error: safeMessage(error) });
    }
  }

  async function mutate(operation: () => ReturnType<MobileDataCapability["list"]>, success: string): Promise<boolean> {
    if (mutationInFlight.current || !libraryReady) return false;
    mutationInFlight.current = true;
    setMutating(true);
    setNotice("");
    setMutationError("");
    try {
      dispatch({ type: "loaded", store: await operation() });
      setNotice(success);
      return true;
    } catch (error) {
      setMutationError(safeMessage(error));
      return false;
    } finally {
      mutationInFlight.current = false;
      setMutating(false);
    }
  }

  useEffect(() => {
    void refresh();
    return mobileData.subscribe((store) => dispatch({ type: "loaded", store }));
  }, [mobileData]);

  return (
    <div className="mobile-library" aria-busy={mutating}>
      <div className="mobile-library-switcher" role="tablist" aria-label="Artifact and local data views">
        {sections.map((item) => {
          const Icon = item.icon;
          return (
            <button key={item.id} type="button" role="tab" aria-selected={section === item.id} className={section === item.id ? "active" : ""} disabled={item.id !== "current" && !libraryReady} onClick={() => setSection(item.id)}>
              <Icon size={17} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {state.status === "error" ? (
        <div className="mobile-library-state" role="alert">
          <strong>Local library needs attention</strong>
          <p>{state.error}</p>
          <button type="button" onClick={() => void refresh()}><RefreshCw size={18} />Retry safely</button>
        </div>
      ) : null}
      {state.status === "loading" ? <div className="mobile-library-state" role="status">Loading private local data…</div> : null}
      {mutationError ? (
        <div className="mobile-library-state" role="alert">
          <strong>The local change was not saved</strong>
          <p>{mutationError}</p>
          <button type="button" onClick={() => setMutationError("")}>Dismiss</button>
        </div>
      ) : null}
      {notice ? <p className="mobile-library-notice" role="status">{notice}</p> : null}

      {section === "current" ? (
        <CurrentArtifact
          artifact={artifact}
          canSave={libraryReady}
          nativeShare={nativeShare}
          pending={mutating}
          onOpenExternalUrl={onOpenExternalUrl}
          onSave={async () => {
            if (!artifact) return;
            await mutate(() => mobileData.saveArtifact(artifact).then((result) => result.store), "Saved to this device.");
          }}
        />
      ) : null}
      {libraryReady && section === "saved" ? (
        <SavedLibrary
          items={state.store.artifacts}
          nativeShare={nativeShare}
          pending={mutating}
          onOpenExternalUrl={onOpenExternalUrl}
          onUpdate={(item, title) => mutate(() => mobileData.saveArtifact({ ...item, title }, item.id).then((result) => result.store), "Saved artifact updated.")}
          onDelete={(id) => mutate(() => mobileData.deleteArtifact(id), "Removed from Saved.")}
        />
      ) : null}
      {libraryReady && section === "notes" ? (
        <NotesLibrary
          items={state.store.notes}
          nativeShare={nativeShare}
          pending={mutating}
          onCreate={(text, tags) => mutate(() => mobileData.createNote({ text, tags }).then((result) => result.store), "Note saved locally.")}
          onUpdate={(id, text) => mutate(() => mobileData.updateNote({ id, text }), "Note updated.")}
          onDelete={(id) => mutate(() => mobileData.deleteNote(id), "Note deleted.")}
        />
      ) : null}
      {libraryReady && section === "records" ? (
        <RecordsLibrary
          items={state.store.records}
          nativeShare={nativeShare}
          pending={mutating}
          onCreate={(collection, title, data) => mutate(() => mobileData.createRecord({ collection, title, data }).then((result) => result.store), "Record saved locally.")}
          onUpdate={(id, title) => mutate(() => mobileData.updateRecord({ id, title }), "Record updated.")}
          onDelete={(id) => mutate(() => mobileData.deleteRecord(id), "Record deleted.")}
        />
      ) : null}
    </div>
  );
}

function CurrentArtifact({ artifact, canSave, nativeShare, pending, onSave, onOpenExternalUrl }: { artifact: VectorArtifact | null; canSave: boolean; nativeShare?: NativeShareCapability; pending: boolean; onSave: () => Promise<boolean | void>; onOpenExternalUrl?: (url: string) => Promise<void> }) {
  let saveError = "";
  if (artifact) {
    try { validateSavableArtifact(artifact); } catch (error) { saveError = safeMessage(error); }
  }
  return (
    <section aria-labelledby="mobile-current-heading">
      <div className="mobile-library-heading">
        <div><span>Session scoped</span><h2 id="mobile-current-heading">Current artifact</h2></div>
        <div className="mobile-library-heading-actions">
          {nativeShare && artifact && !saveError ? <button type="button" onClick={() => void nativeShare.share(artifactSharePayload(artifact)).catch((error) => window.alert(safeMessage(error)))} aria-label="Share current artifact"><Share2 size={18} />Share</button> : null}
          <button type="button" disabled={!canSave || pending || !artifact || Boolean(saveError)} onClick={() => void onSave()} aria-label="Save current artifact to this device"><Download size={18} />{pending ? "Saving…" : "Save"}</button>
        </div>
      </div>
      {saveError ? <p className="mobile-library-hint">{saveError}</p> : null}
      <ArtifactPanel artifact={artifact} visible fullscreen={false} presentation="mobile" onToggleVisible={() => undefined} onToggleFullscreen={() => undefined} onOpenExternalUrl={onOpenExternalUrl} />
    </section>
  );
}

function SavedLibrary({ items, nativeShare, pending, onUpdate, onDelete, onOpenExternalUrl }: { items: VectorSavedArtifact[]; nativeShare?: NativeShareCapability; pending: boolean; onUpdate: (item: VectorSavedArtifact, title: string) => Promise<boolean>; onDelete: (id: string) => Promise<boolean>; onOpenExternalUrl?: (url: string) => Promise<void> }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? null;
  if (!items.length) return <EmptyState title="Nothing saved yet" detail={`Save supported current artifacts here. Up to ${mobileDataLimits.maxArtifacts} items stay on this device.`} />;
  return (
    <section aria-labelledby="mobile-saved-heading">
      <div className="mobile-library-heading"><div><span>On this device</span><h2 id="mobile-saved-heading">Saved library</h2></div><b>{items.length}/{mobileDataLimits.maxArtifacts}</b></div>
      {selected ? <ArtifactPanel artifact={selected} visible fullscreen={false} presentation="mobile" onToggleVisible={() => setSelectedId(null)} onToggleFullscreen={() => undefined} onOpenExternalUrl={onOpenExternalUrl} /> : null}
      <div className="mobile-library-list">{items.map((item) => <LibraryCard key={item.id} title={item.title} meta={`${item.kind} · ${formatDate(item.updatedAt)}`} disabled={pending} onOpen={() => setSelectedId(item.id)} onEdit={() => promptEdit("Rename saved artifact", item.title, (value) => onUpdate(item, value))} onShare={nativeShare ? () => share(nativeShare, item) : undefined} onDelete={() => confirmedDelete(`Remove “${item.title}” from Saved?`, () => onDelete(item.id))} />)}</div>
    </section>
  );
}

function NotesLibrary({ items, nativeShare, pending, onCreate, onUpdate, onDelete }: { items: VectorMobileNote[]; nativeShare?: NativeShareCapability; pending: boolean; onCreate: (text: string, tags: string[]) => Promise<boolean>; onUpdate: (id: string, text: string) => Promise<boolean>; onDelete: (id: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  const [editDraft, setEditDraft] = useState<{ id: string; text: string } | null>(null);
  return (
    <section aria-labelledby="mobile-notes-heading">
      <div className="mobile-library-heading"><div><span>Private and local</span><h2 id="mobile-notes-heading">Notes</h2></div><b>{items.length}/{mobileDataLimits.maxNotes}</b></div>
      <form className="mobile-library-form" onSubmit={(event) => { event.preventDefault(); const nextTags = tags.split(",").map((tag) => tag.trim()).filter(Boolean); void onCreate(text, nextTags).then((saved) => { if (saved) { setText(""); setTags(""); } }); }}>
        <label htmlFor="mobile-note-text">New note</label><textarea id="mobile-note-text" required maxLength={mobileDataLimits.maxTextLength} value={text} onChange={(event) => setText(event.target.value)} placeholder="Write something worth keeping" />
        <label htmlFor="mobile-note-tags">Tags, comma separated</label><input id="mobile-note-tags" value={tags} onChange={(event) => setTags(event.target.value)} placeholder="idea, follow-up" />
        <button type="submit" disabled={pending || !text.trim()}><Plus size={18} />{pending ? "Saving…" : "Save note"}</button>
      </form>
      {editDraft ? (
        <form
          className="mobile-library-form"
          aria-label="Edit saved note"
          onSubmit={(event) => {
            event.preventDefault();
            void onUpdate(editDraft.id, editDraft.text).then((saved) => {
              if (saved) setEditDraft(null);
            });
          }}
        >
          <label htmlFor="mobile-note-edit">Edit note</label>
          <textarea
            id="mobile-note-edit"
            required
            maxLength={mobileDataLimits.maxTextLength}
            value={editDraft.text}
            onChange={(event) => setEditDraft({ ...editDraft, text: event.target.value })}
          />
          <div className="mobile-library-heading-actions">
            <button type="button" disabled={pending} onClick={() => setEditDraft(null)}>Cancel</button>
            <button type="submit" disabled={pending || !editDraft.text.trim()}>{pending ? "Saving…" : "Save edit"}</button>
          </div>
        </form>
      ) : null}
      {!items.length ? <EmptyState title="No saved notes" detail="Notes appear here without starting a voice session." /> : <div className="mobile-library-list">{items.map((item) => <LibraryCard key={item.id} title={item.text.slice(0, 80)} meta={`${item.tags.join(", ") || "No tags"} · ${formatDate(item.updatedAt)}`} body={item.text} disabled={pending || Boolean(editDraft)} onShare={nativeShare ? () => share(nativeShare, item) : undefined} onEdit={() => setEditDraft({ id: item.id, text: item.text })} onDelete={() => confirmedDelete("Delete this local note? This cannot be undone.", () => onDelete(item.id))} />)}</div>}
    </section>
  );
}

function RecordsLibrary({ items, nativeShare, pending, onCreate, onUpdate, onDelete }: { items: VectorMobileRecord[]; nativeShare?: NativeShareCapability; pending: boolean; onCreate: (collection: string, title: string, data: Record<string, unknown>) => Promise<boolean>; onUpdate: (id: string, title: string) => Promise<boolean>; onDelete: (id: string) => Promise<boolean> }) {
  const [mode, setMode] = useState<"browse" | "new">("browse");
  const [browseCollection, setBrowseCollection] = useState("general");
  const [newCollection, setNewCollection] = useState("general");
  const [title, setTitle] = useState("");
  const [dataText, setDataText] = useState("{}");
  const [formError, setFormError] = useState("");
  const [draftTouched, setDraftTouched] = useState(false);
  const [query, setQuery] = useState("");
  const collections = useMemo(() => recordCollectionNames(items), [items]);
  const matches = useMemo(() => items.filter((item) => recordMatchesSearch(item, browseCollection, query)), [browseCollection, items, query]);

  useEffect(() => {
    if (collections.length && !collections.includes(browseCollection)) setBrowseCollection(collections[0]);
    else if (!collections.length && browseCollection !== "general") setBrowseCollection("general");
  }, [browseCollection, collections]);
  return (
    <section aria-labelledby="mobile-records-heading">
      <div className="mobile-library-heading"><div><span>Structured and searchable</span><h2 id="mobile-records-heading">Records</h2></div><b>{items.length}/{mobileDataLimits.maxRecords}</b></div>
      <div className="mobile-library-view-switcher" role="group" aria-label="Record view">
        <button type="button" className={mode === "browse" ? "active" : ""} aria-pressed={mode === "browse"} onClick={() => setMode("browse")}><Library size={17} />Browse</button>
        <button type="button" className={mode === "new" ? "active" : ""} aria-pressed={mode === "new"} onClick={() => { if (mode !== "new" && !draftTouched && collections.length) setNewCollection(browseCollection); setMode("new"); }}><Plus size={17} />New record</button>
      </div>
      {mode === "new" ? (
        <form className="mobile-library-form" onSubmit={(event) => { event.preventDefault(); try { const parsed = JSON.parse(dataText); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(); setFormError(""); void onCreate(newCollection, title, parsed).then((saved) => { if (saved) { setBrowseCollection(newCollection.trim()); setTitle(""); setDataText("{}"); setDraftTouched(false); setMode("browse"); } }); } catch { setFormError("Structured data must be a JSON object within the local size limit."); } }}>
          <label htmlFor="mobile-record-collection">Collection</label><input id="mobile-record-collection" required maxLength={mobileDataLimits.maxCollectionLength} value={newCollection} onChange={(event) => { setNewCollection(event.target.value); setDraftTouched(true); }} list="mobile-record-collections" />
          <label htmlFor="mobile-record-title">Record title</label><input id="mobile-record-title" required maxLength={mobileDataLimits.maxTitleLength} value={title} onChange={(event) => { setTitle(event.target.value); setDraftTouched(true); }} placeholder="New record" />
          <label htmlFor="mobile-record-data">Structured data (JSON)</label><textarea id="mobile-record-data" value={dataText} onChange={(event) => { setDataText(event.target.value); setDraftTouched(true); }} maxLength={mobileDataLimits.maxRecordDataBytes} spellCheck={false} />
          {formError ? <p role="alert">{formError}</p> : null}
          <button type="submit" disabled={pending || !newCollection.trim() || !title.trim()}><Plus size={18} />{pending ? "Saving…" : "Save record"}</button>
        </form>
      ) : (
        <>
          <div className="mobile-library-search-grid">
            <label className="mobile-library-search" htmlFor="mobile-record-browse-collection">Collection<select id="mobile-record-browse-collection" value={browseCollection} disabled={!collections.length} onChange={(event) => setBrowseCollection(event.target.value)}>{collections.length ? collections.map((name) => <option key={name} value={name}>{name}</option>) : <option value="general">No collections yet</option>}</select></label>
            <label className="mobile-library-search" htmlFor="mobile-record-search">Search this collection<input id="mobile-record-search" type="search" maxLength={mobileDataLimits.maxSearchLength} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Title or structured data" /></label>
          </div>
          {!matches.length ? <EmptyState title="No matching records" detail="Choose a collection or create a new local record." /> : <div className="mobile-library-list">{matches.map((item) => <LibraryCard key={item.id} title={item.title} meta={`${item.collection} · ${formatDate(item.updatedAt)}`} body={stableJSONStringify(item.data)} disabled={pending} onShare={nativeShare ? () => share(nativeShare, item) : undefined} onEdit={() => promptEdit("Edit record title", item.title, (value) => onUpdate(item.id, value))} onDelete={() => confirmedDelete(`Delete “${item.title}”? This cannot be undone.`, () => onDelete(item.id))} />)}</div>}
        </>
      )}
      <datalist id="mobile-record-collections">{collections.map((name) => <option key={name} value={name} />)}</datalist>
    </section>
  );
}

function LibraryCard({ title, meta, body, disabled = false, onOpen, onShare, onEdit, onDelete }: { title: string; meta: string; body?: string; disabled?: boolean; onOpen?: () => void; onShare?: () => void; onEdit?: () => void; onDelete: () => void }) {
  return <article className="mobile-library-card"><div className="mobile-library-card-content"><button type="button" className="mobile-library-card-main" onClick={onOpen} disabled={!onOpen}><strong>{title}</strong><span>{meta}</span></button>{body ? <details><summary>Read details</summary><pre>{body}</pre></details> : null}</div><div className="mobile-library-actions">{onEdit ? <button type="button" disabled={disabled} onClick={onEdit} aria-label={`Edit ${title}`}><Pencil size={18} /></button> : null}{onShare ? <button type="button" onClick={onShare} aria-label={`Share ${title}`}><Share2 size={18} /></button> : null}<button type="button" className="danger" disabled={disabled} onClick={onDelete} aria-label={`Delete ${title}`}><Trash2 size={18} /></button></div></article>;
}

function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="mobile-library-empty"><strong>{title}</strong><p>{detail}</p></div>; }
function formatDate(value: string) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }
function safeMessage(error: unknown) { return error instanceof Error && error.message.length <= 180 ? error.message : "The local library operation failed safely."; }
function confirmedDelete(message: string, operation: () => Promise<unknown>) { if (window.confirm(message)) void operation(); }
function promptEdit(label: string, current: string, operation: (value: string) => Promise<unknown>) { const value = window.prompt(label, current); if (value?.trim() && value.trim() !== current) void operation(value.trim()); }
function share(capability: NativeShareCapability, item: VectorSavedArtifact | VectorMobileNote | VectorMobileRecord) { void capability.share(savedItemSharePayload(item)).catch((error) => window.alert(safeMessage(error))); }
