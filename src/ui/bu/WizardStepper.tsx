import { useRef, type KeyboardEvent } from 'react';

export type StepId = 1 | 2 | 3 | 4 | 5;

export interface StepInfo {
  readonly id: StepId;
  readonly label: string;
  readonly state: 'current' | 'done' | 'todo' | 'blocked';
  /** False: the step cannot be opened yet (the button is disabled and `reason` says why). */
  readonly reachable: boolean;
  readonly reason?: string;
}

const STATE_TEXT: Readonly<Record<StepInfo['state'], string>> = { current: 'current step', done: 'completed', todo: 'not started', blocked: 'needs attention' };
const MARK: Readonly<Record<StepInfo['state'], (id: number) => string>> = { current: (id) => String(id), done: () => '✔', todo: (id) => String(id), blocked: () => '⚠' };

/**
 * The process rail of the wizard: a compact row of numbered steps. Every state has text and a symbol (colour is never the only signal), steps
 * that cannot be opened yet are disabled with the reason, and Left/Right/Home/End move between the reachable steps. On a narrow viewport the
 * labels collapse to "Step n of 5 · name".
 */
export function WizardStepper({ steps, onGo }: { readonly steps: readonly StepInfo[]; readonly onGo: (id: StepId) => void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = steps.find((s) => s.state === 'current');

  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const reachable = buttons.current.map((b, i) => ({ b, i })).filter((x) => x.b !== null && !x.b.disabled);
    if (reachable.length === 0) return;
    const at = reachable.findIndex((x) => x.b === document.activeElement);
    let next: number;
    if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = reachable.length - 1;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = at < 0 ? 0 : Math.min(reachable.length - 1, at + 1);
    else next = at < 0 ? reachable.length - 1 : Math.max(0, at - 1);
    e.preventDefault();
    reachable[next]?.b?.focus();
  };

  return (
    <nav aria-label="Business unit move steps" className="wz-stepper">
      <ol onKeyDown={onKeyDown}>
        {steps.map((s, i) => (
          <li key={s.id} data-state={s.state}>
            <button
              type="button"
              ref={(el) => {
                buttons.current[i] = el;
              }}
              className="wz-step"
              aria-current={s.state === 'current' ? 'step' : undefined}
              disabled={!s.reachable}
              title={!s.reachable ? s.reason : undefined}
              onClick={() => onGo(s.id)}
            >
              <span className="wz-mark" aria-hidden="true">{MARK[s.state](s.id)}</span>
              <span className="wz-label">{s.label}</span>
              <span className="sr-only"> ({STATE_TEXT[s.state]}{!s.reachable && s.reason ? `: ${s.reason}` : ''})</span>
            </button>
          </li>
        ))}
      </ol>
      {current && <p className="wz-compact" aria-hidden="true">Step {current.id} of {steps.length} · {current.label}</p>}
    </nav>
  );
}
