import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { PatientsService } from './patients.service';
import { CreatePatientDto } from './dto/create-patient.dto';
import { UpdatePatientDto } from './dto/update-patient.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('patients')
@Controller('patients')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class PatientsController {
  constructor(private patientsService: PatientsService) {}

  @Get()
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Get all patients' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResponse({ status: 200, description: 'List of patients' })
  async findAll(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string
  ) {
    return this.patientsService.findAll(search, page ? parseInt(page, 10) : undefined, limit ? parseInt(limit, 10) : undefined);
  }

  @Get(':id')
  @Roles('admin', 'dentist', 'assistant', 'receptionist')
  @ApiOperation({ summary: 'Get patient by ID' })
  @ApiResponse({ status: 200, description: 'Patient found' })
  @ApiResponse({ status: 404, description: 'Patient not found' })
  async findOne(@Param('id') id: string) {
    return this.patientsService.findById(id);
  }

  @Post()
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Create a new patient' })
  @ApiResponse({ status: 201, description: 'Patient created' })
  @ApiResponse({ status: 409, description: 'Email already exists' })
  async create(@Body() createPatientDto: CreatePatientDto) {
    return this.patientsService.create(createPatientDto);
  }

  @Patch(':id')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Update patient' })
  @ApiResponse({ status: 200, description: 'Patient updated' })
  async update(@Param('id') id: string, @Body() updatePatientDto: UpdatePatientDto) {
    return this.patientsService.update(id, updatePatientDto);
  }

  @Get(':id/history')
  @Roles('admin', 'dentist', 'assistant')
  @ApiOperation({ summary: 'Get patient visit history' })
  @ApiResponse({ status: 200, description: 'Visit history' })
  async getVisitHistory(@Param('id') id: string) {
    return this.patientsService.getVisitHistory(id);
  }
}
