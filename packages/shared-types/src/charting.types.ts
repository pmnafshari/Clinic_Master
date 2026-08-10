import { Patient } from './patient.types';
import { User } from './user.types';
import { Appointment } from './appointment.types';

export interface ClinicalChart {
  id: string;
  patientId: string;
  patient?: Patient;
  appointmentId?: string;
  appointment?: Appointment;
  providerId: string;
  provider?: User;
  clinicalNotes?: string;
  toothEntries?: ChartToothEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface ChartToothEntry {
  id: string;
  chartId: string;
  toothNumber: number;
  surface?: string;
  condition: string;
  procedure?: string;
  status: ToothEntryStatus;
  notes?: string;
  createdAt: string;
}

export type ToothEntryStatus = 'planned' | 'in-progress' | 'completed';
