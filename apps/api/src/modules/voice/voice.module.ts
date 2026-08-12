import { Module, OnModuleInit } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { UsersModule } from '../users/users.module';
import { BillingModule } from '../billing/billing.module';
import { ToolRegistryService } from './tools/tool-registry.service';
import { ToolExecutorService } from './tools/tool-executor.service';
import { ClinicInfoTool } from './tools/clinic-info.tool';
import { ServicePricingTool } from './tools/service-pricing.tool';
import { CheckAvailabilityTool } from './tools/check-availability.tool';
import { MyAppointmentsTool } from './tools/my-appointments.tool';
import { MyInvoicesTool } from './tools/my-invoices.tool';
import { MyBalanceTool } from './tools/my-balance.tool';
import { IdempotencyService } from './idempotency/idempotency.service';

@Module({
  imports: [AppointmentsModule, UsersModule, BillingModule],
  providers: [
    ToolRegistryService,
    ToolExecutorService,
    ClinicInfoTool,
    ServicePricingTool,
    CheckAvailabilityTool,
    MyAppointmentsTool,
    MyInvoicesTool,
    MyBalanceTool,
    IdempotencyService,
  ],
  exports: [ToolRegistryService, ToolExecutorService],
})
export class VoiceModule implements OnModuleInit {
  constructor(
    private registry: ToolRegistryService,
    private clinicInfo: ClinicInfoTool,
    private servicePricing: ServicePricingTool,
    private checkAvailability: CheckAvailabilityTool,
    private myAppointments: MyAppointmentsTool,
    private myInvoices: MyInvoicesTool,
    private myBalance: MyBalanceTool
  ) {}

  onModuleInit(): void {
    this.registry.register(this.clinicInfo);
    this.registry.register(this.servicePricing);
    this.registry.register(this.checkAvailability);
    this.registry.register(this.myAppointments);
    this.registry.register(this.myInvoices);
    this.registry.register(this.myBalance);
  }
}
