import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { handlePrismaError } from '../../common/utils/prisma-error.util';

@Injectable()
export class PatientsService {
  constructor(private prisma: PrismaService) {}

  async findAll(search?: string, page = 1, limit = 20) {
    const where = search
      ? {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' as const } },
            { lastName: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { phone: { contains: search } },
          ],
        }
      : {};

    try {
      const [patients, total] = await Promise.all([
        this.prisma.patient.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.patient.count({ where }),
      ]);

      return {
        data: patients,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async findById(id: string) {
    const patient = await this.prisma.patient.findUnique({
      where: { id },
      include: {
        appointments: {
          take: 10,
          orderBy: { startTime: 'desc' },
          include: { provider: true },
        },
        treatmentPlans: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
        invoices: {
          take: 5,
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!patient) {
      throw new NotFoundException('Patient not found');
    }

    return patient;
  }

  async create(createPatientDto: CreatePatientDto) {
    if (createPatientDto.email) {
      const existingPatient = await this.prisma.patient.findFirst({
        where: { email: createPatientDto.email },
      });

      if (existingPatient) {
        throw new ConflictException('Patient with this email already exists');
      }
    }

    const { dateOfBirth, ...rest } = createPatientDto;

    const dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) {
      throw new BadRequestException('Invalid date of birth');
    }

    try {
      return await this.prisma.patient.create({
        data: {
          ...rest,
          dateOfBirth: dob,
        },
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async update(id: string, updatePatientDto: UpdatePatientDto) {
    await this.findById(id);

    if (updatePatientDto.email) {
      const existingPatient = await this.prisma.patient.findFirst({
        where: { email: updatePatientDto.email, NOT: { id } },
      });

      if (existingPatient) {
        throw new ConflictException('Patient with this email already exists');
      }
    }

    try {
      return await this.prisma.patient.update({
        where: { id },
        data: updatePatientDto,
      });
    } catch (error) {
      handlePrismaError(error);
    }
  }

  async getVisitHistory(patientId: string) {
    await this.findById(patientId);

    return this.prisma.appointment.findMany({
      where: { patientId },
      orderBy: { startTime: 'desc' },
      include: {
        provider: true,
        clinicalCharts: true,
      },
    });
  }
}
