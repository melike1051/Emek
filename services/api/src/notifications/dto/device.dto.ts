import { IsIn, IsString, Length } from 'class-validator';
import type { UserDevice } from '../devices.service';

export const DEVICE_PLATFORMS = ['IOS', 'ANDROID'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** FCM kayıt token'ı. Token kişisel veridir; loglanmaz, yanıtta geri dönmez. */
export class RegisterDeviceDto {
  @IsString()
  @Length(1, 4096)
  token!: string;

  @IsIn(DEVICE_PLATFORMS)
  platform!: DevicePlatform;
}

/** Token dönmez: istemci zaten biliyor, yanıtta tekrarlamak log/yakalama yüzeyi açar. */
export class DeviceResponseDto {
  id!: string;
  platform!: DevicePlatform;
  createdAt!: string;
  lastSeenAt!: string;

  static from(device: UserDevice): DeviceResponseDto {
    return {
      id: device.id,
      platform: device.platform,
      createdAt: device.createdAt.toISOString(),
      lastSeenAt: device.lastSeenAt.toISOString(),
    };
  }
}
