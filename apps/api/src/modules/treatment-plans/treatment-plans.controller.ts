import { Controller, Get, Post, Patch, Delete, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TreatmentPlansService } from './treatment-plans.service';
import { CreateTreatmentPlanDto } from './dto/create-treatment-plan.dto';
import { CreateTreatmentPlanItemDto } from './dto/create-treatment-plan-item.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('treatment-plans')
@Controller('treatment-plans')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class TreatmentPlansController {
  constructor(private treatmentPlansService: TreatmentPlansService) {}

  @Get()
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Get all treatment plans' })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiResponse({ status: 200, description: 'List of treatment plans' })
  async findAll(@Query('patientId') patientId?: string) {
    return this.treatmentPlansService.findAll(patientId);
  }

  @Get(':id')
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Get treatment plan by ID' })
  @ApiResponse({ status: 200, description: 'Treatment plan found' })
  @ApiResponse({ status: 404, description: 'Treatment plan not found' })
  async findOne(@Param('id') id: string) {
    return this.treatmentPlansService.findById(id);
  }

  @Post()
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Create treatment plan' })
  @ApiResponse({ status: 201, description: 'Treatment plan created' })
  async create(@Body() createTreatmentPlanDto: CreateTreatmentPlanDto) {
    return this.treatmentPlansService.create(createTreatmentPlanDto);
  }

  @Patch(':id')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Update treatment plan' })
  @ApiResponse({ status: 200, description: 'Treatment plan updated' })
  async update(@Param('id') id: string, @Body() updateData: Partial<CreateTreatmentPlanDto>) {
    return this.treatmentPlansService.update(id, updateData);
  }

  @Delete(':id')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Delete treatment plan' })
  @ApiResponse({ status: 200, description: 'Treatment plan deleted' })
  async delete(@Param('id') id: string) {
    return this.treatmentPlansService.delete(id);
  }

  @Post(':id/items')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Add item to treatment plan' })
  @ApiResponse({ status: 201, description: 'Item added' })
  async addItem(@Param('id') id: string, @Body() createItemDto: CreateTreatmentPlanItemDto) {
    return this.treatmentPlansService.addItem(id, createItemDto);
  }

  @Patch('items/:itemId')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Update treatment plan item' })
  @ApiResponse({ status: 200, description: 'Item updated' })
  async updateItem(
    @Param('itemId') itemId: string,
    @Body() updateData: Partial<CreateTreatmentPlanItemDto>
  ) {
    return this.treatmentPlansService.updateItem(itemId, updateData);
  }

  @Delete('items/:itemId')
  @Roles('admin', 'dentist')
  @ApiOperation({ summary: 'Delete treatment plan item' })
  @ApiResponse({ status: 200, description: 'Item deleted' })
  async deleteItem(@Param('itemId') itemId: string) {
    return this.treatmentPlansService.deleteItem(itemId);
  }
}
