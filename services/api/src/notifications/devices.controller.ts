import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { UserRateLimit } from '../common/ratelimit/user-rate-limit.decorator';
import { DevicesService } from './devices.service';
import { DeviceResponseDto, RegisterDeviceDto } from './dto/device.dto';

/** Push token kaydı — her kimliği doğrulanmış kullanıcı yalnız kendi cihazlarını yönetir. */
@Controller('users/me/devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  /** Upsert: uygulama her açılışta çağırır (`last_seen_at` tazelenir, token yenilenebilir). */
  @Post()
  @HttpCode(HttpStatus.OK)
  // Açılış + token yenileme başına bir çağrı; bol sınır, sahte token selini keser.
  @UserRateLimit({ name: 'device-register', limit: 20, windowSeconds: 300 })
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterDeviceDto,
  ): Promise<DeviceResponseDto> {
    return DeviceResponseDto.from(await this.devices.register(user.id, dto.token, dto.platform));
  }

  /** Çıkışta: bu cihaza artık bu hesabın bildirimi gitmez. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.devices.unregister(user.id, id);
  }
}
