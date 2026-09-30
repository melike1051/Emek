import { Badge } from '@emek/ui';
import type { StatusView } from '@/lib/labels';

/** Etiket + teknik kod: operatör ekrandaki durumu log/audit kaydıyla eşleştirebilir. */
export function StatusBadge({ view, code }: { view: (value: string) => StatusView; code: string }) {
  const { label, tone } = view(code);
  return (
    <span title={code}>
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}
