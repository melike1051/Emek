import { useId, type ReactNode } from 'react';
import styles from './admin.module.css';

export interface Option {
  value: string;
  label: string;
}

/** Durum filtresi. Boş değer "tümü"/backend varsayılanı demektir ve sorguya yazılmaz. */
export function SelectFilter({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  allLabel?: string;
}) {
  const id = useId();
  return (
    <div className={styles.select}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {allLabel !== undefined ? <option value="">{allLabel}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className={styles.filters} role="search">
      {children}
    </div>
  );
}

/** Kayıt kimliği: kısa gösterim, tamamı `title` ve ekran okuyucu için. */
export function Id({ value }: { value: string | null | undefined }) {
  if (!value) return <span>—</span>;
  return (
    <code className={styles.code} title={value} aria-label={value}>
      {value.split('-')[0]}
    </code>
  );
}

export function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className={styles.facts}>
      {items.map(([term, detail]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}
