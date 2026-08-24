import { Module, OnModuleInit } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PatientsModule } from '../patients/patients.module';
import { UsersModule } from '../users/users.module';
import { BillingModule } from '../billing/billing.module';
import { AuditModule } from '../audit/audit.module';
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
import { ClaudeAgentService } from './agent/claude.agent';
import { VoiceController } from './voice.controller';
import { VoiceSessionStore } from './session/voice-session.store';
import { VoiceGateway } from './transport/voice.gateway';
import { VoiceTurnRunner } from './transport/voice-turn-runner';
import { TransportMetricsService } from './transport/transport-metrics.service';
import { VoiceSocketGateway } from './transport/voice-socket.gateway';
import { VOICE_BROWSER_CONFIG, VOICE_BROWSER_FLAG } from './voice-browser.config';
import { SPEECH_TO_TEXT_FACTORY } from './speech/speech-to-text.interface';
import { DeepgramSttService } from './speech/deepgram-stt.service';
import { TEXT_TO_SPEECH_FACTORY } from './speech/text-to-speech.interface';
import { ElevenLabsTtsService } from './speech/elevenlabs-tts.service';
import { VOICE_CONFIG, VOICE_FEATURE_FLAG } from './voice.config';

@Module({
  imports: [AppointmentsModule, UsersModule, BillingModule, PatientsModule, AuditModule],
  controllers: [VoiceController],
  providers: [
    ClaudeAgentService,
    VoiceSessionStore,
    VoiceGateway,
    VoiceTurnRunner,
    TransportMetricsService,
    VoiceSocketGateway,
    { provide: VOICE_BROWSER_FLAG, useValue: VOICE_BROWSER_CONFIG },
    // A new recogniser per connection — see SPEECH_TO_TEXT_FACTORY. Binding
    // the class directly would hand every concurrent caller the same socket.
    { provide: SPEECH_TO_TEXT_FACTORY, useValue: () => new DeepgramSttService() },
    // Same lifecycle: one synthesiser per connection, so one caller hanging up
    // cannot cancel everybody else's audio.
    { provide: TEXT_TO_SPEECH_FACTORY, useValue: () => new ElevenLabsTtsService() },
    { provide: VOICE_FEATURE_FLAG, useValue: VOICE_CONFIG },
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
  exports: [ToolRegistryService, ToolExecutorService, VoiceSessionStore],
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
