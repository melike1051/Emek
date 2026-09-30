import { Badge } from '@emek/ui';
import { bookingStatusView } from '@/lib/booking';

export function BookingStatusBadge({ status }: { status: string }) {
  const view = bookingStatusView(status);
  return <Badge tone={view.tone}>{view.label}</Badge>;
}
