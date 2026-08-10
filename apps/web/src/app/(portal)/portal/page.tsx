'use client';

import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar, CreditCard, FileText, Clock, ArrowRight } from 'lucide-react';
import Link from 'next/link';

interface Appointment {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  reason?: string;
  provider: { firstName: string; lastName: string };
}

interface Invoice {
  id: string;
  invoiceNumber: string;
  total: number;
  status: string;
  dueAt: string;
}

interface TreatmentPlan {
  id: string;
  title: string;
  status: string;
  items: Array<{ id: string }>;
}

export default function PortalHomePage() {
  const { user } = useAuth();

  const { data: appointments, isLoading: loadingAppointments } = useQuery<Appointment[]>({
    queryKey: ['portal-appointments'],
    queryFn: () => apiClient.get('/portal/appointments').then((res) => res.data),
  });

  const { data: invoices, isLoading: loadingInvoices } = useQuery<Invoice[]>({
    queryKey: ['portal-invoices'],
    queryFn: () => apiClient.get('/portal/invoices').then((res) => res.data),
  });

  const { data: treatments, isLoading: loadingTreatments } = useQuery<TreatmentPlan[]>({
    queryKey: ['portal-treatments'],
    queryFn: () => apiClient.get('/portal/treatments').then((res) => res.data),
  });

  const upcomingAppointments = appointments?.filter(
    (apt) => new Date(apt.startTime) > new Date() && apt.status !== 'cancelled'
  ).slice(0, 3);

  const unpaidInvoices = invoices?.filter((inv) => inv.status !== 'paid').length || 0;
  const totalBalance = invoices
    ?.filter((inv) => inv.status !== 'paid')
    .reduce((sum, inv) => sum + inv.total, 0) || 0;

  const statusColors: Record<string, string> = {
    scheduled: 'bg-blue-100 text-blue-800',
    confirmed: 'bg-green-100 text-green-800',
    unpaid: 'bg-yellow-100 text-yellow-800',
    partial: 'bg-orange-100 text-orange-800',
    paid: 'bg-green-100 text-green-800',
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">
          Welcome back, {user?.firstName}!
        </h2>
        <p className="text-gray-600">Here&apos;s an overview of your account</p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100">
                <Calendar className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Upcoming Appointments</p>
                <p className="text-2xl font-bold">{upcomingAppointments?.length || 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-orange-100">
                <CreditCard className="h-6 w-6 text-orange-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Balance Due</p>
                <p className="text-2xl font-bold">${totalBalance.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-green-100">
                <FileText className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Active Treatments</p>
                <p className="text-2xl font-bold">
                  {treatments?.filter((t) => t.status !== 'completed').length || 0}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Upcoming Appointments</CardTitle>
            <Link href="/portal/appointments">
              <Button variant="ghost" size="sm">
                View All <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {loadingAppointments ? (
              <div className="space-y-4">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="p-3 border rounded-lg">
                    <Skeleton className="h-4 w-32 mb-2" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                ))}
              </div>
            ) : upcomingAppointments?.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-gray-500 mb-4">No upcoming appointments</p>
                <Link href="/portal/book">
                  <Button>Book Appointment</Button>
                </Link>
              </div>
            ) : (
              <div className="space-y-4">
                {upcomingAppointments?.map((apt) => (
                  <div key={apt.id} className="flex items-center justify-between p-3 border rounded-lg">
                    <div>
                      <p className="font-medium">
                        {new Date(apt.startTime).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </p>
                      <p className="text-sm text-gray-500">
                        {new Date(apt.startTime).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        with Dr. {apt.provider.lastName}
                      </p>
                    </div>
                    <Badge className={statusColors[apt.status]}>{apt.status}</Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <Link href="/portal/book">
                <div className="flex flex-col items-center justify-center p-4 border rounded-lg hover:bg-gray-50 transition-colors cursor-pointer">
                  <Calendar className="h-8 w-8 text-blue-600 mb-2" />
                  <span className="text-sm font-medium">Book Appointment</span>
                </div>
              </Link>
              <Link href="/portal/invoices">
                <div className="flex flex-col items-center justify-center p-4 border rounded-lg hover:bg-gray-50 transition-colors cursor-pointer">
                  <CreditCard className="h-8 w-8 text-orange-600 mb-2" />
                  <span className="text-sm font-medium">View Invoices</span>
                </div>
              </Link>
              <Link href="/portal/treatments">
                <div className="flex flex-col items-center justify-center p-4 border rounded-lg hover:bg-gray-50 transition-colors cursor-pointer">
                  <FileText className="h-8 w-8 text-green-600 mb-2" />
                  <span className="text-sm font-medium">Treatments</span>
                </div>
              </Link>
              <Link href="/portal/profile">
                <div className="flex flex-col items-center justify-center p-4 border rounded-lg hover:bg-gray-50 transition-colors cursor-pointer">
                  <Clock className="h-8 w-8 text-purple-600 mb-2" />
                  <span className="text-sm font-medium">My Profile</span>
                </div>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
