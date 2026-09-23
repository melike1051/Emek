import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { getRequestContext } from '../logging/request-context';

/** Denetlenen işlem adları. Serbest metin değil: rapor ve alarmlar bu kümeye dayanır. */
export const AuditAction = {
  USER_REGISTERED: 'USER_REGISTERED',
  USER_UPDATED: 'USER_UPDATED',
  USER_ANONYMIZED: 'USER_ANONYMIZED',
  ROLE_GRANTED: 'ROLE_GRANTED',
  ROLE_REVOKED: 'ROLE_REVOKED',
  CUSTOMER_PROFILE_CREATED: 'CUSTOMER_PROFILE_CREATED',
  CUSTOMER_PROFILE_UPDATED: 'CUSTOMER_PROFILE_UPDATED',
  PROVIDER_PROFILE_CREATED: 'PROVIDER_PROFILE_CREATED',
  PROVIDER_PROFILE_UPDATED: 'PROVIDER_PROFILE_UPDATED',
  PROVIDER_SKILL_ADDED: 'PROVIDER_SKILL_ADDED',
  PROVIDER_SKILL_REMOVED: 'PROVIDER_SKILL_REMOVED',
  PROVIDER_STATE_CHANGED: 'PROVIDER_STATE_CHANGED',
  IDENTITY_VERIFICATION_STARTED: 'IDENTITY_VERIFICATION_STARTED',
  IDENTITY_VERIFIED: 'IDENTITY_VERIFIED',
  IDENTITY_REJECTED: 'IDENTITY_REJECTED',
  ACCOUNT_RECOVERY_REQUESTED: 'ACCOUNT_RECOVERY_REQUESTED',
  ACCOUNT_RECOVERED: 'ACCOUNT_RECOVERED',
  ACCOUNT_RECOVERY_REJECTED: 'ACCOUNT_RECOVERY_REJECTED',
  ADDRESS_CREATED: 'ADDRESS_CREATED',
  ADDRESS_ARCHIVED: 'ADDRESS_ARCHIVED',
  SERVICE_AREA_CREATED: 'SERVICE_AREA_CREATED',
  SERVICE_AREA_REMOVED: 'SERVICE_AREA_REMOVED',
  AVAILABILITY_ADDED: 'AVAILABILITY_ADDED',
  AVAILABILITY_REMOVED: 'AVAILABILITY_REMOVED',
  BOOKING_REQUEST_CREATED: 'BOOKING_REQUEST_CREATED',
  BOOKING_CREATED: 'BOOKING_CREATED',
  BOOKING_STATUS_CHANGED: 'BOOKING_STATUS_CHANGED',
  PAYMENT_STATUS_CHANGED: 'PAYMENT_STATUS_CHANGED',
  PAYMENT_REAUTHORIZED: 'PAYMENT_REAUTHORIZED',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  PAYMENT_RELEASE_BLOCKED: 'PAYMENT_RELEASE_BLOCKED',
  PAYMENT_EVENT_REJECTED: 'PAYMENT_EVENT_REJECTED',
  DISPUTE_OPENED: 'DISPUTE_OPENED',
  DISPUTE_RESOLVED: 'DISPUTE_RESOLVED',
  DOCUMENT_REGISTERED: 'DOCUMENT_REGISTERED',
  DOCUMENT_UPLOAD_CONFIRMED: 'DOCUMENT_UPLOAD_CONFIRMED',
  DOCUMENT_ACCESS_GRANTED: 'DOCUMENT_ACCESS_GRANTED',
  REVIEW_CREATED: 'REVIEW_CREATED',
  PROVIDER_SERVICE_ADDED: 'PROVIDER_SERVICE_ADDED',
  PROVIDER_SERVICE_REMOVED: 'PROVIDER_SERVICE_REMOVED',
  PROVIDER_CAPACITY_UPDATED: 'PROVIDER_CAPACITY_UPDATED',
  MATCHING_RUN_COMPLETED: 'MATCHING_RUN_COMPLETED',
  BOOKING_MATCHED: 'BOOKING_MATCHED',
  SAFETY_SESSION_STARTED: 'SAFETY_SESSION_STARTED',
  SAFETY_SESSION_CLOSED: 'SAFETY_SESSION_CLOSED',
  SAFETY_RISK_CHANGED: 'SAFETY_RISK_CHANGED',
  SAFETY_PANIC_RAISED: 'SAFETY_PANIC_RAISED',
  SAFETY_RISK_OVERRIDDEN: 'SAFETY_RISK_OVERRIDDEN',
  SAFETY_LOCATION_PURGED: 'SAFETY_LOCATION_PURGED',
  SAFETY_LOCATION_ACCESSED: 'SAFETY_LOCATION_ACCESSED',
  DEAD_LETTER_EVENT_RESOLVED: 'DEAD_LETTER_EVENT_RESOLVED',
  NOTIFICATION_JOB_RETRIED: 'NOTIFICATION_JOB_RETRIED',
  RECONCILIATION_RUN_COMPLETED: 'RECONCILIATION_RUN_COMPLETED',
  RECONCILIATION_DISCREPANCY_RESOLVED: 'RECONCILIATION_DISCREPANCY_RESOLVED',
  AUDIT_CHAIN_VERIFIED: 'AUDIT_CHAIN_VERIFIED',
  AUDIT_CHAIN_BROKEN: 'AUDIT_CHAIN_BROKEN',
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

export interface AuditEntry {
  action: AuditActionValue;
  entityType: string;
  entityId?: string;
  actorUserId?: string;
  /** Değişiklik öncesi/sonrası. Hassas alan taşımaz (ADR-0013 §10). */
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  ipAddress?: string;
}

/**
 * Audit kaydı, denetlenen işlemle **aynı transaction'da** yazılır (ADR-0013 §9):
 * "event ile sonra yazarız" yaklaşımı, işlem başarılı olup audit kaydının kaybolduğu
 * bir durum üretir.
 *
 * Hash zinciri ve değişmezlik veritabanı trigger'larında; uygulama bunları atlayamaz.
 */
@Injectable()
export class AuditService {
  async record(client: PoolClient, entry: AuditEntry): Promise<void> {
    const requestId = getRequestContext()?.requestId ?? null;

    // Zincir sırası ile `id` sırası ayrışmamalı. `id` (BIGSERIAL) INSERT sırasında
    // atandığı için kilidi trigger içinde almak geç kalır; burada, aynı transaction'da
    // alınır ve transaction bitince otomatik bırakılır. Audit yazımı düşük hacimlidir,
    // serileştirme kabul edilebilir bir bedeldir.
    //
    // Kilit sırası kuralı (Faz 8): bu kilit transaction'daki **son** kilit olmalıdır.
    // Audit yazdıktan sonra bir satır kilidi (booking, oturum, ödeme) almak, o satırı
    // önce kilitleyip sonra audit yazan başka bir yolla deadlock üretir.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('emek.audit_logs.chain'))`);

    await client.query(
      `INSERT INTO audit_logs
         (actor_user_id, action, entity_type, entity_id, old_value, new_value, ip_address, request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.actorUserId ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.oldValue === undefined ? null : JSON.stringify(entry.oldValue),
        entry.newValue === undefined ? null : JSON.stringify(entry.newValue),
        entry.ipAddress ?? null,
        requestId,
      ],
    );
  }
}
