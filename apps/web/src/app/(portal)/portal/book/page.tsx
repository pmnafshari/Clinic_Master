'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient, { getErrorMessage } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, ArrowRight, Check, Calendar, Clock, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface Provider {
  id: string;
  firstName: string;
  lastName: string;
}

interface TimeSlot {
  time: string;
  available: boolean;
}

export default function BookAppointmentPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(1);
  const [selectedProvider, setSelectedProvider] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [selectedTime, setSelectedTime] = useState<string>('');
  const [reason, setReason] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const { data: providers, isLoading: loadingProviders } = useQuery<Provider[]>({
    queryKey: ['providers'],
    queryFn: () => apiClient.get('/users/providers').then((res) => res.data),
  });

  const { data: timeSlots, isLoading: loadingSlots } = useQuery<TimeSlot[]>({
    queryKey: ['availability', selectedProvider, selectedDate],
    queryFn: () =>
      apiClient
        .get('/appointments/availability', { params: { providerId: selectedProvider, date: selectedDate } })
        .then((res) => res.data),
    enabled: !!selectedProvider && !!selectedDate,
  });

  const bookAppointment = useMutation({
    mutationFn: (data: any) => apiClient.post('/portal/appointments', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-appointments'] });
      router.push('/portal/appointments');
    },
    onError: (err: any) => {
      setError(getErrorMessage(err));
    },
  });

  const handleBook = () => {
    if (!selectedProvider) {
      setError('Please select a provider');
      return;
    }
    if (!selectedDate) {
      setError('Please select a date');
      return;
    }
    if (!selectedTime) {
      setError('Please select a time');
      return;
    }
    if (reason && reason.length > 500) {
      setError('Reason must be at most 500 characters');
      return;
    }

    const startTime = new Date(`${selectedDate}T${selectedTime}:00`);
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    setError(null);

    bookAppointment.mutate({
      providerId: selectedProvider,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      reason,
    });
  };

  const generateDates = () => {
    const dates = [];
    const today = new Date();
    for (let i = 1; i <= 14; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      if (date.getDay() !== 0 && date.getDay() !== 6) {
        dates.push(date);
      }
    }
    return dates;
  };

  const dates = generateDates();

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-4">
        <Link href="/portal">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Book Appointment</h2>
          <p className="text-gray-600">Schedule your next visit</p>
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-center gap-4 mb-8">
        {[1, 2, 3].map((s) => (
          <div key={s} className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center ${
                step >= s ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-600'
              }`}
            >
              {step > s ? <Check className="h-4 w-4" /> : s}
            </div>
            <span className={`text-sm ${step >= s ? 'text-blue-600 font-medium' : 'text-gray-500'}`}>
              {s === 1 ? 'Provider' : s === 2 ? 'Date & Time' : 'Confirm'}
            </span>
            {s < 3 && <div className="w-12 h-0.5 bg-gray-200" />}
          </div>
        ))}
      </div>

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle>Select Provider</CardTitle>
          </CardHeader>
          <CardContent>
            {loadingProviders ? (
              <div className="space-y-4">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                {providers?.map((provider) => (
                  <button
                    key={provider.id}
                    onClick={() => setSelectedProvider(provider.id)}
                    className={`w-full flex items-center gap-4 p-4 border rounded-lg transition-colors ${
                      selectedProvider === provider.id
                        ? 'border-blue-500 bg-blue-50'
                        : 'hover:bg-gray-50'
                    }`}
                  >
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-100">
                      <span className="text-sm font-medium text-blue-600">
                        {provider.firstName[0]}
                        {provider.lastName[0]}
                      </span>
                    </div>
                    <div className="text-left">
                      <p className="font-medium">Dr. {provider.firstName} {provider.lastName}</p>
                      <p className="text-sm text-gray-500">Dentist</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Calendar className="h-5 w-5" />
                Select Date
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-7 gap-2">
                {dates.map((date) => {
                  const dateStr = date.toISOString().split('T')[0];
                  const isSelected = selectedDate === dateStr;
                  return (
                    <button
                      key={dateStr}
                      onClick={() => {
                        setSelectedDate(dateStr);
                        setSelectedTime('');
                      }}
                      className={`p-2 rounded-lg text-center transition-colors ${
                        isSelected
                          ? 'bg-blue-600 text-white'
                          : 'hover:bg-gray-100'
                      }`}
                    >
                      <p className="text-xs text-gray-500">
                        {date.toLocaleDateString('en-US', { weekday: 'short' })}
                      </p>
                      <p className="font-medium">{date.getDate()}</p>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {selectedDate && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Clock className="h-5 w-5" />
                  Select Time
                </CardTitle>
              </CardHeader>
              <CardContent>
                {loadingSlots ? (
                  <div className="grid grid-cols-4 gap-2">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <Skeleton key={i} className="h-12" />
                    ))}
                  </div>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {timeSlots?.map((slot) => (
                      <button
                        key={slot.time}
                        onClick={() => slot.available && setSelectedTime(slot.time)}
                        disabled={!slot.available}
                        className={`p-3 rounded-lg text-center transition-colors ${
                          selectedTime === slot.time
                            ? 'bg-blue-600 text-white'
                            : slot.available
                            ? 'hover:bg-gray-100 border'
                            : 'bg-gray-50 text-gray-400 cursor-not-allowed'
                        }`}
                      >
                        {slot.time}
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {selectedDate && selectedTime && (
            <Card>
              <CardHeader>
                <CardTitle>Reason for Visit</CardTitle>
              </CardHeader>
              <CardContent>
                <Input
                  placeholder="e.g., Regular checkup, tooth pain..."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {step === 3 && (
        <Card>
          <CardHeader>
            <CardTitle>Confirm Booking</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="p-4 bg-gray-50 rounded-lg space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-500">Provider</span>
                <span className="font-medium">
                  Dr. {providers?.find((p) => p.id === selectedProvider)?.lastName}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Date</span>
                <span className="font-medium">
                  {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Time</span>
                <span className="font-medium">{selectedTime}</span>
              </div>
              {reason && (
                <div className="flex justify-between">
                  <span className="text-gray-500">Reason</span>
                  <span className="font-medium">{reason}</span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex justify-between">
        {step > 1 && (
          <Button variant="outline" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        <div className="ml-auto">
          {step < 3 ? (
            <Button
              onClick={() => setStep(step + 1)}
              disabled={
                (step === 1 && !selectedProvider) ||
                (step === 2 && (!selectedDate || !selectedTime))
              }
            >
              Next <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          ) : (
            <Button onClick={handleBook} disabled={bookAppointment.isPending}>
              {bookAppointment.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Booking...
                </>
              ) : (
                'Confirm Booking'
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
