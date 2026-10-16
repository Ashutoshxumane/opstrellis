import { useEffect, useState } from "react";
import { api, errMsg, type DictEntry } from "../api";
import { Icon } from "../icons";
import { Empty, Modal, Page, Search, useSearch } from "../ui";

type Draft = { id?: number; phrase: string; replacement: string };

export default function Dictionary() {
  const [entries, setEntries] = useState<DictEntry[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { query, setQuery, filtered } = useSearch(entries, (e) => `${e.phrase} ${e.replacement ?? ""}`);

  const load = () => api.listDictionary().then(setEntries, (e) => setError(errMsg(e)));
  useEffect(() => void load(), []);

  async function save() {
    if (!draft || !draft.phrase.trim()) return;
    try {
      await api.upsertDictionary({ id: draft.id, phrase: draft.phrase.trim(), replacement: draft.replacement.trim() || null });
      setDraft(null);
      load();
    } catch (e) { setError(errMsg(e)); }
  }
  async function remove(id: number) {
    await api.deleteDictionary(id).catch((e) => setError(errMsg(e)));
    load();
  }

  const add = () => setDraft({ phrase: "", replacement: "" });

  return (
    <Page title="Dictionary" actions={<>
      {entries.length > 0 && <Search value={query} onChange={setQuery} />}
      <button className="btn primary" onClick={add}><Icon name="plus" />Add new</button>
    </>}>
      {error && <div className="error">{error}</div>}

      {entries.length === 0 ? (
        <Empty action={<button className="btn" onClick={add}>Add a word</button>}>
          Add names and jargon OpsTrellis should spell right, or phrases to replace.
        </Empty>
      ) : (
        <div className="card list">
          {filtered.map((e) => (
            <div key={e.id} className="list-row">
              <div className="li-main">
                <div className="li-title">{e.phrase}</div>
                <div className="li-meta">
                  {e.replacement ? <>Replaced with <span className="li-em">{e.replacement}</span></> : "Spelling"}
                  {e.learned && <span className="tag">Learned</span>}
                </div>
              </div>
              <div className="li-actions">
                <button className="icon-btn" title="Edit" aria-label="Edit" onClick={() => setDraft({ id: e.id, phrase: e.phrase, replacement: e.replacement ?? "" })}><Icon name="edit" /></button>
                <button className="icon-btn" title="Delete" aria-label="Delete" onClick={() => remove(e.id)}><Icon name="trash" /></button>
              </div>
            </div>
          ))}
          {filtered.length === 0 && <div className="list-empty">No entries match “{query}”.</div>}
        </div>
      )}

      {draft && (
        <Modal title={draft.id ? "Edit entry" : "Add to dictionary"} onClose={() => setDraft(null)}
          footer={<>
            <button className="btn" onClick={() => setDraft(null)}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={!draft.phrase.trim()}>Save</button>
          </>}>
          <label className="field">
            <span>Word or spoken phrase</span>
            <input autoFocus value={draft.phrase} onChange={(e) => setDraft({ ...draft, phrase: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && save()} placeholder="e.g. Kubernetes" />
          </label>
          <label className="field">
            <span>Replace with (optional)</span>
            <input value={draft.replacement} onChange={(e) => setDraft({ ...draft, replacement: e.target.value })}
              onKeyDown={(e) => e.key === "Enter" && save()} placeholder="Leave empty to use it as a vocabulary hint" />
          </label>
        </Modal>
      )}
    </Page>
  );
}
