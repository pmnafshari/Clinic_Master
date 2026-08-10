'use client';

import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { DollarSign, CreditCard, Calendar } from 'lucide-react';

interface Payment {
  id: string;
  amount: number;
  method: string;
  reference?: string;
  paidAt: string;
  notes?: string;
  invoice: {
    invoiceNumber: string;
    patient: { firstName: string; lastName: string };
  };
}

export default function PaymentsPage() {
  const { data: payments, isLoading } = useQuery<Payment[]>({
    queryKey: ['payments'],
    queryFn: () => apiClient.get('/billing/payments').then((res) => res.data),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Payments</h2>
        <p className="text-gray-600">View all payment transactions</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Payments</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 p-4 border rounded-lg">
                  <Skeleton className="h-10 w-10 rounded" />
                  <div className="flex-1">
                    <Skeleton className="h-4 w-32 mb-2" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-6 w-20" />
                </div>
              ))}
            </div>
          ) : payments?.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500">No payments recorded</p>
            </div>
          ) : (
            <div className="space-y-4">
              {payments?.map((payment) => (
                <div
                  key={payment.id}
                  className="flex items-center gap-4 p-4 border rounded-lg"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-100">
                    <DollarSign className="h-6 w-6 text-green-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">${payment.amount.toLocaleString()}</p>
                      <Badge variant="outline" className="capitalize">
                        {payment.method.replace('_', ' ')}
                      </Badge>
                    </div>
                    <p className="text-sm text-gray-500">
                      {payment.invoice.patient.firstName} {payment.invoice.patient.lastName} •{' '}
                      {payment.invoice.invoiceNumber}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {new Date(payment.paidAt).toLocaleDateString()}
                    </p>
                    {payment.reference && (
                      <p className="text-xs text-gray-500">Ref: {payment.reference}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
