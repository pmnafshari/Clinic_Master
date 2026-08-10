import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { CreateInvoiceDto } from './dto/create-invoice.dto';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';

@ApiTags('billing')
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiBearerAuth()
export class BillingController {
  constructor(private billingService: BillingService) {}

  @Get('invoices')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get all invoices' })
  @ApiQuery({ name: 'patientId', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiResponse({ status: 200, description: 'List of invoices' })
  async findAllInvoices(
    @Query('patientId') patientId?: string,
    @Query('status') status?: string
  ) {
    return this.billingService.findAllInvoices(patientId, status);
  }

  @Get('invoices/:id')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get invoice by ID' })
  @ApiResponse({ status: 200, description: 'Invoice found' })
  @ApiResponse({ status: 404, description: 'Invoice not found' })
  async findInvoiceById(@Param('id') id: string) {
    return this.billingService.findInvoiceById(id);
  }

  @Post('invoices')
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Create invoice' })
  @ApiResponse({ status: 201, description: 'Invoice created' })
  async createInvoice(@Body() createInvoiceDto: CreateInvoiceDto) {
    return this.billingService.createInvoice(createInvoiceDto);
  }

  @Post('invoices/:id/payments')
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Record payment for invoice' })
  @ApiResponse({ status: 201, description: 'Payment recorded' })
  @ApiResponse({ status: 400, description: 'Invalid payment' })
  async recordPayment(
    @Param('id') id: string,
    @Body() createPaymentDto: CreatePaymentDto
  ) {
    return this.billingService.recordPayment(id, createPaymentDto);
  }

  @Get('payments')
  @Roles('admin', 'receptionist')
  @ApiOperation({ summary: 'Get all payments' })
  @ApiQuery({ name: 'invoiceId', required: false })
  @ApiResponse({ status: 200, description: 'List of payments' })
  async findAllPayments(@Query('invoiceId') invoiceId?: string) {
    return this.billingService.findAllPayments(invoiceId);
  }

  @Get('patients/:patientId/balance')
  @Roles('admin', 'dentist', 'receptionist')
  @ApiOperation({ summary: 'Get patient balance' })
  @ApiResponse({ status: 200, description: 'Patient balance' })
  async getPatientBalance(@Param('patientId') patientId: string) {
    return this.billingService.getPatientBalance(patientId);
  }
}
