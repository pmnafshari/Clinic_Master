'use client';

import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { FileText, ArrowLeft, DollarSign, Calendar } from 'lucide-react';
import Link from 'next/link';

interface TreatmentPlan {
  id: string;
  title: string;
  description?: string;
  status: string;
  estimatedCost?: number;
  provider: { firstName: string; lastName: string };
  items: Array<{
    id: string;
    description: string;
    cost: number;
    status: string;
  }>;
  createdAt: string;
}

const statusColors: Record<string, string> = {
  planned: 'bg-blue-100 text-blue-800',
  approved: 'bg-green-100 text-green-800',
  'in-progress': 'bg-yellow-100 text-yellow-800',
  completed: 'bg-gray-100 text-gray-800',
  cancelled: 'bg-red-100 text-red-800',
};

export default function PortalTreatmentsPage() {
  const { data: treatments, isLoading } = useQuery<TreatmentPlan[]>({
    queryKey: ['portal-treatments'],
    queryFn: () => apiClient.get('/portal/treatments').then((res) => res.data),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/portal">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div>
          <h2 className="text-2xl font-bold text-gray-900">My Treatments</h2>
          <p className="text-gray-600">View your treatment history and plans</p>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-32 mb-4" />
                <Skeleton className="h-4 w-48 mb-2" />
                <Skeleton className="h-4 w-32" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : treatments?.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <FileText className="h-12 w-12 text-gray-300 mx-auto mb-4" />
            <p className="text-gray-500">No treatment plans yet</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {treatments?.map((treatment) => {
            const totalCost = treatment.items.reduce((sum, item) => sum + item.cost, 0);
            const completedItems = treatment.items.filter(
              (item) => item.status === 'completed'
            ).length;

            return (
              <Card key={treatment.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>{treatment.title}</CardTitle>
                    <Badge className={statusColors[treatment.status]}>
                      {treatment.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {treatment.description && (
                    <p className="text-gray-600">{treatment.description}</p>
                  )}

                  <div className="flex items-center gap-6 text-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-gray-500">Provider:</span>
                      <span className="font-medium">
                        Dr. {treatment.provider.firstName} {treatment.provider.lastName}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Calendar className="h-4 w-4 text-gray-400" />
                      <span>{new Date(treatment.createdAt).toLocaleDateString()}</span>
                    </div>
                  </div>

                  <div className="border-t pt-4">
                    <div className="flex items-center justify-between mb-3">
                      <p className="font-medium">Procedures ({treatment.items.length})</p>
                      <p className="text-sm text-gray-500">
                        {completedItems}/{treatment.items.length} completed
                      </p>
                    </div>

                    <div className="space-y-2">
                      {treatment.items.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                        >
                          <div className="flex items-center gap-3">
                            <div
                              className={`w-2 h-2 rounded-full ${
                                item.status === 'completed'
                                  ? 'bg-green-500'
                                  : item.status === 'in-progress'
                                  ? 'bg-yellow-500'
                                  : 'bg-gray-300'
                              }`}
                            />
                            <span className="text-sm">{item.description}</span>
                          </div>
                          <div className="flex items-center gap-3">
                            <Badge variant="outline" className={statusColors[item.status]}>
                              {item.status}
                            </Badge>
                            <span className="text-sm font-medium">
                              ${item.cost.toLocaleString()}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 pt-4 border-t flex justify-between items-center">
                      <span className="text-sm text-gray-500">Estimated Total</span>
                      <div className="flex items-center gap-1">
                        <DollarSign className="h-4 w-4" />
                        <span className="font-bold text-lg">
                          {totalCost.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
