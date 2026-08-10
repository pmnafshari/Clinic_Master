import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';

export interface Invoice {
  id: string;
  patientId: string;
  patient?: {
    id: string;
    firstName: string;
    lastName: string;
  };
  invoiceNumber: string;
  subtotal: number;
  tax: number;
  total: number;
  status: 'unpaid' | 'partial' | 'paid' | 'overdue' | 'cancelled';
  issuedAt: string;
  dueAt: string;
  items?: InvoiceItem[];
  payments?: Payment[];
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  invoiceId: string;
  description: string;
  procedureCode?: string;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface Payment {
  id: string;
  invoiceId: string;
  amount: number;
  method: 'cash' | 'credit_card' | 'debit_card' | 'insurance' | 'bank_transfer';
  reference?: string;
  paidAt: string;
  notes?: string;
}

export function useInvoices(patientId?: string, status?: string) {
  return useQuery<Invoice[]>({
    queryKey: ['invoices', patientId, status],
    queryFn: () =>
      apiClient
        .get('/billing/invoices', { params: { patientId, status } })
        .then((res) => res.data),
  });
}

export function useInvoice(id: string) {
  return useQuery<Invoice>({
    queryKey: ['invoice', id],
    queryFn: () => apiClient.get(`/billing/invoices/${id}`).then((res) => res.data),
    enabled: !!id,
  });
}

export function useCreateInvoice() {
  const queryClient = useQueryClient();

  return useMutation({
    // Subtotal, tax and total are calculated by the API from these items.
    mutationFn: (data: {
      patientId: string;
      items: { description: string; quantity?: number; unitPrice: number }[];
      treatmentPlanId?: string;
      appointmentId?: string;
    }) => apiClient.post('/billing/invoices', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export function useRecordPayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      invoiceId,
      data,
    }: {
      invoiceId: string;
      data: { amount: number; method: string; reference?: string; notes?: string };
    }) => apiClient.post(`/billing/invoices/${invoiceId}/payments`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}

export function usePatientBalance(patientId: string) {
  return useQuery<{ totalBilled: number; totalPaid: number; balance: number }>({
    queryKey: ['patient-balance', patientId],
    queryFn: () =>
      apiClient.get(`/billing/patients/${patientId}/balance`).then((res) => res.data),
    enabled: !!patientId,
  });
}
