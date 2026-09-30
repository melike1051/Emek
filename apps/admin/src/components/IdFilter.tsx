import { useId } from 'react';
import { uuidOrUndefined } from '@/lib/format';
import styles from './admin.module.css';

/** UUID filtre alanı; yarım/yanlış değer sorguyu tetiklemez, yalnızca uyarı gösterir. */
export function IdFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const invalid = value.trim().length > 0 && uuidOrUndefined(value) === undefined;
  return (
    <div className={styles.select}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="UUID"
        spellCheck={false}
        aria-invalid={invalid || undefined}
      />
      {invalid ? <span className={styles.small}>Geçerli, tam bir UUID girin.</span> : null}
    </div>
  );
}
