import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { CurrentUser, Roles, type AuthenticatedUser } from '../auth/auth.decorators';
import { BusinessException } from '../common/errors/business.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { CustomersService } from './customers.service';
import {
  CreateCustomerProfileDto,
  CustomerProfileResponseDto,
  UpdateCustomerProfileDto,
} from './dto/customer.dto';

@Controller('customers')
@Roles('CUSTOMER')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post('profile')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCustomerProfileDto,
  ): Promise<CustomerProfileResponseDto> {
    const profile = await this.customers.create(user.id, dto);
    return CustomerProfileResponseDto.from(profile);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<CustomerProfileResponseDto> {
    const profile = await this.customers.findByUserId(user.id);
    if (profile === null) {
      throw new BusinessException(ErrorCode.PROFILE_NOT_FOUND);
    }
    return CustomerProfileResponseDto.from(profile);
  }

  @Patch('me')
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateCustomerProfileDto,
  ): Promise<CustomerProfileResponseDto> {
    const profile = await this.customers.update(user.id, dto);
    return CustomerProfileResponseDto.from(profile);
  }
}
