import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  SKILL_LEVELS,
  type ProviderProfile,
  type ProviderSkill,
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
