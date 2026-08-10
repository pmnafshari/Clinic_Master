'use client';

import { useState } from 'react';
import { useAppointments, useCreateAppointment } from '@/hooks/use-appointments';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, ChevronLeft, ChevronRight, Clock, User, Loader2 } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import apiClient, { getErrorMessage } from '@/lib/api-client';
import { useQueryClient } from '@tanstack/react-query';

const statusColors: Record<string, string> = {
  scheduled: 'bg-blue-100 text-blue-800',
  confirmed: 'bg-green-100 text-green-800',
  'in-progress': 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-800',
  cancelled: 'bg-red-100 text-red-800',
  'no-show': 'bg-orange-100 text-orange-800',
};

interface PatientOption {
  id: string;
  firstName: string;
  lastName: string;
}

interface ProviderOption {
  id: string;
  firstName: string;
  lastName: string;
}

interface TimeSlot {
  time: string;
  available: boolean;
}

export default function AppointmentsPage() {
  const queryClient = useQueryClient();
  const [currentDate, setCurrentDate] = useState(new Date());
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toISOString().split('T')[0]
  );
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPatientId, setNewPatientId] = useState('');
  const [newProviderId, setNewProviderId] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newTime, setNewTime] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newError, setNewError] = useState<string | null>(null);

  const startDate = new Date(currentDate);
  startDate.setDate(1);
  const endDate = new Date(currentDate);
  endDate.setMonth(endDate.getMonth() + 1, 0);

  const { data: appointments, isLoading } = useAppointments({
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  });

  const { data: patients } = useQuery<PatientOption[]>({
    queryKey: ['patients-list'],
    queryFn: () => apiClient.get('/patients', { params: { limit: 100 } }).then((res) => res.data.data || res.data),
  });

  const { data: providers } = useQuery<ProviderOption[]>({
    queryKey: ['providers-list'],
    queryFn: () => apiClient.get('/users/providers').then((res) => res.data),
  });

  const { data: timeSlots } = useQuery<TimeSlot[]>({
    queryKey: ['availability', newProviderId, newDate],
    queryFn: () =>
      apiClient.get('/appointments/availability', { params: { providerId: newProviderId, date: newDate } }).then((res) => res.data),
    enabled: !!newProviderId && !!newDate,
  });

  const createAppointment = useCreateAppointment();

  const handleCreate = () => {
    const errors: string[] = [];
    if (!newPatientId) errors.push('Please select a patient');
    if (!newProviderId) errors.push('Please select a provider');
    if (!newDate) errors.push('Please select a date');
    if (!newTime) errors.push('Please select a time');
    if (newReason && newReason.length > 500) errors.push('Reason must be at most 500 characters');
    if (errors.length > 0) {
      setNewError(errors[0]);
      return;
    }
    setNewError(null);
    const startTime = new Date(`${newDate}T${newTime}:00`);
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    createAppointment.mutate(
      { patientId: newPatientId, providerId: newProviderId, startTime: startTime.toISOString(), endTime: endTime.toISOString(), reason: newReason },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['appointments'] });
          setShowNewModal(false);
          setNewPatientId('');
          setNewProviderId('');
          setNewDate('');
          setNewTime('');
          setNewReason('');
        },
        onError: (err: any) => {
          setNewError(getErrorMessage(err));
        },
      }
    );
  };

  const daysInMonth = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth() + 1,
    0
  ).getDate();

  const firstDayOfMonth = new Date(
    currentDate.getFullYear(),
    currentDate.getMonth(),
    1
  ).getDay();

  const getAppointmentsForDay = (day: number) => {
    const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return appointments?.filter((apt) => apt.startTime.startsWith(dateStr)) || [];
  };

  const selectedDayAppointments = selectedDate
    ? appointments?.filter((apt) => apt.startTime.startsWith(selectedDate)) || []
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Appointments</h2>
          <p className="text-gray-600">Manage your schedule</p>
        </div>
        <Button onClick={() => setShowNewModal(true)}>
          <Plus className="mr-2 h-4 w-4" />
          New Appointment
        </Button>
      </div>

      {showNewModal && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader>
            <CardTitle>New Appointment</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {newError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{newError}</div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Patient</Label>
                <select
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={newPatientId}
                  onChange={(e) => setNewPatientId(e.target.value)}
                >
                  <option value="">Select patient</option>
                  {patients?.map((p) => (
                    <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Provider</Label>
                <select
                  className="w-full border rounded-lg px-3 py-2 text-sm"
                  value={newProviderId}
                  onChange={(e) => { setNewProviderId(e.target.value); setNewTime(''); }}
                >
                  <option value="">Select provider</option>
                  {providers?.map((p) => (
                    <option key={p.id} value={p.id}>Dr. {p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Date</Label>
                <Input type="date" value={newDate} onChange={(e) => { setNewDate(e.target.value); setNewTime(''); }} />
              </div>
              <div className="space-y-2">
                <Label>Time</Label>
                {newProviderId && newDate ? (
                  <select
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                    value={newTime}
                    onChange={(e) => setNewTime(e.target.value)}
                  >
                    <option value="">Select time</option>
                    {timeSlots?.filter((s) => s.available).map((s) => (
                      <option key={s.time} value={s.time}>{s.time}</option>
                    ))}
                  </select>
                ) : (
                  <Input disabled placeholder="Select provider and date first" />
                )}
              </div>
            </div>
            <div className="space-y-2">
              <Label>Reason</Label>
              <Input placeholder="e.g., Regular checkup" value={newReason} onChange={(e) => setNewReason(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewModal(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newPatientId || !newProviderId || !newDate || !newTime || createAppointment.isPending}>
                {createAppointment.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <Button variant="ghost" size="icon" onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() - 1))}>
                  <ChevronLeft className="h-5 w-5" />
                </Button>
                <CardTitle>{currentDate.toLocaleString('default', { month: 'long', year: 'numeric' })}</CardTitle>
                <Button variant="ghost" size="icon" onClick={() => setCurrentDate(new Date(currentDate.getFullYear(), currentDate.getMonth() + 1))}>
                  <ChevronRight className="h-5 w-5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-7 gap-1 mb-2">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                  <div key={day} className="text-center text-sm font-medium text-gray-500 py-2">{day}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: firstDayOfMonth }).map((_, i) => (
                  <div key={`empty-${i}`} className="h-24" />
                ))}
                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const dayAppts = getAppointmentsForDay(day);
                  const dateStr = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                  const isSelected = selectedDate === dateStr;
                  const isToday = new Date().getDate() === day && new Date().getMonth() === currentDate.getMonth() && new Date().getFullYear() === currentDate.getFullYear();
                  return (
                    <button key={day} onClick={() => setSelectedDate(dateStr)} className={`h-24 p-1 border rounded-lg text-left hover:bg-gray-50 transition-colors ${isSelected ? 'ring-2 ring-blue-500 bg-blue-50' : ''} ${isToday ? 'bg-blue-50' : ''}`}>
                      <span className={`text-sm font-medium ${isToday ? 'text-blue-600' : 'text-gray-900'}`}>{day}</span>
                      <div className="mt-1 space-y-1">
                        {dayAppts.slice(0, 2).map((apt) => (
                          <div key={apt.id} className={`text-xs px-1 py-0.5 rounded ${statusColors[apt.status] || 'bg-gray-100'}`}>
                            {apt.startTime.split('T')[1]?.substring(0, 5)}
                          </div>
                        ))}
                        {dayAppts.length > 2 && <span className="text-xs text-gray-500">+{dayAppts.length - 2} more</span>}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>

        <div>
          <Card>
            <CardHeader>
              <CardTitle>
                {selectedDate ? new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : 'Select a day'}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading ? (
                <div className="space-y-4">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="p-3 border rounded-lg"><Skeleton className="h-4 w-24 mb-2" /><Skeleton className="h-3 w-32" /></div>
                  ))}
                </div>
              ) : selectedDayAppointments.length === 0 ? (
                <p className="text-gray-500 text-center py-8">No appointments</p>
              ) : (
                <div className="space-y-4">
                  {selectedDayAppointments.map((apt) => (
                    <div key={apt.id} className="p-3 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <Clock className="h-4 w-4 text-gray-400" />
                          {apt.startTime.split('T')[1]?.substring(0, 5)} - {apt.endTime.split('T')[1]?.substring(0, 5)}
                        </span>
                        <Badge variant="outline" className={statusColors[apt.status]}>{apt.status}</Badge>
                      </div>
                      <div className="flex items-center gap-2 text-sm text-gray-600">
                        <User className="h-4 w-4" />
                        {apt.patient?.firstName} {apt.patient?.lastName}
                      </div>
                      {apt.reason && <p className="text-sm text-gray-500 mt-1">{apt.reason}</p>}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
