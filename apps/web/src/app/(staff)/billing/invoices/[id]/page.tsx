'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useInvoice, useRecordPayment } from '@/hooks/use-billing';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, CreditCard, Calendar, User, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { getErrorMessage } from '@/lib/api-client';

const statusColors: Record<string, string> = {
  unpaid: 'bg-yellow-100 text-yellow-800',
  partial: 'bg-orange-100 text-orange-800',
  paid: 'bg-green-100 text-green-800',
  overdue: 'bg-red-100 text-red-800',
  cancelled: 'bg-gray-100 text-gray-800',
};

export default function InvoiceDetailPage() {
  const params = useParams();
  const invoiceId = params.id as string;
  const queryClient = useQueryClient();
  const { data: invoice, isLoading } = useInvoice(invoiceId);
  const recordPayment = useRecordPayment();
  const [showPayment, setShowPayment] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentMethod, setPaymentMethod] = useState('cash');
  const [paymentReference, setPaymentReference] = useState('');
  const [paymentError, setPaymentError] = useState<string | null>(null);

  const totalPaid = invoice?.payments?.reduce((sum, p) => sum + p.amount, 0) || 0;
  const balance = (invoice?.total || 0) - totalPaid;

  const handleRecordPayment = () => {
    const amount = parseFloat(paymentAmount);
    if (isNaN(amount) || amount <= 0) {
      setPaymentError('Please enter a valid payment amount (minimum $0.01)');
      return;
    }
    if (amount > balance) {
      setPaymentError(`Payment amount ($${amount.toLocaleString()}) exceeds the balance due of $${balance.toLocaleString()}. Please enter $${balance.toLocaleString()} or less.`);
      return;
    }
    if (paymentReference && paymentReference.length > 100) {
      setPaymentError('Reference must be at most 100 characters');
      return;
    }
    setPaymentError(null);
    recordPayment.mutate(
      { invoiceId, data: { amount, method: paymentMethod, reference: paymentReference || undefined } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['invoice', invoiceId] });
          queryClient.invalidateQueries({ queryKey: ['invoices'] });
          setShowPayment(false);
          setPaymentAmount('');
          setPaymentMethod('cash');
          setPaymentReference('');
        },
        onError: (err: any) => {
          setPaymentError(getErrorMessage(err));
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Invoice not found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/billing/invoices">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-900">{invoice.invoiceNumber}</h2>
          <p className="text-gray-600">Invoice Details</p>
        </div>
        <Badge className={statusColors[invoice.status]}>{invoice.status}</Badge>
        {invoice.status !== 'paid' && invoice.status !== 'cancelled' && (
          <Button onClick={() => setShowPayment(true)}>
            <CreditCard className="mr-2 h-4 w-4" />
            Record Payment
          </Button>
        )}
      </div>

      {showPayment && (
        <Card className="border-green-200 bg-green-50/50">
          <CardHeader><CardTitle>Record Payment</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {paymentError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{paymentError}</div>
            )}
            <p className="text-sm text-gray-600">Balance due: <span className="font-bold">${balance.toLocaleString()}</span></p>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Amount ($)</Label>
                <Input type="number" step="0.01" min="0.01" max={balance} value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="0.00" />
              </div>
              <div className="space-y-2">
                <Label>Method</Label>
                <select className="w-full border rounded-lg px-3 py-2 text-sm" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="cash">Cash</option>
                  <option value="credit_card">Credit Card</option>
                  <option value="debit_card">Debit Card</option>
                  <option value="bank_transfer">Bank Transfer</option>
                  <option value="insurance">Insurance</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label>Reference (optional)</Label>
                <Input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder="e.g., Receipt #123" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowPayment(false)}>Cancel</Button>
              <Button onClick={handleRecordPayment} disabled={!paymentAmount || parseFloat(paymentAmount) <= 0 || parseFloat(paymentAmount) > balance || recordPayment.isPending}>
                {recordPayment.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Record Payment
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
                <User className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Patient</p>
                <p className="font-medium">{invoice.patient?.firstName} {invoice.patient?.lastName}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                <Calendar className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Due Date</p>
                <p className="font-medium">{new Date(invoice.dueAt).toLocaleDateString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-100">
                <CreditCard className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Balance Due</p>
                <p className="font-bold text-lg">${balance.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Invoice Items</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4">
            {invoice.items?.map((item) => (
              <div key={item.id} className="flex items-center justify-between p-4 border rounded-lg">
                <div>
                  <p className="font-medium">{item.description}</p>
                  {item.procedureCode && <p className="text-sm text-gray-500">Code: {item.procedureCode}</p>}
                </div>
                <div className="text-right">
                  <p className="font-medium">${item.total.toLocaleString()}</p>
                  <p className="text-sm text-gray-500">{item.quantity} x ${item.unitPrice.toLocaleString()}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 pt-4 border-t space-y-2">
            <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal</span><span>${invoice.subtotal.toLocaleString()}</span></div>
            <div className="flex justify-between text-sm"><span className="text-gray-500">Tax</span><span>${invoice.tax.toLocaleString()}</span></div>
            <div className="flex justify-between text-lg font-bold pt-2 border-t"><span>Total</span><span>${invoice.total.toLocaleString()}</span></div>
          </div>
        </CardContent>
      </Card>

      {invoice.payments && invoice.payments.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Payment History</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-4">
              {invoice.payments.map((payment) => (
                <div key={payment.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div>
                    <p className="font-medium">${payment.amount.toLocaleString()}</p>
                    <p className="text-sm text-gray-500 capitalize">{payment.method.replace('_', ' ')}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm">{new Date(payment.paidAt).toLocaleDateString()}</p>
                    {payment.reference && <p className="text-xs text-gray-500">Ref: {payment.reference}</p>}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
