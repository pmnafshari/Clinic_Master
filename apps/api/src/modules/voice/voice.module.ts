import { Module, OnModuleInit } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { UsersModule } from '../users/users.module';
import { ToolRegistryService } from './tools/tool-registry.service';
import { ToolExecutorService } from './tools/tool-executor.service';
import { ClinicInfoTool } from './tools/clinic-info.tool';
import { ServicePricingTool } from './tools/service-pricing.tool';
import { CheckAvailabilityTool } from './tools/check-availability.tool';

@Module({
  imports: [AppointmentsModule, UsersModule],
  providers: [
    ToolRegistryService,
    ToolExecutorService,
    ClinicInfoTool,
    ServicePricingTool,
    CheckAvailabilityTool,
  ],
  exports: [ToolRegistryService, ToolExecutorService],
})
export class VoiceModule implements OnModuleInit {
  constructor(
    private registry: ToolRegistryService,
    private clinicInfo: ClinicInfoTool,
    private servicePricing: ServicePricingTool,
    private checkAvailability: CheckAvailabilityTool
  ) {}

  onModuleInit(): void {
    this.registry.register(this.clinicInfo);
    this.registry.register(this.servicePricing);
    this.registry.register(this.checkAvailability);
  }
}
