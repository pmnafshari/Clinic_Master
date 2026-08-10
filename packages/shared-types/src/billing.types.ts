import { Patient } from './patient.types';
import { TreatmentPlan } from './treatment.types';
import { Appointment } from './appointment.types';

export interface Invoice {
  id: string;
  patientId: string;
  patient?: Patient;
  treatmentPlanId?: string;
  treatmentPlan?: TreatmentPlan;
  appointmentId?: string;
  appointment?: Appointment;
  invoiceNumber: string;
  subtotal: number;
  tax: number;
  total: number;
  status: InvoiceStatus;
  issuedAt: string;
  dueAt: string;
  items?: InvoiceItem[];
  payments?: Payment[];
  createdAt: string;
  updatedAt: string;
}

export type InvoiceStatus = 'unpaid' | 'partial' | 'paid' | 'overdue' | 'cancelled';

export interface InvoiceItem {
  id: string;
  invoiceId: string;
  description: string;
  procedureCode?: string;
  quantity: number;
  unitPrice: number;
  total: number;
  createdAt: string;
}

export interface Payment {
  id: string;
  invoiceId: string;
  invoice?: Invoice;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  paidAt: string;
  notes?: string;
  createdAt: string;
}

export type PaymentMethod = 'cash' | 'credit_card' | 'debit_card' | 'insurance' | 'bank_transfer';
