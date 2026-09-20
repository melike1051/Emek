import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { AddressesService } from './addresses.service';
import { AddressResponseDto, CreateAddressDto } from './dto/address.dto';

@Controller('addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser): Promise<AddressResponseDto[]> {
    const addresses = await this.addresses.list(user.id);
    return addresses.map(AddressResponseDto.from);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateAddressDto,
  ): Promise<AddressResponseDto> {
    const address = await this.addresses.create(user.id, dto);
    return AddressResponseDto.from(address);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    // Silme değil arşivleme: geçmiş rezervasyonlar bu adrese referans verir.
    await this.addresses.archive(user.id, id);
  }
}
