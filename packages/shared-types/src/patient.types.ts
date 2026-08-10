export interface Patient {
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
  notes?: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PatientDocument {
  id: string;
  patientId: string;
  fileName: string;
  fileUrl: string;
  fileType: string;
  fileSize?: bigint;
  uploadedBy?: string;
  createdAt: string;
}
