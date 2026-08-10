'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import apiClient, { getErrorMessage } from '@/lib/api-client';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, User, Phone, Mail, Save, Loader2 } from 'lucide-react';
import Link from 'next/link';

interface PatientProfile {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone: string;
  dateOfBirth: string;
  gender?: string;
  address?: string;
  emergencyContact?: string;
  emergencyPhone?: string;
  medicalHistory?: string;
  dentalHistory?: string;
  allergies?: string;
}

export default function PortalProfilePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formData, setFormData] = useState<Partial<PatientProfile>>({});

  const { data: profile, isLoading } = useQuery<PatientProfile>({
    queryKey: ['portal-profile'],
    queryFn: () => apiClient.get('/portal/profile').then((res) => res.data),
  });

  const updateProfile = useMutation({
    mutationFn: (data: Partial<PatientProfile>) =>
      apiClient.patch('/portal/profile', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['portal-profile'] });
      setIsEditing(false);
    },
    onError: (err: any) => {
      setError(getErrorMessage(err));
    },
  });

  const handleEdit = () => {
    setFormData({
      phone: profile?.phone || '',
      address: profile?.address || '',
      emergencyContact: profile?.emergencyContact || '',
      emergencyPhone: profile?.emergencyPhone || '',
    });
    setIsEditing(true);
    setError(null);
  };

  const handleSave = () => {
    if (formData.phone && formData.phone.length < 10) {
      setError('Phone number must be at least 10 characters');
      return;
    }
    if (formData.phone && formData.phone.length > 20) {
      setError('Phone number must be at most 20 characters');
      return;
    }
    if (formData.address && formData.address.length > 255) {
      setError('Address must be at most 255 characters');
      return;
    }
    if (formData.emergencyContact && formData.emergencyContact.length > 100) {
      setError('Emergency contact name must be at most 100 characters');
      return;
    }
    if (formData.emergencyPhone && formData.emergencyPhone.length > 20) {
      setError('Emergency phone must be at most 20 characters');
      return;
    }
    setError(null);
    updateProfile.mutate(formData);
  };

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-2xl">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Link href="/portal">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-900">My Profile</h2>
          <p className="text-gray-600">Manage your personal information</p>
        </div>
        {!isEditing && (
          <Button onClick={handleEdit}>Edit Profile</Button>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-lg bg-red-50 border border-red-200 text-red-700">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <User className="h-5 w-5" />
            Personal Information
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-blue-100">
              <span className="text-xl font-bold text-blue-600">
                {profile?.firstName[0]}
                {profile?.lastName[0]}
              </span>
            </div>
            <div>
              <p className="text-lg font-semibold">
                {profile?.firstName} {profile?.lastName}
              </p>
              <p className="text-gray-500">Patient</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label className="text-gray-500">Email</Label>
              <p className="font-medium flex items-center gap-2">
                <Mail className="h-4 w-4 text-gray-400" />
                {profile?.email || 'Not provided'}
              </p>
            </div>
            <div>
              <Label className="text-gray-500">Date of Birth</Label>
              <p className="font-medium">
                {profile?.dateOfBirth
                  ? new Date(profile.dateOfBirth).toLocaleDateString()
                  : 'Not provided'}
              </p>
            </div>
          </div>

          <div>
            <Label className="text-gray-500">Phone</Label>
            {isEditing ? (
              <Input
                value={formData.phone || ''}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                className="mt-1"
              />
            ) : (
              <p className="font-medium flex items-center gap-2">
                <Phone className="h-4 w-4 text-gray-400" />
                {profile?.phone || 'Not provided'}
              </p>
            )}
          </div>

          <div>
            <Label className="text-gray-500">Address</Label>
            {isEditing ? (
              <Input
                value={formData.address || ''}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                className="mt-1"
              />
            ) : (
              <p className="font-medium">{profile?.address || 'Not provided'}</p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Emergency Contact</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-gray-500">Contact Name</Label>
            {isEditing ? (
              <Input
                value={formData.emergencyContact || ''}
                onChange={(e) =>
                  setFormData({ ...formData, emergencyContact: e.target.value })
                }
                className="mt-1"
              />
            ) : (
              <p className="font-medium">{profile?.emergencyContact || 'Not provided'}</p>
            )}
          </div>

          <div>
            <Label className="text-gray-500">Contact Phone</Label>
            {isEditing ? (
              <Input
                value={formData.emergencyPhone || ''}
                onChange={(e) =>
                  setFormData({ ...formData, emergencyPhone: e.target.value })
                }
                className="mt-1"
              />
            ) : (
              <p className="font-medium">{profile?.emergencyPhone || 'Not provided'}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {(profile?.allergies || profile?.medicalHistory || profile?.dentalHistory) && (
        <Card>
          <CardHeader>
            <CardTitle>Medical Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {profile?.allergies && (
              <div>
                <Label className="text-gray-500">Allergies</Label>
                <p className="font-medium text-red-600">{profile.allergies}</p>
              </div>
            )}
            {profile?.medicalHistory && (
              <div>
                <Label className="text-gray-500">Medical History</Label>
                <p className="font-medium">{profile.medicalHistory}</p>
              </div>
            )}
            {profile?.dentalHistory && (
              <div>
                <Label className="text-gray-500">Dental History</Label>
                <p className="font-medium">{profile.dentalHistory}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {isEditing && (
        <div className="flex gap-4">
          <Button onClick={handleSave} disabled={updateProfile.isPending}>
            {updateProfile.isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="mr-2 h-4 w-4" />
                Save Changes
              </>
            )}
          </Button>
          <Button variant="outline" onClick={() => setIsEditing(false)}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
