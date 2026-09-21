import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  AddProviderServiceDto,
  AddServiceAreaDto,
  AddProviderSkillDto,
  CreateProviderProfileDto,
  ProviderProfileResponseDto,
  ProviderServiceAreaResponseDto,
  ProviderServiceResponseDto,
  ProviderSkillResponseDto,
  UpdateProviderProfileDto,
} from './dto/provider.dto';
import { AvailabilityService } from './availability.service';
import {
  AddAvailabilityDto,
  AvailabilityQueryDto,
  AvailabilityResponseDto,
} from './dto/availability.dto';
import { ProvidersService } from './providers.service';

@Controller('providers')
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly availability: AvailabilityService,
  ) {}

  /**
   * Profil oluşturma `PROVIDER` rolü **gerektirmez**: rol tam bu işlemle verilir.
   * Kimlik doğrulaması yine zorunludur (global AuthGuard).
   */
  @Post('profile')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateProviderProfileDto,
  ): Promise<ProviderProfileResponseDto> {
    const profile = await this.providers.create(user.id, dto);
    return ProviderProfileResponseDto.from(profile);
  }

  @Get('me')
  @Roles('PROVIDER')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<ProviderProfileResponseDto> {
    const profile = await this.providers.findByUserId(user.id);
    if (profile === null) {
      throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
    }
    return ProviderProfileResponseDto.from(profile);
  }

  @Patch('me')
  @Roles('PROVIDER')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProviderProfileDto,
  ): Promise<ProviderProfileResponseDto> {
    const profile = await this.providers.update(user.id, dto);
    return ProviderProfileResponseDto.from(profile);
  }

  @Get('me/skills')
  @Roles('PROVIDER')
  async skills(@CurrentUser() user: AuthenticatedUser): Promise<ProviderSkillResponseDto[]> {
    const skills = await this.providers.listSkills(user.id);
    return skills.map(ProviderSkillResponseDto.from);
  }

  @Post('me/skills')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.CREATED)
  async addSkill(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddProviderSkillDto,
  ): Promise<ProviderSkillResponseDto[]> {
    const skills = await this.providers.addSkill(user.id, dto);
    return skills.map(ProviderSkillResponseDto.from);
  }

  /**
   * Sağlayıcının sunduğu hizmetler.
   *
   * Aday havuzu buradan başlar (Faz 7): hizmeti beyan etmemiş bir sağlayıcı o hizmet
   * için hiç aday olmaz. "Yetkinliği var, demek ki sunuyordur" varsayımı, sağlayıcıyı
   * satmak istemediği bir işe atardı.
   */
  @Get('me/services')
  @Roles('PROVIDER')
  async services(@CurrentUser() user: AuthenticatedUser): Promise<ProviderServiceResponseDto[]> {
    const services = await this.providers.listServices(user.id);
    return services.map(ProviderServiceResponseDto.from);
  }

  @Post('me/services')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'provider-service-add', limit: 20, windowSeconds: 60 })
  async addService(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddProviderServiceDto,
  ): Promise<ProviderServiceResponseDto[]> {
    const services = await this.providers.addService(user.id, dto.serviceId);
    return services.map(ProviderServiceResponseDto.from);
  }

  @Delete('me/services/:serviceId')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<void> {
    await this.providers.removeService(user.id, serviceId);
  }

  /**
   * Hizmet bölgeleri.
   *
   * Birbirine değmeyen bölgeler birden fazla kayıtla ifade edilir: tek bir daire
   * "iki ayrı ilçede çalışıyorum" durumunu anlatamaz.
   */
  @Get('me/service-areas')
  @Roles('PROVIDER')
  async serviceAreas(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProviderServiceAreaResponseDto[]> {
    const areas = await this.providers.listServiceAreas(user.id);
    return areas.map(ProviderServiceAreaResponseDto.from);
  }

  /**
   * Oran sınırı burada özellikle önemlidir: her bölge, o bölgedeki her müşterinin
   * aday havuzu sorgusuna maliyet ekler ve mesafe referans noktasını değiştirir.
   * Sayı üst sınırı veritabanında (5); bu sınır yazma hızını da bağlar.
   */
  @Post('me/service-areas')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'provider-service-area-add', limit: 10, windowSeconds: 60 })
  async addServiceArea(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddServiceAreaDto,
  ): Promise<ProviderServiceAreaResponseDto> {
    const area = await this.providers.addServiceArea(user.id, dto);
    return ProviderServiceAreaResponseDto.from(area);
  }

  @Delete('me/service-areas/:areaId')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeServiceArea(
    @CurrentUser() user: AuthenticatedUser,
    @Param('areaId', ParseUUIDPipe) areaId: string,
  ): Promise<void> {
    await this.providers.removeServiceArea(user.id, areaId);
  }

  @Get('me/availability')
  @Roles('PROVIDER')
  async listAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponseDto[]> {
    const windows = await this.availability.list(user.id, { from: query.from, to: query.to });
    return windows.map(AvailabilityResponseDto.from);
  }

  @Post('me/availability')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.CREATED)
  async addAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AddAvailabilityDto,
  ): Promise<AvailabilityResponseDto> {
    const window = await this.availability.add(user.id, {
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
    });
    return AvailabilityResponseDto.from(window);
  }

  @Delete('me/availability/:availabilityId')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('availabilityId', ParseUUIDPipe) availabilityId: string,
  ): Promise<void> {
    await this.availability.remove(user.id, availabilityId);
  }

  @Delete('me/skills/:skillId')
  @Roles('PROVIDER')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSkill(
    @CurrentUser() user: AuthenticatedUser,
    @Param('skillId', ParseUUIDPipe) skillId: string,
  ): Promise<void> {
    // Silme daima kendi profilinden yapılır: yol parametresi yalnızca yetkinliği belirtir,
    // sahibi belirtmez (IDOR yüzeyi açılmaz).
    await this.providers.removeSkill(user.id, skillId);
  }
}
