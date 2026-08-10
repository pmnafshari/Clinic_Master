'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';
import {
  LayoutDashboard,
  Users,
  Calendar,
  Activity,
  FileText,
  CreditCard,
  BarChart3,
  Settings,
  User,
  Bell,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  TrendingUp,
  ClipboardList,
  Stethoscope,
  Receipt,
  PieChart,
  UserCog,
  HelpCircle,
  LogOut,
  Sparkles,
} from 'lucide-react';

interface NavItem {
  title: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
  roles?: string[];
}

interface NavSection {
  title: string;
  items: NavItem[];
  roles?: string[];
}

const staffNavSections: NavSection[] = [
  {
    title: 'Main',
    items: [
      { title: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    ],
    roles: ['admin', 'dentist', 'assistant', 'receptionist'],
  },
  {
    title: 'Clinical',
    items: [
      { title: 'Patients', href: '/patients', icon: Users },
      { title: 'Appointments', href: '/appointments', icon: Calendar },
      { title: 'Clinical Charts', href: '/patients', icon: Stethoscope },
      { title: 'Treatment Plans', href: '/treatment-plans', icon: ClipboardList },
    ],
    roles: ['admin', 'dentist', 'assistant', 'receptionist'],
  },
  {
    title: 'Billing',
    items: [
      { title: 'Invoices', href: '/billing/invoices', icon: Receipt },
      { title: 'Payments', href: '/billing/payments', icon: CreditCard },
    ],
    roles: ['admin', 'receptionist'],
  },
  {
    title: 'Analytics',
    items: [
      { title: 'Reports', href: '/reports', icon: BarChart3 },
    ],
    roles: ['admin', 'dentist', 'receptionist'],
  },
  {
    title: 'System',
    items: [
      { title: 'Settings', href: '/settings', icon: Settings },
    ],
    roles: ['admin'],
  },
];

const patientNavSections: NavSection[] = [
  {
    title: 'Main',
    items: [
      { title: 'Dashboard', href: '/portal', icon: LayoutDashboard },
    ],
  },
  {
    title: 'Appointments',
    items: [
      { title: 'Book Appointment', href: '/portal/book', icon: Calendar },
      { title: 'My Appointments', href: '/portal/appointments', icon: Bell },
    ],
  },
  {
    title: 'Billing',
    items: [
      { title: 'Invoices', href: '/portal/invoices', icon: Receipt },
      { title: 'Treatments', href: '/portal/treatments', icon: FileText },
    ],
  },
  {
    title: 'Account',
    items: [
      { title: 'My Profile', href: '/portal/profile', icon: User },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>(
    Object.fromEntries(
      (user?.role === 'patient' ? patientNavSections : staffNavSections).map((s) => [s.title, true])
    )
  );

  const isPatient = user?.role === 'patient';
  const sections = isPatient ? patientNavSections : staffNavSections;

  const filteredSections = sections
    .filter((section) => !section.roles || (user?.role && section.roles.includes(user.role)))
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) => !item.roles || (user?.role && item.roles.includes(user.role))
      ),
    }))
    .filter((section) => section.items.length > 0);

  const toggleSection = (title: string) => {
    setExpandedSections((prev) => ({ ...prev, [title]: !prev[title] }));
  };

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 h-screen border-r bg-white transition-all duration-300 flex flex-col',
        collapsed ? 'w-[68px]' : 'w-64'
      )}
    >
      {/* Logo */}
      <div className={cn('flex h-16 items-center border-b', collapsed ? 'justify-center px-2' : 'px-5')}>
        <Link href={isPatient ? '/portal' : '/dashboard'} className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-blue-600 to-indigo-600 text-white shadow-lg shadow-blue-500/25">
            <Sparkles className="h-5 w-5" />
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <span className="text-lg font-bold text-gray-900 leading-tight">SmileFlow</span>
              <span className="text-[10px] font-medium text-gray-400 leading-tight">
                {isPatient ? 'Patient Portal' : 'Dental Clinic'}
              </span>
            </div>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-6">
        {filteredSections.map((section) => (
          <div key={section.title}>
            {!collapsed && (
              <button
                onClick={() => toggleSection(section.title)}
                className="flex items-center justify-between w-full px-2 mb-1"
              >
                <span className="text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                  {section.title}
                </span>
                <ChevronDown
                  className={cn(
                    'h-3.5 w-3.5 text-gray-400 transition-transform',
                    !expandedSections[section.title] && '-rotate-90'
                  )}
                />
              </button>
            )}

            {(expandedSections[section.title] || collapsed) && (
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const isActive =
                    pathname === item.href || pathname.startsWith(item.href + '/');

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      title={collapsed ? item.title : undefined}
                      className={cn(
                        'group flex items-center gap-3 rounded-xl text-sm font-medium transition-all duration-200',
                        collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2.5',
                        isActive
                          ? 'bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-700 shadow-sm'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      )}
                    >
                      <div
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-lg transition-all',
                          isActive
                            ? 'bg-blue-600 text-white shadow-md shadow-blue-500/25'
                            : 'bg-gray-100 text-gray-500 group-hover:bg-gray-200 group-hover:text-gray-700'
                        )}
                      >
                        <Icon className="h-4 w-4" />
                      </div>
                      {!collapsed && (
                        <span className="flex-1">{item.title}</span>
                      )}
                      {!collapsed && item.badge && (
                        <span className="flex h-5 min-w-[20px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold text-white">
                          {item.badge}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </nav>

      {/* User Card */}
      {user && (
        <div className={cn('border-t p-3', collapsed ? 'px-2' : 'px-3')}>
          <div
            className={cn(
              'flex items-center rounded-xl p-2 transition-colors',
              collapsed ? 'justify-center' : 'gap-3',
              'hover:bg-gray-50 cursor-pointer'
            )}
            title={collapsed ? `${user.firstName} ${user.lastName}` : undefined}
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-500 text-white text-xs font-bold shadow-md shrink-0">
              {user.firstName[0]}
              {user.lastName[0]}
            </div>
            {!collapsed && (
              <>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">
                    {user.firstName} {user.lastName}
                  </p>
                  <p className="text-[11px] text-gray-400 capitalize">{user.role}</p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    logout();
                  }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                  title="Logout"
                >
                  <LogOut className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-20 flex h-6 w-6 items-center justify-center rounded-full border bg-white text-gray-500 shadow-md hover:bg-gray-50 hover:text-gray-700 transition-colors"
      >
        {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
      </button>
    </aside>
  );
}
