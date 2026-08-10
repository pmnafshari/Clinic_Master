'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient, { getErrorMessage } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Plus, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface ToothEntry {
  id: string;
  toothNumber: number;
  surface?: string;
  condition: string;
  procedure?: string;
  status: 'planned' | 'in-progress' | 'completed';
  notes?: string;
}

interface ClinicalChart {
  id: string;
  clinicalNotes?: string;
  toothEntries: ToothEntry[];
  createdAt: string;
}

export default function ChartingPage() {
  const params = useParams();
  const patientId = params.patientId as string;
  const queryClient = useQueryClient();
  const [selectedTooth, setSelectedTooth] = useState<number | null>(null);
  const [showNewChart, setShowNewChart] = useState(false);
  const [showNewTooth, setShowNewTooth] = useState(false);
  const [newToothNumber, setNewToothNumber] = useState('');
  const [newCondition, setNewCondition] = useState('healthy');
  const [newSurface, setNewSurface] = useState('');
  const [newProcedure, setNewProcedure] = useState('');
  const [newNotes, setNewNotes] = useState('');
  const [newClinicalNotes, setNewClinicalNotes] = useState('');
  const [newError, setNewError] = useState<string | null>(null);

  const { data: charts, isLoading } = useQuery<ClinicalChart[]>({
    queryKey: ['charts', patientId],
    queryFn: () => apiClient.get(`/charting/patient/${patientId}`).then((res) => res.data),
  });

  const latestChart = charts?.[0];

  const createChart = useMutation({
    mutationFn: (data: any) => apiClient.post('/charting', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['charts', patientId] });
      setShowNewChart(false);
    },
  });

  const addToothEntry = useMutation({
    mutationFn: ({ chartId, data }: { chartId: string; data: any }) =>
      apiClient.post(`/charting/${chartId}/teeth`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['charts', patientId] });
      setShowNewTooth(false);
      setNewToothNumber('');
      setNewCondition('healthy');
      setNewSurface('');
      setNewProcedure('');
      setNewNotes('');
    },
    onError: (err: any) => {
      setNewError(getErrorMessage(err));
    },
  });

  const handleCreateChart = () => {
    if (newClinicalNotes && newClinicalNotes.length > 5000) {
      setNewError('Clinical notes must be at most 5000 characters');
      return;
    }
    setNewError(null);
    createChart.mutate({ patientId, clinicalNotes: newClinicalNotes || 'New chart entry' });
  };

  const handleAddTooth = () => {
    if (!latestChart) {
      setNewError('Please create a clinical chart first');
      return;
    }
    if (!newToothNumber) {
      setNewError('Please select a tooth number');
      return;
    }
    const toothNum = parseInt(newToothNumber);
    const validNumbers = [11,12,13,14,15,16,17,18,21,22,23,24,25,26,27,28,31,32,33,34,35,36,37,38,41,42,43,44,45,46,47,48];
    if (!validNumbers.includes(toothNum)) {
      setNewError('Please select a valid tooth number (FDI notation: 11-48)');
      return;
    }
    if (newSurface && newSurface.length > 10) {
      setNewError('Surface must be at most 10 characters');
      return;
    }
    if (newProcedure && newProcedure.length > 100) {
      setNewError('Procedure must be at most 100 characters');
      return;
    }
    if (newNotes && newNotes.length > 500) {
      setNewError('Notes must be at most 500 characters');
      return;
    }
    setNewError(null);
    addToothEntry.mutate({
      chartId: latestChart.id,
      data: {
        toothNumber: parseInt(newToothNumber),
        condition: newCondition,
        surface: newSurface || undefined,
        procedure: newProcedure || undefined,
        notes: newNotes || undefined,
      },
    });
  };

  const upperTeeth = [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
  const lowerTeeth = [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];

  const getToothStatus = (toothNumber: number) => {
    return latestChart?.toothEntries.find((e) => e.toothNumber === toothNumber);
  };

  const conditionColors: Record<string, string> = {
    healthy: 'bg-green-100 border-green-300',
    cavity: 'bg-red-100 border-red-300',
    filling: 'bg-blue-100 border-blue-300',
    crown: 'bg-yellow-100 border-yellow-300',
    missing: 'bg-gray-200 border-gray-400',
    root_canal: 'bg-purple-100 border-purple-300',
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/patients">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-900">Dental Chart</h2>
          <p className="text-gray-600">Patient charting and odontogram</p>
        </div>
        <div className="flex gap-2">
          {!latestChart && (
            <Button onClick={() => setShowNewChart(true)}>
              <Plus className="mr-2 h-4 w-4" />
              New Chart
            </Button>
          )}
          {latestChart && (
            <Button onClick={() => setShowNewTooth(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Tooth Entry
            </Button>
          )}
        </div>
      </div>

      {showNewChart && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader><CardTitle>New Clinical Chart</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Clinical Notes</Label>
              <textarea
                className="w-full border rounded-lg px-3 py-2 text-sm min-h-[80px]"
                placeholder="Enter clinical observations, findings, and notes..."
                value={newClinicalNotes}
                onChange={(e) => setNewClinicalNotes(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => { setShowNewChart(false); setNewClinicalNotes(''); }}>Cancel</Button>
              <Button onClick={handleCreateChart} disabled={createChart.isPending}>
                {createChart.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Create Chart
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {showNewTooth && latestChart && (
        <Card className="border-blue-200 bg-blue-50/50">
          <CardHeader><CardTitle>Add Tooth Entry</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {newError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-700 text-sm">{newError}</div>
            )}
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>Tooth Number</Label>
                <select className="w-full border rounded-lg px-3 py-2 text-sm" value={newToothNumber} onChange={(e) => setNewToothNumber(e.target.value)}>
                  <option value="">Select tooth</option>
                  {[...upperTeeth, ...lowerTeeth].sort((a, b) => a - b).map((t) => (
                    <option key={t} value={t}>Tooth #{t}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Condition</Label>
                <select className="w-full border rounded-lg px-3 py-2 text-sm" value={newCondition} onChange={(e) => setNewCondition(e.target.value)}>
                  {Object.keys(conditionColors).map((c) => (
                    <option key={c} value={c}>{c.replace('_', ' ')}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Surface (optional)</Label>
                <Input placeholder="e.g., MO, DO, O" value={newSurface} onChange={(e) => setNewSurface(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Procedure (optional)</Label>
                <Input placeholder="e.g., Composite filling" value={newProcedure} onChange={(e) => setNewProcedure(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Notes (optional)</Label>
                <Input placeholder="Additional notes" value={newNotes} onChange={(e) => setNewNotes(e.target.value)} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setShowNewTooth(false)}>Cancel</Button>
              <Button onClick={handleAddTooth} disabled={!newToothNumber || addToothEntry.isPending}>
                {addToothEntry.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Add Entry
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Odontogram</CardTitle></CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-gray-500 mb-2">Upper Arch</p>
              <div className="flex justify-center gap-1">
                {upperTeeth.map((tooth) => {
                  const entry = getToothStatus(tooth);
                  return (
                    <button key={tooth} onClick={() => setSelectedTooth(tooth)} className={`w-12 h-16 border-2 rounded-lg flex flex-col items-center justify-center text-xs transition-all ${selectedTooth === tooth ? 'ring-2 ring-blue-500' : ''} ${entry ? conditionColors[entry.condition] || 'bg-white border-gray-200' : 'bg-white border-gray-200 hover:border-gray-400'}`}>
                      <span className="font-bold">{tooth}</span>
                      {entry && <span className="text-[10px] text-gray-600 truncate w-full text-center">{entry.condition}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="border-t pt-4">
              <p className="text-sm font-medium text-gray-500 mb-2">Lower Arch</p>
              <div className="flex justify-center gap-1">
                {lowerTeeth.map((tooth) => {
                  const entry = getToothStatus(tooth);
                  return (
                    <button key={tooth} onClick={() => setSelectedTooth(tooth)} className={`w-12 h-16 border-2 rounded-lg flex flex-col items-center justify-center text-xs transition-all ${selectedTooth === tooth ? 'ring-2 ring-blue-500' : ''} ${entry ? conditionColors[entry.condition] || 'bg-white border-gray-200' : 'bg-white border-gray-200 hover:border-gray-400'}`}>
                      <span className="font-bold">{tooth}</span>
                      {entry && <span className="text-[10px] text-gray-600 truncate w-full text-center">{entry.condition}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex flex-wrap gap-4 pt-4 border-t">
              {Object.entries(conditionColors).map(([condition, colors]) => (
                <div key={condition} className="flex items-center gap-2">
                  <div className={`w-4 h-4 border-2 rounded ${colors}`} />
                  <span className="text-xs text-gray-600 capitalize">{condition.replace('_', ' ')}</span>
                </div>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {selectedTooth && (
        <Card>
          <CardHeader><CardTitle>Tooth #{selectedTooth} Details</CardTitle></CardHeader>
          <CardContent>
            {getToothStatus(selectedTooth) ? (
              <div className="space-y-2">
                <p><span className="font-medium">Condition:</span> {getToothStatus(selectedTooth)?.condition}</p>
                {getToothStatus(selectedTooth)?.surface && <p><span className="font-medium">Surface:</span> {getToothStatus(selectedTooth)?.surface}</p>}
                {getToothStatus(selectedTooth)?.procedure && <p><span className="font-medium">Procedure:</span> {getToothStatus(selectedTooth)?.procedure}</p>}
                <p><span className="font-medium">Status:</span> <Badge variant="outline">{getToothStatus(selectedTooth)?.status}</Badge></p>
                {getToothStatus(selectedTooth)?.notes && <p><span className="font-medium">Notes:</span> {getToothStatus(selectedTooth)?.notes}</p>}
              </div>
            ) : (
              <p className="text-gray-500">No entries for this tooth</p>
            )}
          </CardContent>
        </Card>
      )}

      {latestChart?.clinicalNotes && (
        <Card>
          <CardHeader><CardTitle>Clinical Notes</CardTitle></CardHeader>
          <CardContent><p className="text-gray-700">{latestChart.clinicalNotes}</p></CardContent>
        </Card>
      )}
    </div>
  );
}
