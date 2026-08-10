'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Calendar, Clock, ArrowLeft, X, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

interface Appointment {
  id: string;
  startTime: string;
  endTime: string;
  status: string;
  reason?: string;
  notes?: string;
  provider: { firstName: string; lastName: string };
}

const statusColors: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-800',
  confirmed: 'bg-green-100 text-green-800',
  'in-progress': 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-800',
  cancelled: 'bg-red-100 text-red-800',
  'no-show': 'bg-orange-100 text-orange-800',
};

export default function PortalAppointmentsPage() {
  const queryClient = useQueryClient();
  const [cancellingId, setCancellingId] = useState<string | null>(null);

  const { data: appointments, isLoading } = useQuery<Appointment[]>({
    queryKey: ['portal-appointments'],
    queryFn: () => apiClient.get('/portal/appointments').then((res) => res.data),
  });

  const cancelAppointment = useMutation({
    mutationFn: (id: string) => apiClient.delete(`/appointments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-appointments'] });
      setCancellingId(null);
    },
  });

  const upcoming = appointments?.filter(
    (apt) => new Date(apt.startTime) > new Date() && apt.status !== 'cancelled'
  );
  const past = appointments?.filter(
    (apt) => new Date(apt.startTime) <= new Date() || apt.status === 'completed'
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/portal">
            <Button variant="ghost" size="icon">
              <ArrowLeft className="h-5 w-5" />
            </Button>
          </Link>
          <div>
            <h2 className="text-2xl font-bold text-gray-900">My Appointments</h2>
            <p className="text-gray-600">View your appointment history</p>
          </div>
        </div>
        <Link href="/portal/book">
          <Button>
            <Calendar className="mr-2 h-4 w-4" />
            Book New
          </Button>
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upcoming Appointments</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="p-4 border rounded-lg">
                  <Skeleton className="h-4 w-32 mb-2" />
                  <Skeleton className="h-3 w-48" />
                </div>
              ))}
            </div>
          ) : upcoming?.length === 0 ? (
            <div className="text-center py-8">
              <Calendar className="h-12 w-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">No upcoming appointments</p>
              <Link href="/portal/book">
                <Button>Book Appointment</Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-4">
              {upcoming?.map((apt) => (
                <div key={apt.id} className="flex items-center gap-4 p-4 border rounded-lg">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-blue-100">
                    <Calendar className="h-6 w-6 text-blue-600" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {new Date(apt.startTime).toLocaleDateString('en-US', {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </p>
                      <Badge className={statusColors[apt.status]}>{apt.status}</Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(apt.startTime).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span>Dr. {apt.provider.firstName} {apt.provider.lastName}</span>
                    </div>
                    {apt.reason && <p className="text-sm text-gray-500 mt-1">{apt.reason}</p>}
                  </div>
                  {(apt.status === 'scheduled' || apt.status === 'confirmed') && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => {
                        if (confirm('Cancel this appointment?')) {
                          setCancellingId(apt.id);
                          cancelAppointment.mutate(apt.id);
                        }
                      }}
                      disabled={cancellingId === apt.id}
                    >
                      {cancellingId === apt.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <X className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Past Appointments</CardTitle>
        </CardHeader>
        <CardContent>
          {past?.length === 0 ? (
            <p className="text-gray-500 text-center py-8">No past appointments</p>
          ) : (
            <div className="space-y-4">
              {past?.map((apt) => (
                <div key={apt.id} className="flex items-center gap-4 p-4 border rounded-lg opacity-75">
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-gray-100">
                    <Calendar className="h-6 w-6 text-gray-500" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <p className="font-medium">
                        {new Date(apt.startTime).toLocaleDateString('en-US', {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                        })}
                      </p>
                      <Badge className={statusColors[apt.status]}>{apt.status}</Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-gray-500">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(apt.startTime).toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      <span>Dr. {apt.provider.firstName} {apt.provider.lastName}</span>
                    </div>
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
