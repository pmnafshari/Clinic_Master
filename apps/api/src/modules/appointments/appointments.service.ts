import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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
    const start = new Date(startTime);
    const end = new Date(endTime);

    if (end <= start) {
      throw new BadRequestException('Appointment must end after it starts');
    }

    try {
      // The conflict check and the insert run in one serializable transaction
      // so they cannot interleave with a competing booking. The database also
      // enforces an exclusion constraint as a backstop — see the
      // 20260810160000_appointment_no_overlap migration.
      return await this.prisma.$transaction(
        async (tx) => {
          const conflict = await tx.appointment.findFirst({
            where: {
              providerId,
              status: { notIn: ['cancelled'] },
              startTime: { lt: end },
              endTime: { gt: start },
            },
          });

          if (conflict) {
            throw new ConflictException('Provider has a conflicting appointment');
          }

          return await tx.appointment.create({
            data: {
              patientId,
              providerId,
              startTime: start,
              endTime: end,
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
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) {
        throw error;
      }
      handlePrismaError(error);
    }
  }

  async update(id: string, updateAppointmentDto: UpdateAppointmentDto) {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const appointment = await tx.appointment.findUnique({ where: { id } });
          if (!appointment) {
            throw new NotFoundException('Appointment not found');
          }

          // A move only needs a conflict check when it actually changes the
          // provider or the time window.
          const start = updateAppointmentDto.startTime
            ? new Date(updateAppointmentDto.startTime)
            : appointment.startTime;
          const end = updateAppointmentDto.endTime
            ? new Date(updateAppointmentDto.endTime)
            : appointment.endTime;
          const providerId = updateAppointmentDto.providerId || appointment.providerId;

          if (end <= start) {
            throw new BadRequestException('Appointment must end after it starts');
          }

          const conflict = await tx.appointment.findFirst({
            where: {
              providerId,
              id: { not: id },
              status: { notIn: ['cancelled'] },
              startTime: { lt: end },
              endTime: { gt: start },
            },
          });

          if (conflict) {
            throw new ConflictException('Provider has a conflicting appointment');
          }

          return await tx.appointment.update({
            where: { id },
            data: {
              ...updateAppointmentDto,
              startTime: updateAppointmentDto.startTime ? start : undefined,
              endTime: updateAppointmentDto.endTime ? end : undefined,
            },
            include: {
              patient: true,
              provider: { select: USER_PROVIDER_SELECT },
            },
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
      );
    } catch (error) {
      if (
        error instanceof ConflictException ||
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
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
