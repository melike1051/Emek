import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/auth.decorators';
import { RateLimit } from '../common/ratelimit/rate-limit.decorator';
import { CreateReviewDto, ReviewResponseDto } from './dto/review.dto';
import { ReviewsService } from './reviews.service';

@Controller()
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  @Post('bookings/:id/review')
  @HttpCode(HttpStatus.CREATED)
  @RateLimit({ name: 'review-create', limit: 20, windowSeconds: 60 })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateReviewDto,
  ): Promise<ReviewResponseDto> {
    const review = await this.reviews.create({
      bookingId: id,
      authorUserId: user.id,
      rating: dto.rating,
      ...(dto.comment !== undefined ? { comment: dto.comment } : {}),
    });
    return ReviewResponseDto.from(review);
  }

  /**
   * Bir kullanıcı hakkındaki değerlendirmeler.
   *
   * Kimlik doğrulaması gerekir (deny by default): puanlar herkese açık bir API'den
   * toplu olarak çekilebilseydi, sağlayıcı profilleri dışarıdan haritalanabilirdi.
   */
  @Get('users/:id/reviews')
  async listForUser(@Param('id', ParseUUIDPipe) id: string): Promise<ReviewResponseDto[]> {
    const reviews = await this.reviews.listForSubject(id);
    return reviews.map(ReviewResponseDto.from);
  }
}
