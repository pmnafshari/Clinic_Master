import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { Patient, PaginatedResponse } from '@smileflow/shared-types';
import apiClient from '@/lib/api-client';

export type { Patient };

type PatientsResponse = PaginatedResponse<Patient>;

export function usePatients(search?: string, page = 1, limit = 20) {
  return useQuery<PatientsResponse>({
    queryKey: ['patients', search, page, limit],
    queryFn: () =>
      apiClient
        .get('/patients', { params: { search, page, limit } })
        .then((res) => res.data),
  });
}

export function usePatient(id: string) {
  return useQuery<Patient>({
    queryKey: ['patient', id],
    queryFn: () => apiClient.get(`/patients/${id}`).then((res) => res.data),
    enabled: !!id,
  });
}

export function useCreatePatient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Patient>) => apiClient.post('/patients', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
    },
  });
}

export function useUpdatePatient() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Patient> }) =>
      apiClient.patch(`/patients/${id}`, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['patients'] });
      queryClient.invalidateQueries({ queryKey: ['patient', variables.id] });
    },
  });
}
