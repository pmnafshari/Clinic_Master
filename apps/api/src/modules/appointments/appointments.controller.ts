import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { AppointmentsService } from './appointments.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('appointments')
@Controller('appointments')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class AppointmentsController {
  constructor(private appointmentsService: AppointmentsService) {}

  @Get()
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Get all appointments' })
  @ApiQuery({ name: 'providerId', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'List of appointments' })
  async findAll(
    @Query('providerId') providerId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('status') status?: string
  ) {
    return this.appointmentsService.findAll({ providerId, startDate, endDate, status });
  }

  @Get('availability')
  @Roles('admin', 'dentist', 'assistant', 'receptionist', 'patient')
  @ApiOperation({ summary: 'Get available time slots for a provider on a date' })
  @ApiQuery({ name: 'providerId', required: true })
  @ApiQuery({ name: 'date', required: true, example: '2026-08-15' })
  @ApiResponse({ status: 200, description: 'Available time slots' })
  async getAvailability(
    @Query('providerId') providerId: string,
    @Query('date') date: string
  ) {
    return this.appointmentsService.getAvailability(providerId, date);
  }

  @Get(':id')
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Get appointment by ID' })
  @ApiResponse({ status: 200, description: 'Appointment found' })
  @ApiResponse({ status: 404, description: 'Appointment not found' })
  async findOne(@Param('id') id: string) {
    return this.appointmentsService.findById(id);
  }

  @Post()
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Create a new appointment' })
  @ApiResponse({ status: 201, description: 'Appointment created' })
  @ApiResponse({ status: 409, description: 'Scheduling conflict' })
  async create(@Body() createAppointmentDto: CreateAppointmentDto) {
    return this.appointmentsService.create(createAppointmentDto);
  }

  @Patch(':id')
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Update appointment' })
  @ApiResponse({ status: 200, description: 'Appointment updated' })
  async update(@Param('id') id: string, @Body() updateAppointmentDto: UpdateAppointmentDto) {
    return this.appointmentsService.update(id, updateAppointmentDto);
  }

  @Patch(':id/status')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Update appointment status' })
  @ApiResponse({ status: 200, description: 'Status updated' })
  async updateStatus(@Param('id') id: string, @Body('status') status: string) {
    return this.appointmentsService.updateStatus(id, status);
  }

  @Delete(':id')
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Cancel appointment' })
  @ApiResponse({ status: 200, description: 'Appointment cancelled' })
  async cancel(@Param('id') id: string) {
    return this.appointmentsService.cancel(id);
  }
}
