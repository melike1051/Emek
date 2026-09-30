import { ApiError } from '@emek/api-client';

export interface DisplayError {
  message: string;
  requestId?: string;
}

/** Her hatayı kullanıcıya gösterilebilir biçime indirger; ham exception metni asla gösterilmez. */
export function toDisplayError(error: unknown): DisplayError {
  if (error instanceof ApiError) {
    return error.requestId
      ? { message: error.message, requestId: error.requestId }
      : { message: error.message };
  }
  return { message: 'Beklenmeyen bir hata oluştu. Lütfen tekrar deneyin.' };
}

/**
 * `VALIDATION_FAILED` ayrıntısındaki geçersiz alan adları. Backend biçimi
 * (all-exceptions.filter.ts): `details.fields: ["displayName must be longer than ..."]` —
 * class-validator'ın İngilizce metni; kullanıcıya **gösterilmez**, yalnızca alan adı alınır.
 */
export function invalidFields(error: unknown): string[] {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return [];
  const fields = error.details?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .map((entry) =>
      typeof entry === 'string' ? /^([A-Za-z0-9_.]+)\s/.exec(entry)?.[1] : undefined,
    )
    .filter((name): name is string => name !== undefined);
}
