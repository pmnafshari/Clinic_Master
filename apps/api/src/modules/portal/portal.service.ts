import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { handlePrismaError } from '../../common/utils/prisma-error.util';
import { USER_PROVIDER_SELECT } from '../../common/constants/prisma-selects';

@Injectable()
export class PortalService {
  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient profile not found');
    }

    return user.patient;
  }

  async updateProfile(userId: string, updateData: { phone?: string; address?: string }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient profile not found');
    }

    return this.prisma.patient.update({
      where: { id: user.patient.id },
      data: updateData,
    });
  }

  async getAppointments(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient not found');
    }

    try {
      return await this.prisma.appointment.findMany({
        where: { patientId: user.patient.id },
        include: { provider: { select: USER_PROVIDER_SELECT } },
        orderBy: { startTime: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async bookAppointment(userId: string, appointmentData: {
    providerId: string;
    startTime: string;
    endTime: string;
    reason?: string;
  }) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient not found');
    }

    const conflict = await this.prisma.appointment.findFirst({
      where: {
        providerId: appointmentData.providerId,
        status: { notIn: ['cancelled'] },
        OR: [
          {
            startTime: { lt: new Date(appointmentData.endTime) },
            endTime: { gt: new Date(appointmentData.startTime) },
          },
        ],
      },
    });

    if (conflict) {
      throw new ConflictException('Provider has a conflicting appointment');
    }

    try {
      return await this.prisma.appointment.create({
        data: {
          patientId: user.patient.id,
          providerId: appointmentData.providerId,
          startTime: new Date(appointmentData.startTime),
          endTime: new Date(appointmentData.endTime),
          status: 'scheduled',
          reason: appointmentData.reason,
        },
        include: { provider: { select: USER_PROVIDER_SELECT } },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async getInvoices(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient not found');
    }

    try {
      return await this.prisma.invoice.findMany({
        where: { patientId: user.patient.id },
        include: { items: true, payments: true },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async getTreatments(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient not found');
    }

    try {
      return await this.prisma.treatmentPlan.findMany({
        where: { patientId: user.patient.id },
        include: { items: true, provider: { select: USER_PROVIDER_SELECT } },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async getNotifications(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { patient: true },
    });

    if (!user || !user.patient) {
      throw new NotFoundException('Patient not found');
    }

    try {
      return await this.prisma.notification.findMany({
        where: { patientId: user.patient.id },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }
}
