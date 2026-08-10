import { Patient } from './patient.types';
import { User } from './user.types';

export interface TreatmentPlan {
  id: string;
  patientId: string;
  patient?: Patient;
  providerId: string;
  provider?: User;
  title: string;
  description?: string;
  status: TreatmentPlanStatus;
  estimatedCost?: number;
  items?: TreatmentPlanItem[];
  createdAt: string;
  updatedAt: string;
}

export type TreatmentPlanStatus = 'planned' | 'approved' | 'in-progress' | 'completed' | 'cancelled';

export interface TreatmentPlanItem {
  id: string;
  treatmentPlanId: string;
  procedureCode: string;
  description: string;
  cost: number;
  status: TreatmentItemStatus;
  teethInvolved?: number;
  notes?: string;
  createdAt: string;
}

export type TreatmentItemStatus = 'planned' | 'approved' | 'completed';
