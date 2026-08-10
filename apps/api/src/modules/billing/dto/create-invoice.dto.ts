import {
  IsString,
  IsNumber,
  Min,
  Max,
  IsOptional,
  IsArray,
  ArrayNotEmpty,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateInvoiceItemDto {
  @ApiProperty({ example: 'Root Canal Treatment' })
  @IsString({ message: 'Description is required' })
  @MaxLength(255, { message: 'Description must be at most 255 characters' })
  description: string;

  @ApiPropertyOptional({ example: 'D3330' })
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Procedure code must be at most 20 characters' })
  procedureCode?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsNumber({}, { message: 'Quantity must be a number' })
  @Min(1, { message: 'Quantity must be at least 1' })
  @Max(999, { message: 'Quantity must be at most 999' })
  quantity?: number;

  @ApiProperty({ example: 850.0 })
  @IsNumber({}, { message: 'Unit price must be a number' })
  @Min(0.01, { message: 'Unit price must be greater than $0.00' })
  @Max(1000000, { message: 'Unit price must be at most $1,000,000' })
  unitPrice: number;
}

export class CreateInvoiceDto {
  @ApiProperty({ example: 'patient-uuid' })
  @IsString({ message: 'Patient is required' })
  patientId: string;

  @ApiPropertyOptional({ example: 'treatment-plan-uuid' })
  @IsOptional()
  @IsString()
  treatmentPlanId?: string;

  @ApiPropertyOptional({ example: 'appointment-uuid' })
  @IsOptional()
  @IsString()
  appointmentId?: string;

  // subtotal, tax and total are intentionally absent: they are derived from
  // the line items on the server. Accepting them from the client would let a
  // caller invoice themselves for any amount they like.

  @ApiProperty({ type: [CreateInvoiceItemDto] })
  @IsArray()
  @ArrayNotEmpty({ message: 'An invoice must contain at least one line item' })
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceItemDto)
  items: CreateInvoiceItemDto[];
}
