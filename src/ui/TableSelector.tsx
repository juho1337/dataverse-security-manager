import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { countUnsupported, filterTables } from '../application/tables';
import type { TableInfo } from '../domain/privileges';
import type { AsyncState } from './useAsync';

interface Props {
  readonly state: AsyncState<readonly TableInfo[]>;
  readonly selected: TableInfo | null;
  readonly onSelect: (table: TableInfo) => void;
  readonly onRetry: () => void;
}

/** Searchable table combobox (ARIA combobox/listbox pattern) over display name and logical name. */
export function TableSelector({ state, selected, onSelect, onRetry }: Props) {
  const uid = useId();
  const listId = `${uid}-list`;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [showUnsupported, setShowUnsupported] = useState(false);
  const [active, setActive] = useState(0);

  const tables = state.phase === 'done' && state.result.status !== 'error' ? state.result.data : [];
  const options = useMemo(() => filterTables(tables, query, showUnsupported), [tables, query, showUnsupported]);
  const unsupported = countUnsupported(tables);

  const choose = (t: TableInfo) => {
    if (!t.supported) return;
    onSelect(t);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, Math.max(options.length - 1, 0)));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open) {
      const t = options[active];
      if (t) {
        e.preventDefault();
        choose(t);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  let status: JSX.Element | null = null;
  if (state.phase === 'loading' || state.phase === 'idle') {
    status = <p role="status" className="hint">Loading tables…</p>;
  } else if (state.result.status === 'error') {
    status = (
      <p role="alert" className="msg msg-error">
        Tables could not be loaded ({state.result.errorClass}): {state.result.message}{' '}
        <button type="button" onClick={onRetry}>Retry</button>
      </p>
    );
  } else if (tables.length === 0) {
    status = <p role="status" className="hint">No tables were returned for this environment.</p>;
  } else if (query !== '' && options.length === 0) {
    status = (
      <p role="status" className="hint">
        No tables match “{query}”. <button type="button" onClick={() => setQuery('')}>Clear search</button>
      </p>
    );
  }

  return (
    <section className="table-selector" aria-label="Table selection">
      <label htmlFor={`${uid}-input`} className="field-label">Table</label>
      <div
        className="combo"
        onBlur={(e) => {
          // Close the popup when focus leaves the selector; option clicks use mousedown+preventDefault, so selection still works.
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
        }}
      >
        <input
          id={`${uid}-input`}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${uid}-opt-${options[active].logicalName}` : undefined}
          placeholder={selected ? `${selected.displayName} (${selected.logicalName})` : 'Search by display or logical name'}
          value={query}
          disabled={state.phase !== 'done' || state.result.status === 'error'}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {open && options.length > 0 && (
          <ul id={listId} role="listbox" aria-label="Tables" className="listbox">
            {options.map((t, i) => (
              <li
                key={t.logicalName}
                id={`${uid}-opt-${t.logicalName}`}
                role="option"
                aria-selected={selected?.logicalName === t.logicalName}
                aria-disabled={!t.supported}
                className={`option${i === active ? ' active' : ''}${t.supported ? '' : ' disabled'}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(t);
                }}
              >
                <span className="option-name">{t.displayName}</span>{' '}
                <span className="option-logical">{t.logicalName}</span>
                {!t.supported && <span className="option-reason"> — {t.unsupportedReason ?? 'Not supported'}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {unsupported > 0 && (
        <label className="check">
          <input type="checkbox" checked={showUnsupported} onChange={(e) => {
              setShowUnsupported(e.target.checked);
              setOpen(true);
            }}
          />
          Show unsupported tables ({unsupported})
        </label>
      )}
      {status}
    </section>
  );
}
