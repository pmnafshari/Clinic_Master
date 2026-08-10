import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateTreatmentPlanDto } from './dto/create-treatment-plan.dto';
import { CreateTreatmentPlanItemDto } from './dto/create-treatment-plan-item.dto';
import { USER_PROVIDER_SELECT } from '../../common/constants/prisma-selects';

@Injectable()
export class TreatmentPlansService {
  constructor(private prisma: PrismaService) {}

  async findAll(patientId?: string) {
    const where = patientId ? { patientId } : {};

    return this.prisma.treatmentPlan.findMany({
      where,
      include: {
        patient: true,
        provider: { select: USER_PROVIDER_SELECT },
        items: true,
        invoices: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const plan = await this.prisma.treatmentPlan.findUnique({
      where: { id },
      include: {
        patient: true,
        provider: { select: USER_PROVIDER_SELECT },
        items: true,
        appointments: true,
        invoices: true,
      },
    });

    if (!plan) {
      throw new NotFoundException('Treatment plan not found');
    }

    return plan;
  }

  async create(createTreatmentPlanDto: CreateTreatmentPlanDto) {
    const { items, ...planData } = createTreatmentPlanDto;

    return this.prisma.treatmentPlan.create({
      data: {
        ...planData,
        items: items
          ? {
              create: items.map((item) => ({
                procedureCode: item.procedureCode,
                description: item.description,
                cost: item.cost,
                status: item.status || 'planned',
                teethInvolved: item.teethInvolved,
                notes: item.notes,
              })),
            }
          : undefined,
      },
      include: {
        items: true,
      },
    });
  }

  async update(id: string, updateData: Partial<CreateTreatmentPlanDto>) {
    await this.findById(id);

    const { items, ...planData } = updateData;

    return this.prisma.treatmentPlan.update({
      where: { id },
      data: planData,
      include: {
        items: true,
      },
    });
  }

  async addItem(planId: string, createItemDto: CreateTreatmentPlanItemDto) {
    await this.findById(planId);

    return this.prisma.treatmentPlanItem.create({
      data: {
        treatmentPlanId: planId,
        procedureCode: createItemDto.procedureCode,
        description: createItemDto.description,
        cost: createItemDto.cost,
        status: createItemDto.status || 'planned',
        teethInvolved: createItemDto.teethInvolved,
        notes: createItemDto.notes,
      },
    });
  }

  async updateItem(itemId: string, updateData: Partial<CreateTreatmentPlanItemDto>) {
    const item = await this.prisma.treatmentPlanItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      throw new NotFoundException('Treatment plan item not found');
    }

    return this.prisma.treatmentPlanItem.update({
      where: { id: itemId },
      data: updateData,
    });
  }

  async deleteItem(itemId: string) {
    const item = await this.prisma.treatmentPlanItem.findUnique({
      where: { id: itemId },
    });

    if (!item) {
      throw new NotFoundException('Treatment plan item not found');
    }

    return this.prisma.treatmentPlanItem.delete({
      where: { id: itemId },
    });
  }

  async delete(id: string) {
    const plan = await this.findById(id);

    if (plan.invoices.length > 0) {
      throw new BadRequestException('Cannot delete plan with associated invoices');
    }

    await this.prisma.treatmentPlanItem.deleteMany({
      where: { treatmentPlanId: id },
    });

    return this.prisma.treatmentPlan.delete({
      where: { id },
    });
  }
}
