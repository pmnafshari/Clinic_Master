'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient, { getErrorMessage } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, User, DollarSign, Calendar, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface TreatmentPlan {
  id: string;
  title: string;
  description?: string;
  status: string;
  estimatedCost?: number;
  patient: { firstName: string; lastName: string };
  provider: { firstName: string; lastName: string };
  items: Array<{ id: string; description: string; cost: number }>;
  createdAt: string;
}

interface PatientOption {
  id: string;
  firstName: string;
  lastName: string;
}

const statusColors: Record<string, string> = {
  planned: 'bg-blue-100 text-blue-800',
  approved: 'bg-green-100 text-green-800',
  'in-progress': 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-800',
  cancelled: 'bg-red-100 text-red-800',
};

export default function TreatmentPlansPage() {
  const queryClient = useQueryClient();
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPatientId, setNewPatientId] = useState('');
  const [newProviderId, setNewProviderId] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newError, setNewError] = useState<string | null>(null);

  const { data: plans, isLoading, error } = useQuery<TreatmentPlan[]>({
    queryKey: ['treatment-plans'],
    queryFn: () => apiClient.get('/treatment-plans').then((res) => res.data),
    // A role that may not read treatment plans gets a 403 on every attempt;
    // retrying cannot change that and only delays the message.
    retry: (count, err) =>
      (err as { response?: { status?: number } })?.response?.status === 403 ? false : count < 2,
  });

  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  const forbidden = status === 403;

  const { data: patients } = useQuery<PatientOption[]>({
    queryKey: ['patients-list'],
    queryFn: () => apiClient.get('/patients', { params: { limit: 100 } }).then((res) => res.data.data || res.data),
  });

  const { data: providers } = useQuery<Array<{ id: string; firstName: string; lastName: string }>>({
    queryKey: ['providers-list'],
    queryFn: () => apiClient.get('/users/providers').then((res) => res.data),
  });

  const createPlan = useMutation({
    mutationFn: (data: any) => apiClient.post('/treatment-plans', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['treatment-plans'] });
      setShowNewModal(false);
      setNewPatientId('');
      setNewTitle('');
      setNewDescription('');
    },
    onError: (err: any) => {
      setNewError(getErrorMessage(err));
    },
  });

  const handleCreate = () => {
    const errors: string[] = [];
    if (!newPatientId) errors.push('Please select a patient');
    if (!newProviderId) errors.push('Please select a provider');
    if (!newTitle) errors.push('Plan title is required');
    else if (newTitle.length < 3) errors.push('Plan title must be at least 3 characters');
    else if (newTitle.length > 100) errors.push('Plan title must be at most 100 characters');
    if (newDescription && newDescription.length > 1000) errors.push('Description must be at most 1000 characters');
    if (errors.length > 0) {
      setNewError(errors[0]);
      return;
    }
    setNewError(null);
    createPlan.mutate({
      patientId: newPatientId,
      providerId: newProviderId,
      title: newTitle,
      description: newDescription || undefined,
      items: [],
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Treatment Plans</h2>
          <p className="text-gray-600">Manage patient treatment plans</p>
        </div>
        {/* Hidden when the role cannot read plans; the API refuses the write
            regardless, and offering the action only invites a dead end. */}
        <Button onClick={() => setShowNewModal(true)} disabled={forbidden}>
          <Plus className="mr-2 h-4 w-4" />
          New Plan
        </Button>
      </div>

      {showNewModal && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader>
            <CardTitle>New Treatment Plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {newError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{newError}</div>
            )}
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Patient</Label>
                <select className="w-full border rounded-lg px-3 py-2 text-sm" value={newPatientId} onChange={(e) => setNewPatientId(e.target.value)}>
                  <option value="">Select patient</option>
                  {patients?.map((p) => (
                    <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Provider</Label>
                <select className="w-full border rounded-lg px-3 py-2 text-sm" value={newProviderId} onChange={(e) => setNewProviderId(e.target.value)}>
                  <option value="">Select provider</option>
                  {providers?.map((p) => (
                    <option key={p.id} value={p.id}>Dr. {p.firstName} {p.lastName}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Plan Title</Label>
                <Input placeholder="e.g., Root Canal Treatment" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description (optional)</Label>
              <Input placeholder="Brief description of the treatment plan" value={newDescription} onChange={(e) => setNewDescription(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewModal(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!newPatientId || !newProviderId || !newTitle || createPlan.isPending}>
                {createPlan.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create Plan
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Card key={i}><CardContent className="p-6"><Skeleton className="h-6 w-32 mb-4" /><Skeleton className="h-4 w-48 mb-2" /><Skeleton className="h-4 w-24" /></CardContent></Card>
          ))}
        </div>
      ) : forbidden ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="font-medium text-gray-900">You do not have access to treatment plans</p>
            <p className="mt-1 text-sm text-gray-500">
              Your role does not include clinical treatment plans. Ask an administrator if you
              believe you should have access.
            </p>
          </CardContent>
        </Card>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="font-medium text-gray-900">Treatment plans could not be loaded</p>
            <p className="mt-1 text-sm text-gray-500">Please try again shortly.</p>
          </CardContent>
        </Card>
      ) : plans?.length === 0 ? (
        <Card><CardContent className="py-12 text-center"><p className="text-gray-500">No treatment plans yet</p></CardContent></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {plans?.map((plan) => (
            <Link key={plan.id} href={`/treatment-plans/${plan.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="p-6">
                  <div className="flex items-start justify-between mb-4">
                    <h3 className="font-semibold text-gray-900">{plan.title}</h3>
                    <Badge className={statusColors[plan.status]}>{plan.status}</Badge>
                  </div>
                  {plan.description && <p className="text-sm text-gray-500 mb-4 line-clamp-2">{plan.description}</p>}
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2 text-gray-600"><User className="h-4 w-4" />{plan.patient.firstName} {plan.patient.lastName}</div>
                    <div className="flex items-center gap-2 text-gray-600"><Calendar className="h-4 w-4" />{new Date(plan.createdAt).toLocaleDateString()}</div>
                    {plan.estimatedCost && <div className="flex items-center gap-2 text-gray-600"><DollarSign className="h-4 w-4" />${plan.estimatedCost.toLocaleString()}</div>}
                  </div>
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-xs text-gray-500">{plan.items.length} procedure{plan.items.length !== 1 ? 's' : ''}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
