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
  issuedAt: Date;
  dueAt: Date;
  items?: InvoiceItem[];
  payments?: Payment[];
  createdAt: Date;
  updatedAt: Date;
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
  createdAt: Date;
}

export interface Payment {
  id: string;
  invoiceId: string;
  invoice?: Invoice;
  amount: number;
  method: PaymentMethod;
  reference?: string;
  paidAt: Date;
  notes?: string;
  createdAt: Date;
}

export type PaymentMethod = 'cash' | 'credit_card' | 'debit_card' | 'insurance' | 'bank_transfer';
