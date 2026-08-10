export const USER_PUBLIC_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  isActive: true,
  roleId: true,
  role: { select: { id: true, name: true, description: true } },
  createdAt: true,
  updatedAt: true,
} as const;

export const USER_PROVIDER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  role: { select: { id: true, name: true } },
} as const;
