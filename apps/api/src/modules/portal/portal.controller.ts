import { Controller, Get, Post, Patch, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { PortalService } from './portal.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('portal')
@Controller('portal')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class PortalController {
  constructor(private portalService: PortalService) {}

  @Get('profile')
  @Roles('patient')
  @ApiOperation({ summary: 'Get patient profile' })
  @ApiResponse({ status: 200, description: 'Patient profile' })
  async getProfile(@CurrentUser() user: any) {
    return this.portalService.getProfile(user.id);
  }

  @Patch('profile')
  @Roles('patient')
  @ApiOperation({ summary: 'Update patient profile' })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  async updateProfile(
    @CurrentUser() user: any,
    @Body() updateData: { phone?: string; address?: string }
  ) {
    return this.portalService.updateProfile(user.id, updateData);
  }

  @Get('appointments')
  @Roles('patient')
  @ApiOperation({ summary: 'Get patient appointments' })
  @ApiResponse({ status: 200, description: 'List of appointments' })
  async getAppointments(@CurrentUser() user: any) {
    return this.portalService.getAppointments(user.id);
  }

  @Post('appointments')
  @Roles('patient')
  @ApiOperation({ summary: 'Book appointment' })
  @ApiResponse({ status: 201, description: 'Appointment booked' })
  @ApiResponse({ status: 409, description: 'Scheduling conflict' })
  async bookAppointment(
    @CurrentUser() user: any,
    @Body() appointmentData: { providerId: string; startTime: string; endTime: string; reason?: string }
  ) {
    return this.portalService.bookAppointment(user.id, appointmentData);
  }

  @Get('invoices')
  @Roles('patient')
  @ApiOperation({ summary: 'Get patient invoices' })
  @ApiResponse({ status: 200, description: 'List of invoices' })
  async getInvoices(@CurrentUser() user: any) {
    return this.portalService.getInvoices(user.id);
  }

  @Get('treatments')
  @Roles('patient')
  @ApiOperation({ summary: 'Get patient treatments' })
  @ApiResponse({ status: 200, description: 'List of treatments' })
  async getTreatments(@CurrentUser() user: any) {
    return this.portalService.getTreatments(user.id);
  }

  @Get('notifications')
  @Roles('patient')
  @ApiOperation({ summary: 'Get patient notifications' })
  @ApiResponse({ status: 200, description: 'List of notifications' })
  async getNotifications(@CurrentUser() user: any) {
    return this.portalService.getNotifications(user.id);
  }
}
