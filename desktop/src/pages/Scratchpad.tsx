import { useEffect, useRef, useState } from "react";
import { api, errMsg, type Note } from "../api";
import { Icon } from "../icons";
import { Page } from "../ui";

export default function Scratchpad() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [current, setCurrent] = useState<Note | null>(null);
  const [status, setStatus] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef<Note | null>(null); // edited but not yet saved

  useEffect(() => {
    api.listNotes("note").then((ns) => { setNotes(ns); setCurrent(ns[0] ?? null); }, (e) => setStatus(errMsg(e)));
    return () => void flush(); // save edits when leaving the page
  }, []);

  function flush() {
    clearTimeout(timer.current);
    const note = pending.current;
    pending.current = null;
    return note ? persist(note) : Promise.resolve();
  }

  async function persist(note: Note) {
    try {
      const saved = await api.upsertNote({ id: note.id, title: note.title, body: note.body });
      setNotes((ns) => [saved, ...ns.filter((n) => n.id !== saved.id)]);
      setStatus("Saved");
    } catch (e) { setStatus(errMsg(e)); }
  }

  function edit(patch: Partial<Note>) {
    if (!current) return;
    const next = { ...current, ...patch };
    setCurrent(next);
    setStatus("Editing…");
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 600);
  }

  async function select(note: Note) {
    // The list's copy of the open note can be older than the editor (debounced save).
    if (note.id === current?.id) return;
    await flush();
    setCurrent(note);
    setStatus("");
  }

  async function create() {
    await flush();
    try {
      const n = await api.upsertNote({ title: "", body: "" });
      setNotes((ns) => [n, ...ns]);
      setCurrent(n);
    } catch (e) { setStatus(errMsg(e)); }
  }

  async function remove(note: Note) {
    clearTimeout(timer.current);
    pending.current = null;
    await api.deleteNote(note.id).catch((e) => setStatus(errMsg(e)));
    const rest = notes.filter((n) => n.id !== note.id);
    setNotes(rest);
    setCurrent(rest[0] ?? null);
  }

  return (
    <Page title="Scratchpad" className="scratchpad" actions={
      <button className="btn primary" onClick={create}><Icon name="plus" />New note</button>
    }>
      <div className="card notes">
        <div className="notes-list">
          {notes.length === 0 && <div className="list-empty">No notes yet.</div>}
          {notes.map((n) => (
            <button key={n.id} className={"note-item" + (current?.id === n.id ? " active" : "")} onClick={() => select(n)}>
              <span className="li-title ellipsis">{(current?.id === n.id ? current.title : n.title) || "Untitled"}</span>
              <span className="li-meta ellipsis">{(current?.id === n.id ? current.body : n.body).split("\n")[0] || "Empty note"}</span>
            </button>
          ))}
        </div>
        {current ? (
          <div className="note-editor">
            <div className="note-head">
              <input className="note-title" value={current.title} placeholder="Untitled" aria-label="Title" onChange={(e) => edit({ title: e.target.value })} />
              <span className="meta">{status}</span>
              <button className="icon-btn" title="Delete note" aria-label="Delete note" onClick={() => remove(current)}><Icon name="trash" /></button>
            </div>
            <textarea className="note-body" value={current.body} placeholder="Click here and hold your dictation hotkey to start talking…"
              aria-label="Note" onChange={(e) => edit({ body: e.target.value })} />
          </div>
        ) : (
          <div className="note-editor note-none">
            <span>Create a note to start dictating drafts.</span>
          </div>
        )}
      </div>
    </Page>
  );
}
