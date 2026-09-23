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
