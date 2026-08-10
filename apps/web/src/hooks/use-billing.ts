import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Invoice,
  InvoiceItem,
  InvoiceStatus,
  Payment,
  PaymentMethod,
} from '@smileflow/shared-types';
import apiClient from '@/lib/api-client';

export type { Invoice, InvoiceItem, InvoiceStatus, Payment, PaymentMethod };

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
