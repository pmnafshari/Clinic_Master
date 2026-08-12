import { Module, OnModuleInit } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PatientsModule } from '../patients/patients.module';
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
import { PatientIntakeTool } from './tools/patient-intake.tool';
import { BookAppointmentTool } from './tools/book-appointment.tool';
import { RescheduleAppointmentTool } from './tools/reschedule-appointment.tool';
import { CancelAppointmentTool } from './tools/cancel-appointment.tool';
import { IdempotencyService } from './idempotency/idempotency.service';

@Module({
  imports: [AppointmentsModule, UsersModule, BillingModule, PatientsModule],
  providers: [
    ToolRegistryService,
    ToolExecutorService,
    ClinicInfoTool,
    ServicePricingTool,
    CheckAvailabilityTool,
    MyAppointmentsTool,
    MyInvoicesTool,
    MyBalanceTool,
    PatientIntakeTool,
    BookAppointmentTool,
    RescheduleAppointmentTool,
    CancelAppointmentTool,
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
    private myBalance: MyBalanceTool,
    private patientIntake: PatientIntakeTool,
    private bookAppointment: BookAppointmentTool,
    private rescheduleAppointment: RescheduleAppointmentTool,
    private cancelAppointment: CancelAppointmentTool
  ) {}

  onModuleInit(): void {
    this.registry.register(this.clinicInfo);
    this.registry.register(this.servicePricing);
    this.registry.register(this.checkAvailability);
    this.registry.register(this.myAppointments);
    this.registry.register(this.myInvoices);
    this.registry.register(this.myBalance);
    this.registry.register(this.patientIntake);
    this.registry.register(this.bookAppointment);
    this.registry.register(this.rescheduleAppointment);
    this.registry.register(this.cancelAppointment);
  }
}
