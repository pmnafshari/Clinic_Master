import { Module } from '@nestjs/common';
import { ChartingController } from './charting.controller';
import { ChartingService } from './charting.service';

@Module({
  controllers: [ChartingController],
  providers: [ChartingService],
  exports: [ChartingService],
})
export class ChartingModule {}
