import { Controller, Get, Post, Patch, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { ChartingService } from './charting.service';
import { CreateChartDto } from './dto/create-chart.dto';
import { CreateToothEntryDto } from './dto/create-tooth-entry.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('charting')
@Controller('charting')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ChartingController {
  constructor(private chartingService: ChartingService) {}

  @Get('patient/:patientId')
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Get patient charts' })
  @ApiResponse({ status: 200, description: 'Patient charts' })
  async findByPatient(@Param('patientId') patientId: string) {
    return this.chartingService.findByPatient(patientId);
  }

  @Get(':id')
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Get chart by ID' })
  @ApiResponse({ status: 200, description: 'Chart found' })
  @ApiResponse({ status: 404, description: 'Chart not found' })
  async findOne(@Param('id') id: string) {
    return this.chartingService.findById(id);
  }

  @Post()
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Create clinical chart' })
  @ApiResponse({ status: 201, description: 'Chart created' })
  async create(@Body() createChartDto: CreateChartDto) {
    return this.chartingService.create(createChartDto);
  }

  @Patch(':id')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Update chart' })
  @ApiResponse({ status: 200, description: 'Chart updated' })
  async update(@Param('id') id: string, @Body() updateData: { clinicalNotes?: string }) {
    return this.chartingService.update(id, updateData);
  }

  @Post(':id/teeth')
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Add tooth entry to chart' })
  @ApiResponse({ status: 201, description: 'Tooth entry created' })
  async addToothEntry(@Param('id') id: string, @Body() createToothEntryDto: CreateToothEntryDto) {
    return this.chartingService.addToothEntry(id, createToothEntryDto);
  }

  @Patch('teeth/:entryId')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Update tooth entry' })
  @ApiResponse({ status: 200, description: 'Tooth entry updated' })
  async updateToothEntry(
    @Param('entryId') entryId: string,
    @Body() updateData: Partial<CreateToothEntryDto>
  ) {
    return this.chartingService.updateToothEntry(entryId, updateData);
  }

  @Delete('teeth/:entryId')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Delete tooth entry' })
  @ApiResponse({ status: 200, description: 'Tooth entry deleted' })
  async deleteToothEntry(@Param('entryId') entryId: string) {
    return this.chartingService.deleteToothEntry(entryId);
  }
}
