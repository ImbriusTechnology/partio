// Add, rename, move and delete part categories.
import { useMemo, useState } from 'react';
import { addCategory, deleteCategory, listCategories, updateCategory, type Category } from '../lib/reference.ts';
import { ConfirmButton, Field, Modal, Select, useAction, useLoad } from './ui.tsx';

type Cat = Category;

export function CategoryManager({ initialId, onClose, onChanged }: { initialId?: number | null; onClose: () => void; onChanged: () => void }) {
  const act = useAction();
  const [tick, setTick] = useState(0);
  const cats = useLoad(listCategories, [tick]);
  const [selId, setSelId] = useState<number | 'new' | null>(initialId ?? null);
  const [newParent, setNewParent] = useState<number | null>(null);
  const list = cats.data ?? [];
  const sel = typeof selId === 'number' ? list.find((c) => c.id === selId) : undefined;

  // Parts in each category including its subcategories, for the counts.
  const totals = useMemo(() => {
    const t = new Map<number, number>();
    for (const c of list) {
      const prefix = c.path + ' > ';
      t.set(c.id, list.filter((d) => d.id === c.id || d.path.startsWith(prefix)).reduce((s, d) => s + d.parts, 0));
    }
    return t;
  }, [list]);

  const changed = (id?: number | null) => { setTick((n) => n + 1); onChanged(); if (id !== undefined) setSelId(id); };
  const startNew = (parentId: number | null) => { setNewParent(parentId); setSelId('new'); };

  return (
    <Modal title="Categories" onClose={onClose} xwide footer={<><span className="spacer" /><button onClick={onClose}>Done</button></>}>
      <div className="cat-manager">
        <div className="cat-manager-list">
          <button className="link" onClick={() => startNew(null)}>+ New top-level category</button>
          {list.map((c) => {
            const depth = c.path.split(' > ').length - 1;
            return (
              <div key={c.id} className={`cat ${selId === c.id ? 'sel' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setSelId(c.id)}>
                {c.name} <span className="count">{totals.get(c.id) || ''}</span>
              </div>
            );
          })}
        </div>
        <div className="cat-manager-edit">
          {selId === 'new' ? (
            <CategoryForm key={`new-${newParent}`} cats={list} title="New category" initial={{ name: '', parent_id: newParent, ref_prefix: null }}
              saveLabel="Add category" onSave={(f) => void act(async () => changed(await addCategory(f)), `${f.name} added`)} />
          ) : sel ? (
            <>
              <CategoryForm key={sel.id} cats={list} self={sel} title={sel.path} initial={{ name: sel.name, parent_id: sel.parent_id, ref_prefix: sel.ref_prefix ?? null }}
                saveLabel="Save" onSave={(f) => void act(async () => { await updateCategory(sel.id, f); changed(); }, 'Category saved')} />
              <div className="cat-manager-actions">
                <button onClick={() => startNew(sel.id)}>+ New category inside {sel.name}</button>
                <ConfirmButton className="danger quiet" label="Delete category"
                  confirmLabel={`Delete ${sel.name}? Click again`}
                  onConfirm={() => void act(async () => { await deleteCategory(sel.id); changed(sel.parent_id); }, `${sel.name} deleted`)} />
              </div>
              <p className="small muted">
                {totals.get(sel.id) ? `${totals.get(sel.id)} part${totals.get(sel.id) === 1 ? '' : 's'} in here. ` : 'No parts in here. '}
                Deleting a category moves its parts and subcategories up to {sel.parent_id ? list.find((c) => c.id === sel.parent_id)?.name : 'the top level (parts end up with no category)'}.
              </p>
            </>
          ) : (
            <p className="muted">Choose a category to rename or move it, or add a new one.</p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CategoryForm({ cats, self, title, initial, saveLabel, onSave }: {
  cats: Cat[]; self?: Cat; title: string; initial: { name: string; parent_id: number | null; ref_prefix: string | null };
  saveLabel: string; onSave: (f: { name: string; parent_id: number | null; ref_prefix: string | null }) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [parent, setParent] = useState<number | null>(initial.parent_id);
  const [prefix, setPrefix] = useState(initial.ref_prefix ?? '');
  // A category can't be moved inside itself or one of its own subcategories.
  const parents = cats.filter((c) => !self || (c.id !== self.id && !c.path.startsWith(self.path + ' > ')));
  const dirty = name.trim() !== initial.name || parent !== initial.parent_id || prefix.trim() !== (initial.ref_prefix ?? '');
  return (
    <>
      <h3 className="form-section" style={{ marginTop: 0 }}>{title}</h3>
      <div className="form-grid">
        <Field label="Name" wide>
          <input value={name} autoFocus onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && dirty) onSave({ name, parent_id: parent, ref_prefix: prefix.trim() || null }); }} />
        </Field>
        <Field label="Inside" wide>
          <Select value={parent} onChange={setParent} empty="(top level)" options={parents.map((c) => ({ value: c.id, label: c.path }))} />
        </Field>
        <Field label="Designator prefix" hint="Used on BOMs, e.g. R, C, U"><input value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
      </div>
      <div className="row"><span className="spacer" />
        <button className="primary" disabled={!name.trim() || !dirty} onClick={() => onSave({ name, parent_id: parent, ref_prefix: prefix.trim() || null })}>{saveLabel}</button>
      </div>
    </>
  );
}
