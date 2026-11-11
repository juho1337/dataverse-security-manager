import { Icon } from './Icon';

export type MatrixView = 'privilege' | 'depth';

const OPTIONS: readonly { id: MatrixView; label: string }[] = [
  { id: 'privilege', label: 'Privilege Matrix' },
  { id: 'depth', label: 'Depth Matrix' },
];

interface Props {
  readonly value: MatrixView;
  readonly onChange: (v: MatrixView) => void;
}

/** Segmented control (radio group): two presentations of the same canonical role privilege state. */
export function ViewSwitch({ value, onChange }: Props) {
  return (
    <div role="radiogroup" aria-label="Matrix view" className="view-switch">
      {OPTIONS.map((o) => (
        <label key={o.id} className={`view-option${value === o.id ? ' selected' : ''}`}>
          <input type="radio" name="matrix-view" value={o.id} checked={value === o.id} onChange={() => onChange(o.id)} />
          <Icon name={o.id} />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  );
}
