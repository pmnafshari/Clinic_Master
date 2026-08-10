import { Patient } from './patient.types';
import { User } from './user.types';

export interface Appointment {
  id: string;
  patientId: string;
  patient?: Patient;
  providerId: string;
  provider?: User;
  treatmentPlanId?: string;
  startTime: string;
  endTime: string;
  status: AppointmentStatus;
  chairNumber?: string;
  reason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export type AppointmentStatus =
  | 'scheduled'
  | 'confirmed'
  | 'in-progress'
  | 'completed'
  | 'cancelled'
  | 'no-show';

export interface ProviderAvailability {
  id: string;
  providerId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  isAvailable: boolean;
  createdAt: string;
}
