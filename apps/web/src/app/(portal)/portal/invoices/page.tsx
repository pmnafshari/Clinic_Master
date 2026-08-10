'use client';

import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CreditCard, Calendar, ArrowLeft, DollarSign, Check } from 'lucide-react';
import Link from 'next/link';

interface Invoice {
  id: string;
  invoiceNumber: string;
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  issuedAt: string;
  dueAt: string;
  items: Array<{ description: string; total: number }>;
  payments: Array<{ amount: number; paidAt: string }>;
}

const statusColors: Record<string, string> = {
  unpaid: 'bg-yellow-100 text-yellow-800',
  partial: 'bg-orange-100 text-orange-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
};

export default function PortalInvoicesPage() {
  const { data: invoices, isLoading } = useQuery<Invoice[]>({
    queryKey: ['portal-invoices'],
    queryFn: () => apiClient.get('/portal/invoices').then((res) => res.data),
  });

  const totalBalance = invoices
    ?.filter((inv) => inv.status !== 'paid')
    .reduce((sum, inv) => {
      const paid = inv.payments.reduce((s, p) => s + p.amount, 0);
      return sum + (inv.total - paid);
    }, 0) || 0;

  const unpaidCount = invoices?.filter((inv) => inv.status !== 'paid').length || 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/portal">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">My Invoices</h2>
          <p className="text-gray-600">View your billing and payments</p>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
                <DollarSign className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Total Balance Due</p>
                <p className="text-2xl font-bold">${totalBalance.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100">
                <CreditCard className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Unpaid Invoices</p>
                <p className="text-2xl font-bold">{unpaidCount}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="p-4 border rounded-lg">
                  <Skeleton className="h-4 w-32 mb-2" />
                  <Skeleton className="h-3 w-48" />
                </div>
              ))}
            </div>
          ) : invoices?.length === 0 ? (
            <div className="text-center py-12">
              <CreditCard className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">No invoices yet</p>
            </div>
          ) : (
            <div className="space-y-4">
              {invoices?.map((invoice) => {
                const paidAmount = invoice.payments.reduce((sum, p) => sum + p.amount, 0);
                const balance = invoice.total - paidAmount;
                return (
                  <div key={invoice.id} className="p-4 border rounded-lg">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <CreditCard className="h-5 w-5 text-gray-400" />
                        <div>
                          <p className="font-medium">{invoice.invoiceNumber}</p>
                          <p className="text-sm text-gray-500">
                            {new Date(invoice.issuedAt).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge className={statusColors[invoice.status]}>
                          {invoice.status}
                        </Badge>
                        {invoice.status !== 'paid' && (
                          <Button
                            size="sm"
                            onClick={() => alert('Please contact the front desk to make a payment. Phone: (555) 123-4567')}
                          >
                            Pay Now
                          </Button>
                        )}
                      </div>
                    </div>

                    <div className="space-y-2">
                      {invoice.items.map((item, i) => (
                        <div key={i} className="flex justify-between text-sm">
                          <span className="text-gray-600">{item.description}</span>
                          <span>${item.total.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-3 pt-3 border-t flex justify-between items-center">
                      <div className="text-sm text-gray-500">
                        <span className="flex items-center gap-1">
                          <Calendar className="h-3 w-3" />
                          Due: {new Date(invoice.dueAt).toLocaleDateString()}
                        </span>
                      </div>
                      <div className="text-right">
                        {paidAmount > 0 && (
                          <p className="text-sm text-green-600 mb-1">
                            Paid: ${paidAmount.toLocaleString()}
                          </p>
                        )}
                        {balance > 0 && (
                          <p className="text-sm text-orange-600 mb-1">
                            Balance: ${balance.toLocaleString()}
                          </p>
                        )}
                        <p className="font-bold">
                          ${invoice.total.toLocaleString()}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
