import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Appointment, AppointmentStatus } from '@smileflow/shared-types';
import apiClient from '@/lib/api-client';

export type { Appointment, AppointmentStatus };

interface AppointmentFilters {
  providerId?: string;
  startDate?: string;
  endDate?: string;
  status?: string;
}

export function useAppointments(filters?: AppointmentFilters) {
  return useQuery<Appointment[]>({
    queryKey: ['appointments', filters],
    queryFn: () =>
      apiClient.get('/appointments', { params: filters }).then((res) => res.data),
  });
}

export function useAppointment(id: string) {
  return useQuery<Appointment>({
    queryKey: ['appointment', id],
    queryFn: () => apiClient.get(`/appointments/${id}`).then((res) => res.data),
    enabled: !!id,
  });
}

export function useCreateAppointment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Appointment>) => apiClient.post('/appointments', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
  });
}

export function useUpdateAppointment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Appointment> }) =>
      apiClient.patch(`/appointments/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
      queryClient.invalidateQueries({ queryKey: ['appointment', variables.id] });
    },
  });
}

export function useUpdateAppointmentStatus() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiClient.patch(`/appointments/${id}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
  });
}

export function useCancelAppointment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/appointments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['appointments'] });
    },
  });
}
