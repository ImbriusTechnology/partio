// Settings → Import and export: CSV templates, exporting the library, and importing with a preview.
import { useRef, useState } from 'react';
import { FILE_LABEL, FILE_ORDER, type FileKind } from '../lib/csvFormat.ts';
import { backupLibrary, revealInFileManager, saveFilesToFolder } from '../lib/db.ts';
import { exportLibrary, singleBomTemplate, templates } from '../lib/exporter.ts';
import { describeFile, importCsv, type ImportFile, type ImportOptions, type ImportReport } from '../lib/importer.ts';
import { Field, Modal, Select, useAction, useToast } from './ui.tsx';

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

export function ImportExportSection({ onChanged }: { onChanged: () => void }) {
  const act = useAction();
  const toast = useToast();
  const [importing, setImporting] = useState(false);

  const save = (title: string, folder: string, files: () => Promise<Array<{ name: string; text: string }>>) => act(async () => {
    const where = await saveFilesToFolder(title, folder, await files());
    if (!where) return;
    toast(`Saved to ${where}`);
    await revealInFileManager(where).catch(() => undefined);
  });

  return (
    <section className="card">
      <h3>Import and export</h3>
      <p className="small muted">Partio reads and writes its library as CSV files: locations, parts, stock and sources.
        The templates have the columns and an example row each; <code>docs/csv-format.md</code> in the project describes every column.</p>
      <div className="row">
        <button className="primary" onClick={() => setImporting(true)}>Import CSV files…</button>
        <button onClick={() => void save('Choose where to save the library', `partio-export-${stamp()}`, exportLibrary)}>Export library…</button>
        <button onClick={() => void save('Choose where to save the templates', 'partio-templates', async () => templates())}>Download templates…</button>
      </div>
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={() => { setImporting(false); onChanged(); }} />}
    </section>
  );
}

type Stage = 'choose' | 'checked' | 'done';

/**
 * Choose CSV files, check them, then import. With `bomFor`, one single-BOM file is imported for that assembly,
 * as the revision chosen here: the file has only line, pn, mpn, qty, designators, dnp and note columns.
 */
export function ImportDialog({ onClose, onDone, title, hint, bomFor }: {
  onClose: () => void; onDone: () => void; title?: string; hint?: string;
  bomFor?: { assemblyPn: string; rev: string };
}) {
  const act = useAction();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [opts, setOpts] = useState<ImportOptions>({ mode: 'add', stockMode: 'add', bomFor: bomFor ?? null });
  const onlyBom = !!bomFor;
  const [report, setReport] = useState<ImportReport | null>(null);
  const [stage, setStage] = useState<Stage>('choose');
  const [busy, setBusy] = useState(false);
  const hasStock = files.some((f) => f.kind === 'stock' || /stock/i.test(f.name));

  const reset = () => { setReport(null); setStage('choose'); };
  const pick = async (list: FileList | null) => {
    if (!list) return;
    const read = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text(), kind: onlyBom ? ('bom' as const) : null })));
    // One BOM per file here, so a new choice replaces the old one.
    setFiles((old) => (onlyBom ? read.slice(0, 1) : [...old.filter((o) => !read.some((r) => r.name === o.name)), ...read]));
    reset();
  };
  const run = (commit: boolean) => act(async () => {
    setBusy(true);
    try {
      if (commit) await backupLibrary();
      const r = await importCsv(files, opts, commit);
      setReport(r);
      setStage(commit && r.committed ? 'done' : 'checked');
    } finally {
      setBusy(false);
    }
  });

  const canImport = stage === 'checked' && report && report.errorCount === 0;
  const kindOf = (f: ImportFile) => f.kind ?? report?.files.find((r) => r.name === f.name)?.kind ?? null;

  return (
    <Modal title={stage === 'done' ? 'Import finished' : title ?? 'Import CSV files'} onClose={stage === 'done' ? onDone : onClose} wide sticky={busy}
      footer={stage === 'done'
        ? <><span className="spacer" /><button className="primary" onClick={onDone}>Done</button></>
        : <>
          <span className="muted small">{busy ? 'Working…' : stage === 'checked' && report?.errorCount ? 'Fix the errors and check again' : ''}</span>
          <span className="spacer" />
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button onClick={() => void run(false)} disabled={busy || !files.length}>{stage === 'checked' ? 'Check again' : 'Check'}</button>
          <button className="primary" onClick={() => void run(true)} disabled={busy || !canImport}>
            {report?.unknownColumnCount ? 'Ignore unknown columns and import' : 'Import'}
          </button>
        </>}>
      {stage !== 'done' && (
        <>
          {hint && <p className="small muted" style={{ marginTop: 0 }}>{hint}</p>}
          <div className="row">
            <button onClick={() => input.current?.click()} disabled={busy}>{onlyBom ? 'Choose BOM file…' : 'Choose files…'}</button>
            {onlyBom && <button onClick={() => void act(async () => {
              const where = await saveFilesToFolder('Choose where to save the BOM template', 'partio-bom-template', [singleBomTemplate()]);
              if (!where) return;
              toast(`Saved to ${where}`);
              await revealInFileManager(where).catch(() => undefined);
            })}>Download template…</button>}
            <span className="muted small">{onlyBom
              ? 'One BOM per file: line, pn and/or mpn, qty, designators, dnp, note'
              : 'locations.csv, parts.csv, stock.csv, sources.csv, bom.csv: any or all of them'}</span>
            <input ref={input} type="file" accept=".csv,text/csv" multiple={!onlyBom} hidden onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
          </div>
          {files.length > 0 && (
            <table className="grid compact import-files">
              <tbody>
                {files.map((f) => (
                  <tr key={f.name}>
                    <td className="mono">{f.name}</td>
                    {!onlyBom && (
                      <td style={{ width: 150 }}>
                        <Select<FileKind> value={kindOf(f)} empty="What is it?" options={FILE_ORDER.map((k) => ({ value: k, label: FILE_LABEL[k] }))}
                          onChange={(k) => { setFiles((fs) => fs.map((x) => (x.name === f.name ? { ...x, kind: k } : x))); reset(); }} />
                      </td>
                    )}
                    <td className="row-actions"><button className="link" onClick={() => { setFiles((fs) => fs.filter((x) => x.name !== f.name)); reset(); }}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="form-grid">
            {onlyBom && (
              <Field label="Import as revision" hint="A new revision, as a draft; release it on the Assemblies screen">
                <input value={opts.bomFor?.rev ?? ''} className="mono" style={{ width: 80 }}
                  onChange={(e) => { const rev = e.target.value.toUpperCase(); setOpts((o) => ({ ...o, bomFor: o.bomFor ? { ...o.bomFor, rev } : null })); reset(); }} />
              </Field>
            )}
            {!onlyBom && <Field label="Rows for things already in the library">
              <Select<'add' | 'update'> value={opts.mode} onChange={(m) => { setOpts((o) => ({ ...o, mode: m ?? 'add' })); reset(); }}
                options={[{ value: 'add', label: 'Skip them (add new only)' }, { value: 'update', label: 'Update them (add and update)' }]} />
            </Field>}
            {hasStock && (
              <Field label="Stock quantities">
                <Select<'add' | 'set'> value={opts.stockMode} onChange={(m) => { setOpts((o) => ({ ...o, stockMode: m ?? 'add' })); reset(); }}
                  options={[{ value: 'add', label: 'Add to stock' }, { value: 'set', label: 'Set stock to these counts' }]} />
              </Field>
            )}
          </div>
        </>
      )}
      {report && <ReportView report={report} done={stage === 'done'} />}
      {stage === 'choose' && files.length > 0 && <p className="small muted">Check runs the import and then undoes it, so you can see exactly what will happen before anything changes.</p>}
    </Modal>
  );
}

function ReportView({ report, done }: { report: ImportReport; done: boolean }) {
  const also = report.alsoCreated;
  const alsoLines = ([
    ['categories', also.categories], ['packages', also.packages], ['manufacturers', also.manufacturers],
    ['vendors', also.vendors], ['locations', also.locations],
  ] as Array<[string, string[]]>).filter(([, list]) => list.length);
  const errors = report.files.flatMap((f) => f.errors.map((e) => ({ file: f.name, ...e })));
  const warnings = report.files.flatMap((f) => f.warnings.map((e) => ({ file: f.name, ...e })));
  return (
    <div className="import-report">
      {done
        ? <p className="ok-note">Imported. A backup of the library from just before the import was written first.</p>
        : report.errorCount
          ? <p className="error-note">{report.errorCount} problem{report.errorCount === 1 ? '' : 's'} to fix. Nothing has been changed.</p>
          : <p className="ok-note">Ready to import. Nothing has been changed yet.</p>}
      <ul className="file-results">
        {report.files.map((f) => (
          <li key={f.name} className={f.problem ? 'bad' : ''}>
            <b>{f.name}</b> — {describeFile(f, done)}
            {f.unknownColumns.length > 0 && <div className="warn-text small">Unknown column{f.unknownColumns.length === 1 ? '' : 's'}, which will be ignored: {f.unknownColumns.join(', ')}</div>}
          </li>
        ))}
      </ul>
      {alsoLines.length > 0 && (
        <>
          <h4>{done ? 'Also created' : 'Will also be created'}</h4>
          <ul className="also-created small">
            {alsoLines.map(([what, list]) => <li key={what}><b>{list.length} {what}:</b> {list.slice(0, 30).join(', ')}{list.length > 30 ? `, and ${list.length - 30} more` : ''}</li>)}
          </ul>
        </>
      )}
      {errors.length > 0 && (
        <>
          <h4>Errors</h4>
          <div className="error-list">
            <table className="grid compact">
              <thead><tr><th>File</th><th className="num">Line</th><th>Problem</th></tr></thead>
              <tbody>
                {errors.slice(0, 500).map((e, i) => <tr key={i}><td className="mono small">{e.file}</td><td className="num">{e.line}</td><td>{e.message}</td></tr>)}
              </tbody>
            </table>
            {errors.length > 500 && <p className="small muted">…and {errors.length - 500} more.</p>}
          </div>
        </>
      )}
      {warnings.length > 0 && (
        <>
          <h4>Warnings <span className="muted">(these don’t stop the import)</span></h4>
          <div className="error-list">
            <table className="grid compact">
              <thead><tr><th>File</th><th className="num">Line</th><th>Note</th></tr></thead>
              <tbody>
                {warnings.slice(0, 500).map((e, i) => <tr key={i}><td className="mono small">{e.file}</td><td className="num">{e.line}</td><td className="warn-text">{e.message}</td></tr>)}
              </tbody>
            </table>
            {warnings.length > 500 && <p className="small muted">…and {warnings.length - 500} more.</p>}
          </div>
        </>
      )}
    </div>
  );
}
