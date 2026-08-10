import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateNotificationDto } from './dto/create-notification.dto';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async findAllForUser(user: any, patientId?: string) {
    if (user.role?.name === 'patient') {
      const patient = await this.findPatientForUser(user.id);
      return this.findAllByWhere({ patientId: patient?.id });
    }
    return this.findAllByWhere({ userId: user.id, patientId });
  }

  async findAllByWhere(filters: { userId?: string; patientId?: string }) {
    const where: any = {};

    if (filters.userId) {
      where.userId = filters.userId;
    }

    if (filters.patientId) {
      where.patientId = filters.patientId;
    }

    return this.prisma.notification.findMany({
      where,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, email: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string, user: any) {
    const notification = await this.findRawById(id);

    if (user.role?.name === 'patient') {
      const patient = await this.findPatientForUser(user.id);
      if (!patient || notification.patientId !== patient.id) {
        throw new ForbiddenException('You do not have access to this notification');
      }
    }

    return notification;
  }

  async create(createNotificationDto: CreateNotificationDto) {
    return this.prisma.notification.create({
      data: {
        patientId: createNotificationDto.patientId,
        userId: createNotificationDto.userId,
        type: createNotificationDto.type,
        channel: createNotificationDto.channel,
        subject: createNotificationDto.subject,
        content: createNotificationDto.content,
        status: 'pending',
        scheduledAt: createNotificationDto.scheduledAt
          ? new Date(createNotificationDto.scheduledAt)
          : new Date(),
      },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
  }

  async markAsSent(id: string) {
    await this.findRawById(id);

    return this.prisma.notification.update({
      where: { id },
      data: {
        status: 'sent',
        sentAt: new Date(),
      },
    });
  }

  async markAsRead(id: string, user: any) {
    await this.findById(id, user);

    return this.prisma.notification.update({
      where: { id },
      data: {
        status: 'read',
      },
    });
  }

  async delete(id: string) {
    await this.findRawById(id);

    return this.prisma.notification.delete({
      where: { id },
    });
  }

  async createAppointmentReminder(appointmentId: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { patient: true },
    });

    if (!appointment) {
      return null;
    }

    return this.create({
      patientId: appointment.patientId,
      type: 'appointment_reminder',
      channel: 'email',
      subject: 'Appointment Reminder',
      content: `You have an appointment scheduled for ${appointment.startTime.toLocaleDateString()}.`,
      scheduledAt: new Date(appointment.startTime.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    });
  }

  private async findPatientForUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { patient: { select: { id: true } } },
    });
    return user?.patient ?? null;
  }

  private async findRawById(id: string) {
    const notification = await this.prisma.notification.findUnique({
      where: { id },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, email: true } },
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found');
    }

    return notification;
  }
}
