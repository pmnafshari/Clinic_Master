import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CreateNotificationDto } from './dto/create-notification.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('notifications')
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  @Roles('admin', 'dentist', 'assistant', 'receptionist', 'patient')
  @ApiOperation({ summary: 'Get notifications for current user' })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiResponse({ status: 200, description: 'List of notifications' })
  async findAll(@CurrentUser() user: any, @Query('patientId') patientId?: string) {
    if (user.role?.name === 'patient') {
      patientId = undefined;
    }
    return this.notificationsService.findAllForUser(user, patientId);
  }

  @Get(':id')
  @Roles('admin', 'dentist', 'assistant', 'receptionist', 'patient')
  @ApiOperation({ summary: 'Get notification by ID' })
  @ApiResponse({ status: 200, description: 'Notification found' })
  @ApiResponse({ status: 404, description: 'Notification not found' })
  async findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.notificationsService.findById(id, user);
  }

  @Post()
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Create notification' })
  @ApiResponse({ status: 201, description: 'Notification created' })
  async create(@Body() createNotificationDto: CreateNotificationDto) {
    return this.notificationsService.create(createNotificationDto);
  }

  @Patch(':id/sent')
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Mark notification as sent' })
  @ApiResponse({ status: 200, description: 'Notification marked as sent' })
  async markAsSent(@Param('id') id: string) {
    return this.notificationsService.markAsSent(id);
  }

  @Patch(':id/read')
  @Roles('admin', 'dentist', 'assistant', 'receptionist', 'patient')
  @ApiOperation({ summary: 'Mark notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked as read' })
  async markAsRead(@Param('id') id: string, @CurrentUser() user: any) {
    return this.notificationsService.markAsRead(id, user);
  }

  @Delete(':id')
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Delete notification' })
  @ApiResponse({ status: 200, description: 'Notification deleted' })
  async delete(@Param('id') id: string) {
    return this.notificationsService.delete(id);
  }
}
