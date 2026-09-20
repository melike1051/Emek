import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import type { Review } from '../reviews.service';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating!: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  comment?: string;
}

export class ReviewResponseDto {
  id!: string;
  bookingId!: string;
  subjectUserId!: string;
  rating!: number;
  comment!: string | null;
  createdAt!: string;

  static from(review: Review): ReviewResponseDto {
    return {
      id: review.id,
      bookingId: review.bookingId,
      subjectUserId: review.subjectUserId,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt.toISOString(),
    };
  }
}
