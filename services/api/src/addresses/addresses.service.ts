import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditAction, AuditService } from '../common/audit/audit.service';
import { UnitOfWork } from '../common/database/unit-of-work';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';

export interface Address {
  id: string;
  userId: string;
  label: string | null;
  city: string;
  district: string;
  line: string;
  latitude: number;
  longitude: number;
}

interface AddressRow {
  id: string;
  user_id: string;
  label: string | null;
  city: string;
  district: string;
  line: string;
  latitude: number;
  longitude: number;
}

function toAddress(row: AddressRow): Address {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    city: row.city,
    district: row.district,
    line: row.line,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

/**
 * Sağlayıcının hizmet adresini görebildiği randevu durumları (R-102): ödeme tutulup randevu
 * planlandıktan check-out'a kadar. Kabulden önce ev adresi, işi almayabilecek herkese açılmış
 * olurdu; ödeme alınmadan açılırsa hiç gerçekleşmeyecek randevular adres toplamaya yarardı.
 * Hizmet bitince erişim kapanır — geçmiş müşterilerin adres defteri oluşmaz.
 */
const PROVIDER_ADDRESS_STATUSES: ReadonlySet<string> = new Set([
  'SCHEDULED',
  'PROVIDER_ARRIVING',
  'CHECKED_IN',
  'IN_PROGRESS',
  'CHECKED_OUT',
]);

export interface BookingAddress {
  city: string;
  district: string;
  line: string;
  latitude: number;
  longitude: number;
}

const SELECT_ADDRESS = `
  SELECT id, user_id, label, city, district, line, latitude, longitude
    FROM addresses
`;

/**
 * Adresler kişisel veridir (S1): tüm sorgular kullanıcıyla kapsanır ve adres
 * silinmez, **arşivlenir** — geçmiş rezervasyonlar adrese referans verir
 * (`ON DELETE RESTRICT`) ve kayıt silinirse o rezervasyonların bağlamı kaybolur.
 */
@Injectable()
export class AddressesService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly audit: AuditService,
  ) {}

  async list(userId: string): Promise<Address[]> {
    const rows = await this.uow.query<AddressRow>(
      `${SELECT_ADDRESS} WHERE user_id = $1 AND archived_at IS NULL ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toAddress);
  }

  /** Sahiplikle kapsanmış okuma: başka kullanıcının adresi asla dönmez. */
  /**
   * `client` verilirse okuma o transaction'da yapılır. Transaction içinden havuzdan
   * ikinci bağlantı istemek havuzu kilitler (bkz. `UnitOfWork.queryOn`).
   */
  /**
   * Rezervasyonun hizmet adresi — yalnızca taraflara (R-102).
   *
   * Müşteri kendi adresini her zaman görür. Sağlayıcı yalnız `PROVIDER_ADDRESS_STATUSES`
   * penceresinde görür ve her okuma audit'e yazılır: sağlayıcının müşteri ev adresine
   * erişimi hassas veri erişimidir (K3). Adres arşivlenmiş olsa da döner — randevu ona bağlıdır.
   * Taraf olmayana varlık bile bildirilmez (404).
   */
  async findForBooking(bookingId: string, userId: string): Promise<BookingAddress> {
    return this.uow.withTransaction(async (client) => {
      const result = await client.query<
        BookingAddress & { address_id: string; status: string; is_provider: boolean }
      >(
        `SELECT a.id AS address_id, a.city, a.district, a.line, a.latitude, a.longitude,
                b.status::text AS status, (b.provider_id = $2) AS is_provider
           FROM bookings b
           JOIN addresses a ON a.id = b.address_id
          WHERE b.id = $1 AND (b.customer_id = $2 OR b.provider_id = $2)`,
        [bookingId, userId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new BusinessException(ErrorCode.NOT_FOUND);
      }

      if (row.is_provider) {
        if (!PROVIDER_ADDRESS_STATUSES.has(row.status)) {
          throw new BusinessException(ErrorCode.BOOKING_ADDRESS_UNAVAILABLE, {
            details: { status: row.status },
          });
        }
        await this.audit.record(client, {
          action: AuditAction.BOOKING_ADDRESS_ACCESSED,
          entityType: 'address',
          entityId: row.address_id,
          actorUserId: userId,
          newValue: { bookingId, status: row.status },
        });
      }

      return {
        city: row.city,
        district: row.district,
        line: row.line,
        latitude: row.latitude,
        longitude: row.longitude,
      };
    });
  }

  async findOwned(userId: string, addressId: string, client?: PoolClient): Promise<Address | null> {
    const rows = await this.uow.queryOn<AddressRow>(
      client,
      `${SELECT_ADDRESS} WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [addressId, userId],
    );
    const row = rows[0];
    return row === undefined ? null : toAddress(row);
  }

  async create(
    userId: string,
    input: {
      label?: string;
      city: string;
      district: string;
      line: string;
      latitude: number;
      longitude: number;
    },
  ): Promise<Address> {
    return this.uow.withTransaction(async (client) => {
      const inserted = await client.query<AddressRow>(
        `INSERT INTO addresses (user_id, label, city, district, line, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, user_id, label, city, district, line, latitude, longitude`,
        [
          userId,
          input.label ?? null,
          input.city,
          input.district,
          input.line,
          input.latitude,
          input.longitude,
        ],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        throw new Error('adres oluşturulamadı');
      }

      await this.audit.record(client, {
        action: AuditAction.ADDRESS_CREATED,
        entityType: 'address',
        entityId: row.id,
        actorUserId: userId,
        // Audit adresin **varlığını** kaydeder, içeriğini değil (ADR-0013 §10).
        newValue: { city: row.city, district: row.district },
      });

      return toAddress(row);
    });
  }

  async archive(userId: string, addressId: string): Promise<void> {
    await this.uow.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE addresses SET archived_at = now()
          WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
        [addressId, userId],
      );

      if ((updated.rowCount ?? 0) === 0) {
        throw new BusinessException(ErrorCode.ADDRESS_NOT_FOUND);
      }

      await this.audit.record(client, {
        action: AuditAction.ADDRESS_ARCHIVED,
        entityType: 'address',
        entityId: addressId,
        actorUserId: userId,
      });
    });
  }
}
