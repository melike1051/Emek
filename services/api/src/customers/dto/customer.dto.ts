import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { CustomerProfile } from '../customers.service';

export class CreateCustomerProfileDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @IsObject()
  preferences?: Record<string, unknown>;
}

export class UpdateCustomerProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName?: string;

  @IsOptional()
  @IsObject()
  preferences?: Record<string, unknown>;
}

export class CustomerProfileResponseDto {
  userId!: string;
  displayName!: string;
  preferences!: Record<string, unknown>;
  createdAt!: string;
  updatedAt!: string;

  static from(profile: CustomerProfile): CustomerProfileResponseDto {
    return {
      userId: profile.userId,
      displayName: profile.displayName,
      preferences: profile.preferences,
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }
}
