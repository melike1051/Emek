import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { VERIFICATION_PURPOSES, type VerificationPurpose } from '../identity.types';

export class StartVerificationDto {
  /** Sağlayıcının desteklediği yöntem; geçersiz değer desteklenenlerle birlikte reddedilir. */
  @IsString()
  @MaxLength(40)
  method!: string;

  @IsOptional()
  @IsIn(VERIFICATION_PURPOSES)
  purpose?: VerificationPurpose;
}

export class StartVerificationResponseDto {
  attemptId!: string;
  clientToken!: string;
  expiresAt!: string;
  method!: string;
  purpose!: string;
}

export class VerificationAttemptResponseDto {
  id!: string;
  status!: string;
  purpose!: string;
  method!: string;
  resultCode!: string | null;
  assuranceLevel!: string | null;
  createdAt!: string;
  expiresAt!: string;
  completedAt!: string | null;
}

export class IdentityStatusResponseDto {
  level!: string;
  identityVerified!: boolean;
  assuranceLevel!: string | null;
  verifiedAt!: string | null;
  provider!: string | null;
}

export class VerificationCallbackResponseDto {
  status!: string;
}
