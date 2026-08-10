import { IsNumber, IsString, IsOptional, IsEnum, Min, Max, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreatePaymentDto {
  @ApiProperty({ example: 500.0 })
  @IsNumber({}, { message: 'Payment amount must be a number' })
  @Min(0.01, { message: 'Payment amount must be at least $0.01' })
  @Max(1000000, { message: 'Payment amount must be at most $1,000,000' })
  amount: number;

  @ApiProperty({ enum: ['cash', 'credit_card', 'debit_card', 'insurance', 'bank_transfer'] })
  @IsEnum(['cash', 'credit_card', 'debit_card', 'insurance', 'bank_transfer'], {
    message: 'Payment method must be cash, credit card, debit card, insurance, or bank transfer',
  })
  method: string;

  @ApiPropertyOptional({ example: 'REF-123456' })
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: 'Reference must be at most 100 characters' })
  reference?: string;

  @ApiPropertyOptional({ example: 'Partial payment' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Notes must be at most 500 characters' })
  notes?: string;
}
