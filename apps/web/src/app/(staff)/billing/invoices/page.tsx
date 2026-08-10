'use client';

import { useState } from 'react';
import { useInvoices, useCreateInvoice } from '@/hooks/use-billing';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, DollarSign, Calendar, Loader2 } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import apiClient, { getErrorMessage } from '@/lib/api-client';
import Link from 'next/link';

const statusColors: Record<string, string> = {
  unpaid: 'bg-yellow-100 text-yellow-800',
  partial: 'bg-orange-100 text-orange-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-800',
};

interface PatientOption {
  id: string;
  firstName: string;
  lastName: string;
}

export default function InvoicesPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPatientId, setNewPatientId] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newAmount, setNewAmount] = useState('');
  const [newError, setNewError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ patientId?: string; amount?: string; description?: string }>({});

  const { data: invoices, isLoading } = useInvoices(undefined, statusFilter);
  const createInvoice = useCreateInvoice();

  const { data: patients } = useQuery<PatientOption[]>({
    queryKey: ['patients-list'],
    queryFn: () => apiClient.get('/patients', { params: { limit: 100 } }).then((res) => res.data.data || res.data),
  });

  const validate = () => {
    const errors: typeof fieldErrors = {};
    if (!newPatientId) errors.patientId = 'Please select a patient';
    if (!newAmount) {
      errors.amount = 'Amount is required';
    } else {
      const amt = parseFloat(newAmount);
      if (isNaN(amt)) errors.amount = 'Amount must be a valid number';
      else if (amt <= 0) errors.amount = 'Amount must be greater than $0.00';
      else if (amt > 1000000) errors.amount = 'Amount must be at most $1,000,000';
    }
    if (!newDescription) errors.description = 'Description is required';
    else if (newDescription.length > 255) errors.description = 'Description must be at most 255 characters';
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreate = () => {
    if (!validate()) return;
    setNewError(null);
    const amount = parseFloat(newAmount);
    createInvoice.mutate(
      {
        patientId: newPatientId,
        items: [{ description: newDescription, quantity: 1, unitPrice: amount }],
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['invoices'] });
          setShowNewModal(false);
          setNewPatientId('');
          setNewDescription('');
          setNewAmount('');
        },
        onError: (err: any) => {
          setNewError(getErrorMessage(err));
        },
      }
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Invoices</h2>
          <p className="text-gray-600">Manage billing and payments</p>
        </div>
        <Button onClick={() => setShowNewModal(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Invoice
        </Button>
      </div>

      {showNewModal && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader>
            <CardTitle>New Invoice</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {newError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{newError}</div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Patient *</Label>
                <select className={`w-full border rounded-lg px-3 py-2 text-sm ${fieldErrors.patientId ? 'border-red-300' : ''}`} value={newPatientId} onChange={(e) => setNewPatientId(e.target.value)}>
                  <option value="">Select patient</option>
                  {patients?.map((p) => (
                    <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
                  ))}
                </select>
                {fieldErrors.patientId && <p className="text-sm text-red-600">{fieldErrors.patientId}</p>}
              </div>
              <div className="space-y-2">
                <Label>Amount ($) *</Label>
                <Input type="number" step="0.01" min="0.01" max="1000000" placeholder="0.00" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} error={fieldErrors.amount} />
                {fieldErrors.amount && <p className="text-sm text-red-600">{fieldErrors.amount}</p>}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description *</Label>
              <Input placeholder="e.g., Consultation, Filling, Crown..." maxLength={255} value={newDescription} onChange={(e) => setNewDescription(e.target.value)} error={fieldErrors.description} />
              {fieldErrors.description && <p className="text-sm text-red-600">{fieldErrors.description}</p>}
            </div>
            {newAmount && (
              <div className="text-sm text-gray-600">
                Subtotal: ${parseFloat(newAmount || '0').toFixed(2)} • Tax (8%): ${(parseFloat(newAmount || '0') * 0.08).toFixed(2)} • Total: ${(parseFloat(newAmount || '0') * 1.08).toFixed(2)}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewModal(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newPatientId || !newDescription || !newAmount || createInvoice.isPending}>
                {createInvoice.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create Invoice
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center gap-4">
            <div className="flex gap-2">
              {['', 'unpaid', 'partial', 'paid', 'overdue'].map((status) => (
                <Button key={status} variant={statusFilter === status ? 'default' : 'outline'} size="sm" onClick={() => setStatusFilter(status)}>
                  {status || 'All'}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4 border rounded-lg">
                  <Skeleton className="h-10 w-10 rounded" />
                  <div className="flex-1"><Skeleton className="h-4 w-32 mb-2" /><Skeleton className="h-3 w-48" /></div>
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
          ) : invoices?.length === 0 ? (
            <div className="text-center py-12"><p className="text-gray-500">No invoices found</p></div>
          ) : (
            <div className="space-y-4">
              {invoices?.map((invoice) => (
                <Link key={invoice.id} href={`/billing/invoices/${invoice.id}`} className="flex items-center gap-4 p-4 border rounded-lg hover:bg-gray-50 transition-colors">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100">
                    <DollarSign className="h-6 w-6 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900">{invoice.invoiceNumber}</p>
                      <Badge className={statusColors[invoice.status]}>{invoice.status}</Badge>
                    </div>
                    <p className="text-sm text-gray-500">{invoice.patient?.firstName} {invoice.patient?.lastName}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-bold text-lg">${invoice.total.toLocaleString()}</p>
                    <p className="text-sm text-gray-500 flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {new Date(invoice.dueAt).toLocaleDateString()}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
