export interface Role {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  isActive: boolean;
  roleId: string;
  role?: Role;
  createdAt: string;
  updatedAt: string;
}

export interface UserWithoutPassword extends Omit<User, 'passwordHash'> {}

export type UserRole = 'admin' | 'dentist' | 'assistant' | 'receptionist' | 'patient';
