import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateChartDto } from './dto/create-chart.dto';
import { CreateToothEntryDto } from './dto/create-tooth-entry.dto';
import { handlePrismaError } from '../../common/utils/prisma-error.util';
import { USER_PROVIDER_SELECT } from '../../common/constants/prisma-selects';

@Injectable()
export class ChartingService {
  constructor(private prisma: PrismaService) {}

  async findByPatient(patientId: string) {
    try {
      return await this.prisma.clinicalChart.findMany({
        where: { patientId },
        include: {
          toothEntries: true,
          provider: { select: USER_PROVIDER_SELECT },
          appointment: true,
        },
        orderBy: { createdAt: 'desc' },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findById(id: string) {
    const chart = await this.prisma.clinicalChart.findUnique({
      where: { id },
      include: {
        toothEntries: true,
        provider: { select: USER_PROVIDER_SELECT },
        patient: true,
        appointment: true,
      },
    });

    if (!chart) {
      throw new NotFoundException('Clinical chart not found');
    }

    return chart;
  }

  async create(createChartDto: CreateChartDto) {
    try {
      return await this.prisma.clinicalChart.create({
        data: {
          patientId: createChartDto.patientId,
          appointmentId: createChartDto.appointmentId,
          providerId: createChartDto.providerId,
          clinicalNotes: createChartDto.clinicalNotes,
        },
        include: {
          toothEntries: true,
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async update(id: string, updateData: { clinicalNotes?: string }) {
    await this.findById(id);

    try {
      return await this.prisma.clinicalChart.update({
        where: { id },
        data: updateData,
        include: {
          toothEntries: true,
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async addToothEntry(chartId: string, createToothEntryDto: CreateToothEntryDto) {
    await this.findById(chartId);

    try {
      return await this.prisma.chartToothEntry.create({
        data: {
          chartId,
          toothNumber: createToothEntryDto.toothNumber,
          surface: createToothEntryDto.surface,
          condition: createToothEntryDto.condition,
          procedure: createToothEntryDto.procedure,
          status: createToothEntryDto.status,
          notes: createToothEntryDto.notes,
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async updateToothEntry(entryId: string, updateData: Partial<CreateToothEntryDto>) {
    const entry = await this.prisma.chartToothEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      throw new NotFoundException('Tooth entry not found');
    }

    try {
      return await this.prisma.chartToothEntry.update({
        where: { id: entryId },
        data: updateData,
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async deleteToothEntry(entryId: string) {
    const entry = await this.prisma.chartToothEntry.findUnique({
      where: { id: entryId },
    });

    if (!entry) {
      throw new NotFoundException('Tooth entry not found');
    }

    try {
      return await this.prisma.chartToothEntry.delete({
        where: { id: entryId },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }
}
