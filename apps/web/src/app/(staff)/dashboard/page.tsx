'use client';

import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Users, Calendar, DollarSign, Activity, Clock, FileText } from 'lucide-react';
import Link from 'next/link';
import { Badge } from '@/components/ui/badge';

interface DashboardKPIs {
  totalPatients: number;
  appointmentsThisMonth: number;
  revenueThisMonth: number;
  pendingInvoices: number;
  completedAppointments: number;
  noShowAppointments: number;
  noShowRate: number;
}

interface RecentAppointment {
  id: string;
  patient: { firstName: string; lastName: string };
  provider: { firstName: string; lastName: string };
  startTime: string;
  endTime: string;
  status: string;
  reason?: string;
}

const statusColors: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-800',
  confirmed: 'bg-green-100 text-green-800',
  'in-progress': 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-800',
  cancelled: 'bg-red-100 text-red-800',
  'no-show': 'bg-orange-100 text-orange-800',
};

export default function DashboardPage() {
  const { data: kpis, isLoading: loadingKpis } = useQuery<DashboardKPIs>({
    queryKey: ['dashboard-kpis'],
    queryFn: () => apiClient.get('/reports/dashboard').then((res) => res.data),
  });

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const { data: recentAppointments, isLoading: loadingAppointments } = useQuery<RecentAppointment[]>({
    queryKey: ['dashboard-recent-appointments'],
    queryFn: () =>
      apiClient
        .get('/appointments', {
          params: { startDate: startOfWeek.toISOString(), endDate: endOfWeek.toISOString() },
        })
        .then((res) => res.data),
  });

  const stats = [
    {
      title: 'Total Patients',
      value: kpis?.totalPatients ?? 0,
      icon: Users,
      description: 'Registered patients',
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
    {
      title: 'Appointments',
      value: kpis?.appointmentsThisMonth ?? 0,
      icon: Calendar,
      description: 'This month',
      color: 'text-green-600',
      bgColor: 'bg-green-100',
    },
    {
      title: 'Revenue',
      value: `$${(kpis?.revenueThisMonth ?? 0).toLocaleString()}`,
      icon: DollarSign,
      description: 'This month',
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
    },
    {
      title: 'Pending Invoices',
      value: kpis?.pendingInvoices ?? 0,
      icon: FileText,
      description: 'Awaiting payment',
      color: 'text-orange-600',
      bgColor: 'bg-orange-100',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Dashboard</h2>
        <p className="text-gray-600">Welcome back! Here&apos;s what&apos;s happening today.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {loadingKpis
          ? Array.from({ length: 4 }).map((_, i) => (
              <Card key={i}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-4 rounded" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-20 mb-1" />
                  <Skeleton className="h-3 w-32" />
                </CardContent>
              </Card>
            ))
          : stats.map((stat) => {
              const Icon = stat.icon;
              return (
                <Card key={stat.title}>
                  <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                    <CardTitle className="text-sm font-medium">{stat.title}</CardTitle>
                    <div className={`${stat.bgColor} rounded-lg p-2`}>
                      <Icon className={`h-4 w-4 ${stat.color}`} />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">{stat.value}</div>
                    <p className="text-xs text-muted-foreground">{stat.description}</p>
                  </CardContent>
                </Card>
              );
            })}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Recent Appointments</CardTitle>
            <Link href="/appointments" className="text-sm text-blue-600 hover:underline">
              View all
            </Link>
          </CardHeader>
          <CardContent>
            {loadingAppointments ? (
              <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-4">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1">
                      <Skeleton className="h-4 w-32 mb-1" />
                      <Skeleton className="h-3 w-24" />
                    </div>
                    <Skeleton className="h-6 w-16" />
                  </div>
                ))}
              </div>
            ) : !recentAppointments?.length ? (
              <p className="text-gray-500 text-center py-8">No appointments this week</p>
            ) : (
              <div className="space-y-4">
                {recentAppointments.slice(0, 5).map((apt) => (
                  <div key={apt.id} className="flex items-center justify-between border-b pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-gray-100">
                        <span className="text-sm font-medium">
                          {apt.patient.firstName[0]}{apt.patient.lastName[0]}
                        </span>
                      </div>
                      <div>
                        <p className="font-medium">{apt.patient.firstName} {apt.patient.lastName}</p>
                        <p className="text-sm text-gray-500">
                          {apt.reason || 'No reason specified'}
                        </p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-sm">
                        {new Date(apt.startTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                      </p>
                      <Badge variant="outline" className={`text-xs ${statusColors[apt.status] || ''}`}>
                        {apt.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              {[
                { label: 'New Patient', href: '/patients/new', color: 'bg-blue-500' },
                { label: 'Book Appointment', href: '/appointments', color: 'bg-green-500' },
                { label: 'View Reports', href: '/reports', color: 'bg-purple-500' },
                { label: 'Billing', href: '/billing/invoices', color: 'bg-orange-500' },
              ].map((action) => (
                <Link
                  key={action.label}
                  href={action.href}
                  className="flex flex-col items-center justify-center rounded-lg border p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className={`${action.color} mb-2 rounded-lg p-3 text-white`}>
                    <Activity className="h-5 w-5" />
                  </div>
                  <span className="text-sm font-medium">{action.label}</span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
