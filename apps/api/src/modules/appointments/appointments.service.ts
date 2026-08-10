import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import type { AppointmentStatus } from '@smileflow/shared-types';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateAppointmentDto } from './dto/create-appointment.dto';
import { UpdateAppointmentDto } from './dto/update-appointment.dto';
import { handlePrismaError } from '../../common/utils/prisma-error.util';
import { USER_PROVIDER_SELECT } from '../../common/constants/prisma-selects';

@Injectable()
export class AppointmentsService {
  constructor(private prisma: PrismaService) {}

  async findAll(filters?: { providerId?: string; startDate?: string; endDate?: string; status?: string }) {
    const where: any = {};

    if (filters?.providerId) {
      where.providerId = filters.providerId;
    }

    if (filters?.startDate && filters?.endDate) {
      where.startTime = {
        gte: new Date(filters.startDate),
        lte: new Date(filters.endDate),
      };
    }

    if (filters?.status) {
      where.status = filters.status;
    }

    try {
      return await this.prisma.appointment.findMany({
        where,
        include: {
          patient: true,
          provider: { select: USER_PROVIDER_SELECT },
          treatmentPlan: true,
        },
        orderBy: { startTime: 'asc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findById(id: string) {
    const appointment = await this.prisma.appointment.findUnique({
      where: { id },
      include: {
        patient: true,
        provider: { select: USER_PROVIDER_SELECT },
        treatmentPlan: true,
        clinicalCharts: true,
      },
    });

    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }

    return appointment;
  }

  async create(createAppointmentDto: CreateAppointmentDto) {
    const { patientId, providerId, startTime, endTime } = createAppointmentDto;

    const conflict = await this.prisma.appointment.findFirst({
      where: {
        providerId,
        status: { notIn: ['cancelled'] },
        OR: [
          {
            startTime: { lt: new Date(endTime) },
            endTime: { gt: new Date(startTime) },
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
          patientId,
          providerId,
          startTime: new Date(startTime),
          endTime: new Date(endTime),
          status: createAppointmentDto.status || 'scheduled',
          chairNumber: createAppointmentDto.chairNumber,
          reason: createAppointmentDto.reason,
          notes: createAppointmentDto.notes,
          treatmentPlanId: createAppointmentDto.treatmentPlanId,
        },
        include: {
          patient: true,
          provider: { select: USER_PROVIDER_SELECT },
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async update(id: string, updateAppointmentDto: UpdateAppointmentDto) {
    await this.findById(id);

    if (updateAppointmentDto.startTime && updateAppointmentDto.endTime) {
      const appointment = await this.findById(id);
      const conflict = await this.prisma.appointment.findFirst({
        where: {
          providerId: updateAppointmentDto.providerId || appointment.providerId,
          id: { not: id },
          status: { notIn: ['cancelled'] },
          OR: [
            {
              startTime: { lt: new Date(updateAppointmentDto.endTime) },
              endTime: { gt: new Date(updateAppointmentDto.startTime) },
            },
          ],
        },
      });

      if (conflict) {
        throw new ConflictException('Provider has a conflicting appointment');
      }
    }

    try {
      return await this.prisma.appointment.update({
        where: { id },
        data: {
          ...updateAppointmentDto,
          startTime: updateAppointmentDto.startTime ? new Date(updateAppointmentDto.startTime) : undefined,
          endTime: updateAppointmentDto.endTime ? new Date(updateAppointmentDto.endTime) : undefined,
        },
        include: {
          patient: true,
          provider: { select: USER_PROVIDER_SELECT },
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async updateStatus(id: string, status: string) {
    await this.findById(id);

    // Single source of truth shared with the web client, so adding a status
    // cannot leave the two sides disagreeing about what is valid.
    const validStatuses: AppointmentStatus[] = [
      'scheduled',
      'confirmed',
      'in-progress',
      'completed',
      'cancelled',
      'no-show',
    ];
    if (!validStatuses.includes(status as AppointmentStatus)) {
      throw new BadRequestException(`Invalid status: ${status}`);
    }

    try {
      return await this.prisma.appointment.update({
        where: { id },
        data: { status },
        include: {
          patient: true,
          provider: { select: USER_PROVIDER_SELECT },
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async cancel(id: string) {
    return this.updateStatus(id, 'cancelled');
  }

  async getAvailability(providerId: string, date: string) {
    const dayStart = new Date(date);
    dayStart.setHours(8, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(18, 0, 0, 0);

    const existingAppointments = await this.prisma.appointment.findMany({
      where: {
        providerId,
        status: { notIn: ['cancelled'] },
        startTime: { gte: dayStart, lt: dayEnd },
      },
      select: { startTime: true, endTime: true },
      orderBy: { startTime: 'asc' },
    });

    const slots: Array<{ time: string; available: boolean }> = [];
    for (let hour = 8; hour < 18; hour++) {
      for (let min = 0; min < 60; min += 30) {
        const slotTime = new Date(date);
        slotTime.setHours(hour, min, 0, 0);
        const slotEnd = new Date(slotTime.getTime() + 30 * 60 * 1000);

        const isBooked = existingAppointments.some(
          (apt) => apt.startTime < slotEnd && apt.endTime > slotTime
        );

        const timeStr = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
        slots.push({ time: timeStr, available: !isBooked });
      }
    }

    return slots;
  }
}
