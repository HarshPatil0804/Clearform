import { useCallback, useEffect, useRef, useState } from 'react';
import Steps from './components/Steps';
import Dropzone from './components/Dropzone';
import ProcessingView from './components/ProcessingView';
import ChoiceScreen from './components/ChoiceScreen';
import { PipelineClient } from './worker/client';
import type { Dataset } from './types';

export interface ResultItem {
  id: string;
  fileName: string;
  dataset: Dataset;
}

type Stage = 'upload' | 'processing' | 'choose';

interface ProgressState {
  pct: number;
  message: string;
  current: number;
  total: number;
}

interface FileError {
  name: string;
  message: string;
}

export default function App() {
  const [stage, setStage] = useState<Stage>('upload');
  const [results, setResults] = useState<ResultItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [errors, setErrors] = useState<FileError[]>([]);
  const [downloaded, setDownloaded] = useState(false);
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  const clientRef = useRef<PipelineClient | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    try {
      localStorage.setItem('u2s-theme', dark ? 'dark' : 'light');
    } catch {
      // storage unavailable (private mode) – theme still applies for this session
    }
  }, [dark]);

  useEffect(() => () => clientRef.current?.dispose(), []);

  const handleFiles = useCallback(async (files: File[]) => {
    setStage('processing');
    setErrors([]);
    setResults([]);
    setDownloaded(false);
    setProgress({ pct: 0, message: 'Starting…', current: 1, total: files.length });

    const client = clientRef.current ?? (clientRef.current = new PipelineClient());
    const collected: ResultItem[] = [];
    const failed: FileError[] = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      setProgress({
        pct: (index / files.length) * 100,
        message: `Reading ${file.name}`,
        current: index + 1,
        total: files.length,
      });
      try {
        const buffer = await file.arrayBuffer();
        const datasets = await client.process(
          { name: file.name, mime: file.type || 'application/octet-stream', buffer },
          (update) =>
            setProgress({
              pct: ((index + update.pct / 100) / files.length) * 100,
              message: update.message,
              current: index + 1,
              total: files.length,
            }),
        );
        datasets.forEach((dataset, position) => {
          collected.push({
            id: `${index}-${position}-${dataset.report.fileName}`,
            fileName: dataset.report.fileName,
            dataset,
          });
        });
      } catch (error) {
        failed.push({ name: file.name, message: error instanceof Error ? error.message : String(error) });
      }
    }

    setProgress(null);
    setErrors(failed);
    if (collected.length > 0) {
      setResults(collected);
      setActiveIndex(0);
      setStage('choose');
    } else {
      setStage('upload');
    }
  }, []);

  const restart = useCallback(() => {
    setStage('upload');
    setResults([]);
    setErrors([]);
    setDownloaded(false);
    setProgress(null);
  }, []);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[var(--u2s-border)] bg-white/70 dark:bg-slate-950/70 backdrop-blur sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white font-black text-sm">
              U→S
            </div>
            <div className="leading-tight">
              <h1 className="text-base font-bold">Unstructured → Structured</h1>
              <p className="muted text-xs hidden sm:block">
                Any file in, clean table out — 100% in your browser
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden md:inline-flex badge badge-boolean">offline-ready</span>
            <button
              className="btn btn-secondary"
              onClick={() => setDark((value) => !value)}
              aria-label="Toggle dark mode"
              title="Toggle dark mode"
            >
              {dark ? '☀️ Light' : '🌙 Dark'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto w-full px-4 py-6 flex flex-col gap-6 flex-1">
        <Steps stage={stage} downloaded={downloaded} />

        {stage === 'upload' && (
          <div className="flex flex-col gap-4">
            <Dropzone onFiles={handleFiles} />
            {errors.length > 0 && (
              <div className="card border-red-300 dark:border-red-900 p-4" role="alert">
                <h3 className="font-semibold text-red-600 dark:text-red-400 text-sm">
                  {errors.length === 1 ? '1 file could not be processed' : `${errors.length} files could not be processed`}
                </h3>
                <ul className="mt-2 space-y-1 text-xs">
                  {errors.map((error) => (
                    <li key={error.name} className="muted">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">{error.name}</span> —{' '}
                      {error.message}
                    </li>
                  ))}
                </ul>
                <p className="muted text-xs mt-2">
                  Corrupted or unsupported files are skipped; everything else still converts. Try another file or
                  check the format.
                </p>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              {[
                { title: '1 · Automatic', text: 'Type detection, parsing, structure inference and cleaning run with zero manual steps.' },
                { title: '2 · Private', text: 'Files are parsed by local JS/WASM in a Web Worker. Nothing is uploaded, no backend exists.' },
                { title: '3 · Flexible', text: 'Pick Tabular or Pivot at the end, switch freely, then download CSV / XLSX / JSON.' },
              ].map((item) => (
                <div key={item.title} className="card p-4">
                  <h3 className="font-semibold text-sm">{item.title}</h3>
                  <p className="muted text-xs mt-1">{item.text}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {stage === 'processing' && progress && (
          <ProcessingView
            pct={progress.pct}
            message={progress.message}
            current={progress.current}
            total={progress.total}
          />
        )}

        {stage === 'choose' && results.length > 0 && (
          <>
            <ChoiceScreen
              results={results}
              activeIndex={activeIndex}
              onSelectFile={setActiveIndex}
              onDownloaded={() => setDownloaded(true)}
              onRestart={restart}
            />
            {errors.length > 0 && (
              <div className="card border-amber-300 dark:border-amber-900 p-4" role="alert">
                <h3 className="font-semibold text-amber-700 dark:text-amber-400 text-sm">
                  Some files were skipped
                </h3>
                <ul className="mt-2 space-y-1 text-xs">
                  {errors.map((error) => (
                    <li key={error.name} className="muted">
                      <span className="font-semibold text-slate-700 dark:text-slate-300">{error.name}</span> —{' '}
                      {error.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="border-t border-[var(--u2s-border)] py-4">
        <p className="muted text-xs text-center">
          Runs entirely client-side (Vite · React · TypeScript · Tailwind · Web Workers) — deployable as a static
          site on GitHub Pages or Netlify.
        </p>
      </footer>
    </div>
  );
}
