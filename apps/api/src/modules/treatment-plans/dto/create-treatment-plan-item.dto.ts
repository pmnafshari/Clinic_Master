import { IsString, IsNumber, IsOptional, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTreatmentPlanItemDto {
  @ApiProperty({ example: 'D1120' })
  @IsString()
  procedureCode: string;

  @ApiProperty({ example: 'Composite filling - posterior' })
  @IsString()
  description: string;

  @ApiProperty({ example: 150.0 })
  @IsNumber()
  cost: number;

  @ApiPropertyOptional({ enum: ['planned', 'approved', 'completed'] })
  @IsOptional()
  @IsEnum(['planned', 'approved', 'completed'])
  status?: string;

  @ApiPropertyOptional({ example: 14 })
  @IsOptional()
  @IsNumber()
  teethInvolved?: number;

  @ApiPropertyOptional({ example: 'Small cavity on mesial surface' })
  @IsOptional()
  @IsString()
  notes?: string;
}
