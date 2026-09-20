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
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  AddProviderSkillDto,
  CreateProviderProfileDto,
  ProviderProfileResponseDto,
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
