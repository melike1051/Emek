import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../common/database/unit-of-work';
import type { DevicePlatform } from './dto/device.dto';

export interface UserDevice {
  id: string;
  userId: string;
  platform: DevicePlatform;
  createdAt: Date;
  lastSeenAt: Date;
}

interface DeviceRow {
  id: string;
  user_id: string;
  platform: DevicePlatform;
  created_at: Date;
  last_seen_at: Date;
}

const toDevice = (row: DeviceRow): UserDevice => ({
  id: row.id,
  userId: row.user_id,
  platform: row.platform,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
});

/**
 * Push token kaydı (Faz 16). Token **cihaza** aittir: aynı telefonda başka hesapla giriş
 * yapılınca kayıt yeni kullanıcıya taşınır — önceki hesaba bildirim gitmesin diye. Her işlem
 * yalnız oturumdaki kullanıcıyla kapsanır (IDOR yüzeyi yok).
 */
/** Kullanıcı başına kayıtlı cihaz üst sınırı (telefon + tablet + yedek cihazlar için bol). */
export const MAX_DEVICES_PER_USER = 10;

@Injectable()
export class DevicesService {
  constructor(private readonly uow: UnitOfWork) {}

  async register(userId: string, token: string, platform: DevicePlatform): Promise<UserDevice> {
    return this.uow.withTransaction(async (client) => {
      const result = await client.query<DeviceRow>(
        `INSERT INTO user_devices (user_id, token, platform)
         VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               platform = EXCLUDED.platform,
               last_seen_at = now()
         RETURNING id, user_id, platform, created_at, last_seen_at`,
        [userId, token, platform],
      );
      // Kullanıcı başına üst sınır: sınırsız sahte token her bildirimde teslimat turunu uzatır
      // (kira aşımı → çift gönderim). En uzun süredir görülmeyenler düşer; yeni kayıt korunur.
      await client.query(
        `DELETE FROM user_devices
          WHERE user_id = $1
            AND id NOT IN (SELECT id FROM user_devices WHERE user_id = $1
                            ORDER BY last_seen_at DESC, id LIMIT $2)`,
        [userId, MAX_DEVICES_PER_USER],
      );
      return toDevice(result.rows[0]!);
    });
  }

  /** Yalnız kendi cihazı; yoksa da başarılıdır (çıkışta tekrar çağrılabilir — idempotent). */
  async unregister(userId: string, deviceId: string): Promise<void> {
    await this.uow.withTransaction((client) =>
      client.query(`DELETE FROM user_devices WHERE id = $1 AND user_id = $2`, [deviceId, userId]),
    );
  }
}
