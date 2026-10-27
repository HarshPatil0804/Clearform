type Stage = 'upload' | 'processing' | 'choose';

const STEPS = ['Upload', 'Processing', 'Choose', 'Download'] as const;

export interface StepsProps {
  stage: Stage;
  downloaded: boolean;
}

export default function Steps({ stage, downloaded }: StepsProps) {
  const activeIndex = stage === 'upload' ? 0 : stage === 'processing' ? 1 : downloaded ? 3 : 2;

  return (
    <nav aria-label="Progress" className="flex items-center w-full max-w-2xl mx-auto">
      {STEPS.map((label, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <div key={label} className={`flex items-center ${index === STEPS.length - 1 ? '' : 'flex-1'}`}>
            <div className="flex flex-col items-center gap-1 min-w-[4.5rem]">
              <div
                className={[
                  'flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold border-2 transition-colors',
                  active
                    ? 'bg-indigo-600 border-indigo-600 text-white'
                    : done
                      ? 'bg-indigo-100 border-indigo-600 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300'
                      : 'bg-white border-slate-300 text-slate-400 dark:bg-slate-900 dark:border-slate-700',
                ].join(' ')}
              >
                {done ? '✓' : index + 1}
              </div>
              <span
                className={[
                  'text-[0.7rem] font-semibold tracking-wide uppercase',
                  active ? 'text-indigo-600 dark:text-indigo-400' : 'muted',
                ].join(' ')}
              >
                {label}
              </span>
            </div>
            {index < STEPS.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-1 rounded ${
                  index < activeIndex ? 'bg-indigo-600' : 'bg-slate-300 dark:bg-slate-700'
                }`}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
