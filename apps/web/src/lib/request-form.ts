/**
 * Form yolunun saf mantığı. Türkiye 2016'dan beri sabit UTC+3'tür (yaz saati yok); saat
 * tarayıcının saat diliminden bağımsız olarak İstanbul saati kabul edilir.
 */
export const ISTANBUL_OFFSET = '+03:00';

export interface RequestWindowInput {
  date: string; // YYYY-MM-DD
  from: string; // HH:mm
  to: string; // HH:mm
  durationMinutes: number;
}

export type WindowResult =
  { ok: true; preferredStart: string; preferredEnd: string } | { ok: false; error: string };

export function buildWindow(input: RequestWindowInput, now: Date = new Date()): WindowResult {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(input.date) ||
    !/^\d{2}:\d{2}$/.test(input.from) ||
    !/^\d{2}:\d{2}$/.test(input.to)
  ) {
    return { ok: false, error: 'Tarih ve saat aralığını seçin.' };
  }
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 30 ||
    input.durationMinutes > 1440
  ) {
    return { ok: false, error: 'Süre 30 dakika ile 24 saat arasında olmalı.' };
  }
  const start = new Date(`${input.date}T${input.from}:00${ISTANBUL_OFFSET}`);
  const end = new Date(`${input.date}T${input.to}:00${ISTANBUL_OFFSET}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { ok: false, error: 'Tarih ve saat aralığını seçin.' };
  }
  if (end <= start) return { ok: false, error: 'Bitiş saati başlangıçtan sonra olmalı.' };
  if (start <= now) return { ok: false, error: 'Geçmiş bir zaman seçilemez.' };
  if (end.getTime() - start.getTime() < input.durationMinutes * 60_000) {
    return { ok: false, error: 'Zaman aralığı hizmet süresinden kısa olamaz.' };
  }
  return { ok: true, preferredStart: start.toISOString(), preferredEnd: end.toISOString() };
}

/** ISO → form alanları (İstanbul saati); "Düzelt" akışında mevcut talebi forma taşır. */
export function windowFromIso(
  startIso: string,
  endIso: string,
): Pick<RequestWindowInput, 'date' | 'from' | 'to'> {
  const local = (iso: string) => new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString();
  const start = local(startIso);
  const end = local(endIso);
  return { date: start.slice(0, 10), from: start.slice(11, 16), to: end.slice(11, 16) };
}
