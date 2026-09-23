import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CursorQueryDto } from '../../common/pagination/cursor-query.dto';
import {
  PROVIDER_STATES,
  SKILL_LEVELS,
  type ProviderProfile,
  type ProviderService,
  type ProviderServiceArea,
  type ProviderSkill,
  type ProviderState,
  type SkillLevel,
} from '../providers.service';

export class CreateProviderProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(80)
  experienceYears?: number;
}

export class UpdateProviderProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  bio?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(80)
  experienceYears?: number;

  /**
   * Günlük rezervasyon üst sınırı (Faz 7 kapasite kısıtı).
   *
   * Sınırlar veritabanındaki CHECK ile aynı: sözleşme seviyesinde reddetmek
   * istemciye net geri bildirim verir, veritabanı son savunma olarak kalır.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  maxDailyBookings?: number;
}

export class AddProviderServiceDto {
  @IsUUID()
  serviceId!: string;
}

export class AddProviderSkillDto {
  @IsUUID()
  skillId!: string;

  @IsIn(SKILL_LEVELS)
  level!: SkillLevel;
}

export class ProviderProfileResponseDto {
  userId!: string;
  displayName!: string;
  bio!: string | null;
  experienceYears!: number | null;
  ratingAvg!: number | null;
  ratingCount!: number;
  maxDailyBookings!: number;
  state!: string;
  createdAt!: string;
  updatedAt!: string;

  static from(profile: ProviderProfile): ProviderProfileResponseDto {
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      bio: profile.bio,
      experienceYears: profile.experienceYears,
      ratingAvg: profile.ratingAvg,
      ratingCount: profile.ratingCount,
      maxDailyBookings: profile.maxDailyBookings,
      state: profile.state,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }
}

export class ProviderSkillResponseDto {
  skillId!: string;
  slug!: string;
  name!: string;
  level!: string;
  verified!: boolean;

  static from(skill: ProviderSkill): ProviderSkillResponseDto {
    return { ...skill };
  }
}

export class ProviderServiceResponseDto {
  serviceId!: string;
  slug!: string;
  name!: string;
  active!: boolean;

  static from(service: ProviderService): ProviderServiceResponseDto {
    return {
      serviceId: service.serviceId,
      slug: service.slug,
      name: service.name,
      active: service.active,
    };
  }
}

/**
 * Hizmet bölgesi girişi: merkez + yarıçap.
 *
 * Serbest poligon kabul edilmez (bkz. `ProvidersService.addServiceArea`). Yarıçap
 * sınırları veritabanındaki CHECK ile aynıdır.
 */
export class AddServiceAreaDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsInt()
  @Min(500)
  @Max(100000)
  radiusMeters!: number;
}

export class ProviderServiceAreaResponseDto {
  id!: string;
  name!: string;
  latitude!: number;
  longitude!: number;
  radiusMeters!: number;
  active!: boolean;

  static from(area: ProviderServiceArea): ProviderServiceAreaResponseDto {
    return {
      id: area.id,
      name: area.name,
      latitude: area.latitude,
      longitude: area.longitude,
      radiusMeters: area.radiusMeters,
      active: area.active,
    };
  }
}

// --- Admin: sağlayıcı onay kuyruğu (Faz 10) ---

export class ProviderQueueQueryDto extends CursorQueryDto {
  @IsOptional()
  @IsIn(PROVIDER_STATES)
  state?: ProviderState;
}

export class ProviderQueueResponseDto {
  items!: ProviderProfileResponseDto[];
  nextCursor!: string | null;
}

export class RejectProviderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class SuspendProviderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
