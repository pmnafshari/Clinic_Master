'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, User, Calendar, DollarSign, Loader2, Check, X, Play, Trash2 } from 'lucide-react';
import Link from 'next/link';

interface TreatmentPlanItem {
  id: string;
  procedureCode: string;
  description: string;
  cost: number;
  status: string;
  teethInvolved?: number;
  notes?: string;
}

interface TreatmentPlan {
  id: string;
  title: string;
  description?: string;
  status: string;
  estimatedCost?: number;
  patient: { id: string; firstName: string; lastName: string };
  provider: { firstName: string; lastName: string };
  items: TreatmentPlanItem[];
  createdAt: string;
}

const statusColors: Record<string, string> = {
  planned: 'bg-blue-100 text-blue-800',
  approved: 'bg-green-100 text-green-800',
  'in-progress': 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-800',
  cancelled: 'bg-red-100 text-red-800',
};

const statusActions: Record<string, Array<{ label: string; status: string; color: string; icon: typeof Check }>> = {
  planned: [
    { label: 'Approve', status: 'approved', color: 'bg-green-600 hover:bg-green-700', icon: Check },
    { label: 'Cancel', status: 'cancelled', color: 'bg-red-600 hover:bg-red-700', icon: X },
  ],
  approved: [
    { label: 'Start Treatment', status: 'in-progress', color: 'bg-yellow-600 hover:bg-yellow-700', icon: Play },
    { label: 'Cancel', status: 'cancelled', color: 'bg-red-600 hover:bg-red-700', icon: X },
  ],
  'in-progress': [
    { label: 'Complete', status: 'completed', color: 'bg-gray-600 hover:bg-gray-700', icon: Check },
    { label: 'Cancel', status: 'cancelled', color: 'bg-red-600 hover:bg-red-700', icon: X },
  ],
};

export default function TreatmentPlanDetailPage() {
  const params = useParams();
  const router = useRouter();
  const planId = params.id as string;
  const queryClient = useQueryClient();

  const { data: plan, isLoading } = useQuery<TreatmentPlan>({
    queryKey: ['treatment-plan', planId],
    queryFn: () => apiClient.get(`/treatment-plans/${planId}`).then((res) => res.data),
  });

  const updateStatus = useMutation({
    mutationFn: (status: string) => apiClient.patch(`/treatment-plans/${planId}`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['treatment-plan', planId] });
      queryClient.invalidateQueries({ queryKey: ['treatment-plans'] });
    },
  });

  const deletePlan = useMutation({
    mutationFn: () => apiClient.delete(`/treatment-plans/${planId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['treatment-plans'] });
      router.push('/treatment-plans');
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Treatment plan not found</p>
      </div>
    );
  }

  const totalCost = plan.items.reduce((sum, item) => sum + item.cost, 0);
  const actions = statusActions[plan.status];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/treatment-plans">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-900">{plan.title}</h2>
          <p className="text-gray-600">Treatment Plan Details</p>
        </div>
        <Badge className={statusColors[plan.status]}>{plan.status}</Badge>
        {actions?.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.status}
              className={action.color}
              onClick={() => updateStatus.mutate(action.status)}
              disabled={updateStatus.isPending}
            >
              {updateStatus.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Icon className="mr-2 h-4 w-4" />}
              {action.label}
            </Button>
          );
        })}
        {(plan.status === 'planned' || plan.status === 'cancelled') && (
          <Button
            variant="outline"
            className="text-red-600 border-red-200 hover:bg-red-50"
            onClick={() => {
              if (confirm('Delete this treatment plan?')) deletePlan.mutate();
            }}
            disabled={deletePlan.isPending}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Delete
          </Button>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-100">
                <User className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Patient</p>
                <p className="font-medium">{plan.patient.firstName} {plan.patient.lastName}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
                <User className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Provider</p>
                <p className="font-medium">Dr. {plan.provider.firstName} {plan.provider.lastName}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-purple-100">
                <DollarSign className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Estimated Cost</p>
                <p className="font-medium">${totalCost.toLocaleString()}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {plan.description && (
        <Card>
          <CardHeader><CardTitle>Description</CardTitle></CardHeader>
          <CardContent><p className="text-gray-700">{plan.description}</p></CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Procedures ({plan.items.length})</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4">
            {plan.items.map((item, index) => (
              <div key={item.id} className="flex items-center justify-between p-4 border rounded-lg">
                <div className="flex items-center gap-4">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 text-sm font-medium">{index + 1}</span>
                  <div>
                    <p className="font-medium">{item.description}</p>
                    <p className="text-sm text-gray-500">
                      Code: {item.procedureCode}
                      {item.teethInvolved && ` • Tooth #${item.teethInvolved}`}
                    </p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-medium">${item.cost.toLocaleString()}</p>
                  <Badge variant="outline" className={statusColors[item.status]}>{item.status}</Badge>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-6 pt-4 border-t flex justify-between">
            <span className="font-medium text-gray-900">Total</span>
            <span className="font-bold text-lg">${totalCost.toLocaleString()}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
