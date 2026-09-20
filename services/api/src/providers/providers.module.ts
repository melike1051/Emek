import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { AvailabilityService } from './availability.service';
import { ProvidersController } from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [UsersModule],
  controllers: [ProvidersController],
  providers: [ProvidersService, AvailabilityService],
  exports: [ProvidersService, AvailabilityService],
})
export class ProvidersModule {}
