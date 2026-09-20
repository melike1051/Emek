import { Body, Controller, Get, Patch } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { UpdateUserDto, UserResponseDto } from './dto/user.dto';
import { UsersService } from './users.service';
import type { AppRole } from './user.types';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  /**
   * Yalnızca `/me`: kimliği doğrulanmış kullanıcı kendi kaydına erişir.
   * Kullanıcı id'si yoldan alınmaz — böylece IDOR yüzeyi hiç açılmaz (ADR-0013 §1).
   */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    const found = await this.users.findById(user.id);
    if (found === null) {
      throw new BusinessException(ErrorCode.NOT_FOUND);
    }
    return UserResponseDto.from(found);
  }

  @Patch('me')
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateUserDto,
  ): Promise<UserResponseDto> {
    const updated = await this.users.updateContact(user.id, dto, user.id);
    return UserResponseDto.from(updated);
  }

  @Get('me/roles')
  roles(@CurrentUser() user: AuthenticatedUser): { roles: AppRole[] } {
    return { roles: user.roles };
  }
}
