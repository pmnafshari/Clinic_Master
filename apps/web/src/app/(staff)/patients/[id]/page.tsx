'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { usePatient, useUpdatePatient } from '@/hooks/use-patients';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowLeft, Phone, Mail, MapPin, AlertTriangle, FileText, Edit, Loader2 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';

export default function PatientDetailPage() {
  const params = useParams();
  const patientId = params.id as string;
  const queryClient = useQueryClient();
  const { data: patient, isLoading } = usePatient(patientId);
  const updatePatient = useUpdatePatient();
  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    address: '',
    emergencyContact: '',
    emergencyPhone: '',
    medicalHistory: '',
    dentalHistory: '',
    allergies: '',
  });

  const startEdit = () => {
    if (!patient) return;
    setEditData({
      firstName: patient.firstName || '',
      lastName: patient.lastName || '',
      email: patient.email || '',
      phone: patient.phone || '',
      address: patient.address || '',
      emergencyContact: patient.emergencyContact || '',
      emergencyPhone: patient.emergencyPhone || '',
      medicalHistory: patient.medicalHistory || '',
      dentalHistory: patient.dentalHistory || '',
      allergies: patient.allergies || '',
    });
    setIsEditing(true);
  };

  const handleSave = () => {
    updatePatient.mutate(
      { id: patientId, data: editData },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ['patient', patientId] });
          setIsEditing(false);
        },
      }
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!patient) {
    return <div className="text-center py-12"><p className="text-gray-500">Patient not found</p></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/patients">
          <Button variant="ghost" size="icon"><ArrowLeft className="h-5 w-5" /></Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-900">{patient.firstName} {patient.lastName}</h2>
          <p className="text-gray-600">Patient Details</p>
        </div>
        {!isEditing ? (
          <Button variant="outline" onClick={startEdit}>
            <Edit className="mr-2 h-4 w-4" />
            Edit
          </Button>
        ) : (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setIsEditing(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={updatePatient.isPending}>
              {updatePatient.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Save
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Personal Information</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
                <span className="text-xl font-bold text-blue-600">{patient.firstName[0]}{patient.lastName[0]}</span>
              </div>
              <div>
                {isEditing ? (
                  <div className="flex gap-2">
                    <Input value={editData.firstName} onChange={(e) => setEditData({ ...editData, firstName: e.target.value })} placeholder="First name" className="w-32" />
                    <Input value={editData.lastName} onChange={(e) => setEditData({ ...editData, lastName: e.target.value })} placeholder="Last name" className="w-32" />
                  </div>
                ) : (
                  <>
                    <p className="text-lg font-semibold">{patient.firstName} {patient.lastName}</p>
                    <p className="text-gray-500">
                      {patient.gender && <span className="capitalize">{patient.gender}</span>}
                      {patient.dateOfBirth && <span> • Born {new Date(patient.dateOfBirth).toLocaleDateString()}</span>}
                    </p>
                  </>
                )}
              </div>
            </div>
            <div className="space-y-3 pt-4 border-t">
              <div className="flex items-center gap-3 text-sm">
                <Phone className="h-4 w-4 text-gray-400" />
                {isEditing ? <Input value={editData.phone} onChange={(e) => setEditData({ ...editData, phone: e.target.value })} className="flex-1" /> : <span>{patient.phone}</span>}
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Mail className="h-4 w-4 text-gray-400" />
                {isEditing ? <Input value={editData.email} onChange={(e) => setEditData({ ...editData, email: e.target.value })} className="flex-1" /> : <span>{patient.email || 'No email'}</span>}
              </div>
              <div className="flex items-center gap-3 text-sm">
                <MapPin className="h-4 w-4 text-gray-400" />
                {isEditing ? <Input value={editData.address} onChange={(e) => setEditData({ ...editData, address: e.target.value })} className="flex-1" /> : <span>{patient.address || 'No address'}</span>}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Emergency Contact</CardTitle></CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="space-y-3">
                <div className="space-y-1"><Label>Name</Label><Input value={editData.emergencyContact} onChange={(e) => setEditData({ ...editData, emergencyContact: e.target.value })} /></div>
                <div className="space-y-1"><Label>Phone</Label><Input value={editData.emergencyPhone} onChange={(e) => setEditData({ ...editData, emergencyPhone: e.target.value })} /></div>
              </div>
            ) : patient.emergencyContact ? (
              <div className="space-y-2">
                <p className="font-medium">{patient.emergencyContact}</p>
                {patient.emergencyPhone && <p className="text-sm text-gray-500">{patient.emergencyPhone}</p>}
              </div>
            ) : (
              <p className="text-gray-500">No emergency contact on file</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              Medical History
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="space-y-3">
                <div className="space-y-1"><Label>Allergies</Label><Input value={editData.allergies} onChange={(e) => setEditData({ ...editData, allergies: e.target.value })} /></div>
                <div className="space-y-1"><Label>Medical History</Label><Input value={editData.medicalHistory} onChange={(e) => setEditData({ ...editData, medicalHistory: e.target.value })} /></div>
              </div>
            ) : (
              <>
                {patient.allergies && (
                  <div className="mb-4">
                    <p className="text-sm font-medium text-red-600 mb-1">Allergies</p>
                    <p className="text-sm">{patient.allergies}</p>
                  </div>
                )}
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-1">Medical History</p>
                  <p className="text-sm text-gray-600">{patient.medicalHistory || 'No medical history on file'}</p>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-blue-500" />
              Dental History
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="space-y-1"><Label>Dental History</Label><Input value={editData.dentalHistory} onChange={(e) => setEditData({ ...editData, dentalHistory: e.target.value })} /></div>
            ) : (
              <p className="text-sm text-gray-600">{patient.dentalHistory || 'No dental history on file'}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex gap-4">
        <Link href={`/charting/${patientId}`}>
          <Button variant="outline"><FileText className="mr-2 h-4 w-4" />View Charts</Button>
        </Link>
      </div>
    </div>
  );
}
