import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ReportingService } from './reporting.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { DateRangeDto, OptionalDateRangeDto } from './dto/date-range.dto';

@ApiTags('reports')
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class ReportingController {
  constructor(private reportingService: ReportingService) {}

  @Get('dashboard')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get dashboard KPIs' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiResponse({ status: 200, description: 'Dashboard KPIs' })
  async getDashboardKPIs(@Query() range: OptionalDateRangeDto) {
    return this.reportingService.getDashboardKPIs(range.startDate, range.endDate);
  }

  @Get('revenue')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get revenue summary' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiResponse({ status: 200, description: 'Revenue summary' })
  async getRevenueSummary(@Query() range: DateRangeDto) {
    return this.reportingService.getRevenueSummary(range.startDate, range.endDate);
  }

  @Get('appointments')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get appointment statistics' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiResponse({ status: 200, description: 'Appointment stats' })
  async getAppointmentStats(@Query() range: DateRangeDto) {
    return this.reportingService.getAppointmentStats(range.startDate, range.endDate);
  }

  @Get('treatments')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get treatment acceptance rate' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiResponse({ status: 200, description: 'Treatment acceptance' })
  async getTreatmentAcceptance(@Query() range: DateRangeDto) {
    return this.reportingService.getTreatmentAcceptance(range.startDate, range.endDate);
  }

  @Get('patients')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get new patient statistics' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiResponse({ status: 200, description: 'New patient stats' })
  async getPatientStats(@Query() range: DateRangeDto) {
    return this.reportingService.getPatientStats(range.startDate, range.endDate);
  }
}
