'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import apiClient from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatCurrency } from '@/lib/utils';
import { exportData, slugify, type ExportFormat } from '@/lib/export';
import {
  Users,
  Calendar,
  DollarSign,
  CreditCard,
  TrendingUp,
  RefreshCw,
  Download,
  Filter,
  ClipboardList,
  BarChart3,
  PieChart as PieChartIcon,
  Activity,
  UserPlus,
  AlertTriangle,
  FileText,
  LayoutDashboard,
} from 'lucide-react';

interface DashboardKPIs {
  totalPatients: number;
  newPatients: number;
  appointments: number;
  revenue: number;
  pendingInvoices: number;
  completedAppointments: number;
  noShowAppointments: number;
  noShowRate: number;
}

interface RevenueSummary {
  totalRevenue: number;
  byPaymentMethod: Array<{ method: string; total: number; count: number }>;
}

interface AppointmentStats {
  total: number;
  byStatus: Array<{ status: string; count: number; percentage: number }>;
}

interface TreatmentStats {
  total: number;
  accepted: number;
  acceptanceRate: number;
  byStatus: Array<{ status: string; count: number }>;
}

interface PatientStats {
  total: number;
  newPatients: number;
  byMonth: Array<{ month: string; label: string; count: number }>;
}

type ReportType = 'overview' | 'revenue' | 'appointments' | 'treatments' | 'patients';
type DateRange = 'this-month' | 'last-month' | 'this-quarter' | 'this-year' | 'custom';

const reportTabs: Array<{ value: ReportType; label: string; icon: typeof LayoutDashboard }> = [
  { value: 'overview', label: 'Overview', icon: LayoutDashboard },
  { value: 'revenue', label: 'Revenue', icon: DollarSign },
  { value: 'appointments', label: 'Appointments', icon: Calendar },
  { value: 'treatments', label: 'Treatment Plans', icon: ClipboardList },
  { value: 'patients', label: 'Patients', icon: Users },
];

const statusColors: Record<string, string> = {
  scheduled: '#3b82f6',
  confirmed: '#6366f1',
  'in-progress': '#f59e0b',
  completed: '#22c55e',
  cancelled: '#ef4444',
  'no-show': '#9ca3af',
};

const methodPalette = ['#6366f1', '#22c55e', '#f59e0b', '#3b82f6', '#ec4899', '#14b8a6', '#a855f7'];

const dateRangeOptions: Array<{ value: DateRange; label: string }> = [
  { value: 'this-month', label: 'This Month' },
  { value: 'last-month', label: 'Last Month' },
  { value: 'this-quarter', label: 'This Quarter' },
  { value: 'this-year', label: 'This Year' },
  { value: 'custom', label: 'Custom' },
];

function getDateRange(range: DateRange, customStart?: string, customEnd?: string) {
  const now = new Date();
  let startDate: Date;
  let endDate: Date = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  let label: string;

  switch (range) {
    case 'last-month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0);
      label = `${startDate.toLocaleString('default', { month: 'long' })} ${startDate.getFullYear()}`;
      break;
    case 'this-quarter':
      const quarter = Math.floor(now.getMonth() / 3);
      startDate = new Date(now.getFullYear(), quarter * 3, 1);
      label = `Q${quarter + 1} ${now.getFullYear()}`;
      break;
    case 'this-year':
      startDate = new Date(now.getFullYear(), 0, 1);
      label = `${now.getFullYear()}`;
      break;
    case 'custom':
      startDate = customStart ? new Date(customStart) : new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = customEnd ? new Date(customEnd) : endDate;
      label = `${startDate.toLocaleDateString()} - ${endDate.toLocaleDateString()}`;
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      label = `${now.toLocaleString('default', { month: 'long' })} ${now.getFullYear()}`;
  }

  return { start: startDate.toISOString(), end: endDate.toISOString(), label };
}

const tooltipStyle = {
  borderRadius: '12px',
  border: '1px solid #e5e7eb',
  boxShadow: '0 10px 25px -5px rgb(0 0 0 / 0.1)',
  fontSize: '13px',
};

function KpiCard({
  label,
  value,
  icon: Icon,
  gradient,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ComponentType<{ className?: string }>;
  gradient: string;
  sub?: React.ReactNode;
}) {
  return (
    <Card className="overflow-hidden rounded-2xl border-gray-100 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md">
      <CardContent className="p-5">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-gray-500">{label}</p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-gray-900">{value}</p>
          </div>
          <div
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-lg`}
          >
            <Icon className="h-5 w-5" />
          </div>
        </div>
        {sub && <div className="mt-3 border-t border-gray-50 pt-2 text-xs text-gray-500">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function SectionTitle({
  icon: Icon,
  title,
  accent,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  accent: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2.5">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${accent}`}>
          <Icon className="h-4 w-4" />
        </div>
        <h3 className="font-semibold text-gray-900">{title}</h3>
      </div>
      {right}
    </div>
  );
}

export default function ReportsPage() {
  const [activeTab, setActiveTab] = useState<ReportType>('overview');
  const [dateRange, setDateRange] = useState<DateRange>('this-month');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');

  const { start, end, label } = getDateRange(dateRange, customStart, customEnd);

  const queryOptions = {
    params: { startDate: start, endDate: end },
  };

  const dashboardQuery = useQuery<DashboardKPIs>({
    queryKey: ['reports-dashboard', start, end],
    queryFn: () => apiClient.get('/reports/dashboard', queryOptions).then((r) => r.data),
  });
  const revenueQuery = useQuery<RevenueSummary>({
    queryKey: ['reports-revenue', start, end],
    queryFn: () => apiClient.get('/reports/revenue', queryOptions).then((r) => r.data),
  });
  const appointmentsQuery = useQuery<AppointmentStats>({
    queryKey: ['reports-appointments', start, end],
    queryFn: () => apiClient.get('/reports/appointments', queryOptions).then((r) => r.data),
  });
  const treatmentsQuery = useQuery<TreatmentStats>({
    queryKey: ['reports-treatments', start, end],
    queryFn: () => apiClient.get('/reports/treatments', queryOptions).then((r) => r.data),
  });
  const patientsQuery = useQuery<PatientStats>({
    queryKey: ['reports-patients', start, end],
    queryFn: () => apiClient.get('/reports/patients', queryOptions).then((r) => r.data),
  });

  const queries = {
    overview: dashboardQuery,
    revenue: revenueQuery,
    appointments: appointmentsQuery,
    treatments: treatmentsQuery,
    patients: patientsQuery,
  } as const;

  const isLoading = queries[activeTab].isLoading;

  const handleRefresh = () => {
    dashboardQuery.refetch();
    revenueQuery.refetch();
    appointmentsQuery.refetch();
    treatmentsQuery.refetch();
    patientsQuery.refetch();
  };

  const handleExport = () => {
    const base = `smileflow-${activeTab}-${slugify(label)}`;

    switch (activeTab) {
      case 'revenue': {
        const d = revenueQuery.data;
        if (!d) return;
        const rows = d.byPaymentMethod.map((m) => ({
          method: m.method,
          count: m.count,
          total: m.total,
          share:
            d.totalRevenue > 0 ? `${((m.total / d.totalRevenue) * 100).toFixed(1)}%` : '0%',
        }));
        exportData(exportFormat, `${base}.${exportFormat}`, rows);
        break;
      }
      case 'appointments': {
        const d = appointmentsQuery.data;
        if (!d) return;
        const rows = d.byStatus.map((s) => ({
          status: s.status,
          count: s.count,
          percentage: `${s.percentage.toFixed(1)}%`,
        }));
        exportData(exportFormat, `${base}.${exportFormat}`, rows);
        break;
      }
      case 'treatments': {
        const d = treatmentsQuery.data;
        if (!d) return;
        const rows = d.byStatus.map((s) => ({
          status: s.status,
          count: s.count,
          percentage: d.total > 0 ? `${((s.count / d.total) * 100).toFixed(1)}%` : '0%',
        }));
        exportData(exportFormat, `${base}.${exportFormat}`, rows);
        break;
      }
      case 'patients': {
        const d = patientsQuery.data;
        if (!d) return;
        const rows = d.byMonth.map((m) => ({ month: m.label, count: m.count }));
        exportData(exportFormat, `${base}.${exportFormat}`, rows);
        break;
      }
      default: {
        const d = dashboardQuery.data;
        if (!d) return;
        exportData(exportFormat, `${base}.${exportFormat}`, [d]);
      }
    }
  };

  const ActiveTabIcon = reportTabs.find((t) => t.value === activeTab)!.icon;

  return (
    <div className="space-y-6">
      {/* Header banner */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-blue-600 via-indigo-600 to-violet-600 p-6 shadow-lg shadow-indigo-500/20">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute -bottom-20 right-32 h-48 w-48 rounded-full bg-white/10 blur-2xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur-sm ring-1 ring-white/25">
              <BarChart3 className="h-7 w-7 text-white" />
            </div>
            <div>
              <h2 className="text-2xl font-bold text-white">Reports & Analytics</h2>
              <p className="text-sm text-indigo-100">
                Clinic performance for <span className="font-semibold text-white">{label}</span>
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              onClick={handleRefresh}
              className="bg-white/15 text-white ring-1 ring-white/25 backdrop-blur-sm hover:bg-white/25"
              size="sm"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" />
              Refresh
            </Button>
            <Button
              onClick={handleExport}
              disabled={isLoading}
              className="bg-white text-indigo-700 shadow-md hover:bg-indigo-50"
              size="sm"
            >
              <Download className="mr-1.5 h-4 w-4" />
              Export {exportFormat.toUpperCase()}
            </Button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2">
        {reportTabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => setActiveTab(tab.value)}
              className={`flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white shadow-md shadow-blue-500/25'
                  : 'bg-white text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50'
              }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <Card className="rounded-2xl border-gray-100 shadow-sm">
        <CardContent className="p-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2 text-sm font-medium text-gray-600">
                <Filter className="h-4 w-4 text-gray-400" />
                <span>Date Range</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {dateRangeOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => setDateRange(option.value)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                      dateRange === option.value
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              {dateRange === 'custom' && (
                <div className="flex items-center gap-2 text-sm">
                  <input
                    type="date"
                    value={customStart}
                    onChange={(e) => setCustomStart(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                  <span className="text-gray-400">to</span>
                  <input
                    type="date"
                    value={customEnd}
                    onChange={(e) => setCustomEnd(e.target.value)}
                    className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">Export as</span>
                <Select value={exportFormat} onValueChange={(v) => setExportFormat(v as ExportFormat)}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="csv">CSV</SelectItem>
                    <SelectItem value="json">JSON</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-2xl" />
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Skeleton className="h-80 rounded-2xl" />
            <Skeleton className="h-80 rounded-2xl" />
          </div>
        </div>
      ) : (
        <>
          {activeTab === 'overview' && (
            <OverviewContent
              dashboard={dashboardQuery.data}
              revenue={revenueQuery.data}
              appointments={appointmentsQuery.data}
              treatments={treatmentsQuery.data}
              patients={patientsQuery.data}
            />
          )}
          {activeTab === 'revenue' && <RevenueContent data={revenueQuery.data} />}
          {activeTab === 'appointments' && <AppointmentsContent data={appointmentsQuery.data} />}
          {activeTab === 'treatments' && <TreatmentsContent data={treatmentsQuery.data} />}
          {activeTab === 'patients' && <PatientsContent data={patientsQuery.data} />}

          <div className="flex items-center justify-center gap-2 text-xs text-gray-400">
            <ActiveTabIcon className="h-3.5 w-3.5" />
            Showing <span className="font-medium text-gray-500">{label}</span> · exported via CSV or
            JSON
          </div>
        </>
      )}
    </div>
  );
}

function OverviewContent({
  dashboard,
  revenue,
  appointments,
  treatments,
  patients,
}: {
  dashboard?: DashboardKPIs;
  revenue?: RevenueSummary;
  appointments?: AppointmentStats;
  treatments?: TreatmentStats;
  patients?: PatientStats;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Total Patients"
          value={(dashboard?.totalPatients ?? 0).toLocaleString()}
          icon={Users}
          gradient="from-blue-500 to-indigo-500"
          sub={
            <span className="inline-flex items-center gap-1 font-medium text-green-600">
              <UserPlus className="h-3.5 w-3.5" /> {patients?.newPatients ?? 0} new in period
            </span>
          }
        />
        <KpiCard
          label="Appointments"
          value={(dashboard?.appointments ?? 0).toLocaleString()}
          icon={Calendar}
          gradient="from-indigo-500 to-violet-500"
          sub={
            <span className="inline-flex items-center gap-1 font-medium text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" /> {dashboard?.noShowRate?.toFixed(1) ?? 0}% no-show
            </span>
          }
        />
        <KpiCard
          label="Revenue"
          value={formatCurrency(dashboard?.revenue ?? 0)}
          icon={DollarSign}
          gradient="from-emerald-500 to-green-600"
          sub={
            <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
              <TrendingUp className="h-3.5 w-3.5" /> {(revenue?.byPaymentMethod.length ?? 0)} payment
              methods
            </span>
          }
        />
        <KpiCard
          label="Pending Invoices"
          value={(dashboard?.pendingInvoices ?? 0).toLocaleString()}
          icon={CreditCard}
          gradient="from-amber-500 to-orange-500"
          sub={
            <span className="text-gray-500">
              {dashboard?.completedAppointments ?? 0} appointments completed
            </span>
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="rounded-2xl border-gray-100 shadow-sm">
          <CardContent className="p-5">
            <SectionTitle
              icon={PieChartIcon}
              title="Revenue by Payment Method"
              accent="bg-emerald-100 text-emerald-600"
            />
            {!revenue?.byPaymentMethod?.length ? (
              <p className="py-12 text-center text-sm text-gray-500">No revenue data in period</p>
            ) : (
              <div className="mt-4 space-y-3">
                {revenue.byPaymentMethod.map((method, i) => {
                  const max = Math.max(...revenue.byPaymentMethod.map((m) => m.total));
                  const pct = max > 0 ? (method.total / max) * 100 : 0;
                  return (
                    <div key={method.method}>
                      <div className="mb-1 flex items-center justify-between text-sm">
                        <span className="flex items-center gap-2 font-medium capitalize text-gray-700">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: methodPalette[i % methodPalette.length] }}
                          />
                          {method.method.replace('_', ' ')}
                        </span>
                        <span className="font-semibold text-gray-900">
                          {formatCurrency(method.total ?? 0)}
                          <span className="ml-2 text-xs font-normal text-gray-400">
                            {method.count} payments
                          </span>
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${pct}%`,
                            backgroundColor: methodPalette[i % methodPalette.length],
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-gray-100 shadow-sm">
          <CardContent className="p-5">
            <SectionTitle
              icon={Activity}
              title="Appointments by Status"
              accent="bg-indigo-100 text-indigo-600"
            />
            {!appointments?.byStatus?.length ? (
              <p className="py-12 text-center text-sm text-gray-500">No appointment data in period</p>
            ) : (
              <div className="mt-4 space-y-3">
                {appointments.byStatus.map((stat) => (
                  <div key={stat.status}>
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 font-medium capitalize text-gray-700">
                        <span
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: statusColors[stat.status] || '#9ca3af' }}
                        />
                        {stat.status.replace('-', ' ')}
                      </span>
                      <span className="text-sm text-gray-500">
                        <span className="font-semibold text-gray-900">{stat.count}</span>
                        <span className="ml-2 w-10 inline-block text-right text-xs">
                          {stat.percentage.toFixed(0)}%
                        </span>
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full"
                        style={{
                          width: `${stat.percentage}%`,
                          backgroundColor: statusColors[stat.status] || '#9ca3af',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-2xl border-gray-100 shadow-sm">
        <CardContent className="p-5">
          <SectionTitle
            icon={TrendingUp}
            title="Treatment Plan Acceptance"
            accent="bg-violet-100 text-violet-600"
            right={
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-sm font-bold text-emerald-600">
                {treatments?.acceptanceRate?.toFixed(1) ?? 0}% accepted
              </span>
            }
          />
          {!treatments?.byStatus?.length ? (
            <p className="py-10 text-center text-sm text-gray-500">No treatment plans in period</p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {treatments.byStatus.map((stat) => (
                <div
                  key={stat.status}
                  className="flex items-center gap-3 rounded-xl border border-gray-100 p-3"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
                    <FileText className="h-5 w-5" />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-gray-900">{stat.count}</p>
                    <p className="text-xs capitalize text-gray-500">{stat.status.replace('-', ' ')}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RevenueContent({ data }: { data?: RevenueSummary }) {
  if (!data) return null;
  const total = data.totalRevenue || 0;
  const chartData = data.byPaymentMethod.map((m, i) => ({
    ...m,
    name: m.method.replace('_', ' '),
    fill: methodPalette[i % methodPalette.length],
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="rounded-2xl border-gray-100 shadow-sm lg:col-span-2">
        <CardContent className="p-5">
          <SectionTitle
            icon={PieChartIcon}
            title="Revenue Mix"
            accent="bg-emerald-100 text-emerald-600"
          />
          {!chartData.length ? (
            <p className="py-20 text-center text-sm text-gray-500">No revenue data in period</p>
          ) : (
            <>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartData}
                      dataKey="total"
                      nameKey="name"
                      innerRadius={60}
                      outerRadius={95}
                      paddingAngle={3}
                      strokeWidth={2}
                    >
                      {chartData.map((entry) => (
                        <Cell key={entry.method} fill={entry.fill} />
                      ))}
                    </Pie>
                    <Tooltip
                      contentStyle={tooltipStyle}
                      formatter={(value) => formatCurrency(Number(value))}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 rounded-xl bg-gray-50 p-4 text-center">
                <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                  Total Revenue
                </p>
                <p className="mt-1 text-2xl font-bold text-gray-900">{formatCurrency(total)}</p>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-gray-100 shadow-sm lg:col-span-3">
        <CardContent className="p-5">
          <SectionTitle
            icon={DollarSign}
            title="Breakdown by Payment Method"
            accent="bg-blue-100 text-blue-600"
          />
          {!data.byPaymentMethod.length ? (
            <p className="py-16 text-center text-sm text-gray-500">No revenue data in period</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs font-semibold uppercase tracking-wide text-gray-400">
                    <th className="pb-3 pr-4">Method</th>
                    <th className="pb-3 pr-4 text-right">Payments</th>
                    <th className="pb-3 pr-4 text-right">Amount</th>
                    <th className="pb-3 text-right">Share</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {data.byPaymentMethod.map((m, i) => (
                    <tr key={m.method}>
                      <td className="py-3 pr-4">
                        <span className="flex items-center gap-2 font-medium capitalize text-gray-700">
                          <span
                            className="h-3 w-3 rounded-full"
                            style={{ backgroundColor: methodPalette[i % methodPalette.length] }}
                          />
                          {m.method.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-right text-gray-500">{m.count}</td>
                      <td className="py-3 pr-4 text-right font-semibold text-gray-900">
                        {formatCurrency(m.total ?? 0)}
                      </td>
                      <td className="py-3 text-right">
                        <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-600">
                          {total > 0 ? ((m.total / total) * 100).toFixed(1) : 0}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AppointmentsContent({ data }: { data?: AppointmentStats }) {
  if (!data) return null;
  const chartData = data.byStatus.map((s) => ({
    name: s.status.replace('-', ' '),
    count: s.count,
    fill: statusColors[s.status] || '#9ca3af',
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="rounded-2xl border-gray-100 shadow-sm">
        <CardContent className="p-5">
          <SectionTitle
            icon={BarChart3}
            title="Appointments by Status"
            accent="bg-indigo-100 text-indigo-600"
            right={
              <span className="text-sm text-gray-500">
                <span className="font-bold text-gray-900">{data.total}</span> total
              </span>
            }
          />
          {!chartData.length ? (
            <p className="py-24 text-center text-sm text-gray-500">No appointment data in period</p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} barSize={44}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12, fill: '#6b7280' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: '#6b7280' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ fill: '#f9fafb' }}
                    formatter={(value) => [value, 'Appointments']}
                  />
                  <Bar dataKey="count" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-gray-100 shadow-sm">
        <CardContent className="p-5">
          <SectionTitle
            icon={Activity}
            title="Status Breakdown"
            accent="bg-amber-100 text-amber-600"
          />
          {!data.byStatus.length ? (
            <p className="py-16 text-center text-sm text-gray-500">No appointment data in period</p>
          ) : (
            <div className="mt-4 space-y-4">
              {data.byStatus.map((stat) => {
                const color = statusColors[stat.status] || '#9ca3af';
                return (
                  <div key={stat.status}>
                    <div className="mb-1.5 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 font-medium capitalize text-gray-700">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
                        {stat.status.replace('-', ' ')}
                      </span>
                      <span className="text-gray-500">
                        <span className="font-bold text-gray-900">{stat.count}</span>
                        <span className="ml-2 text-xs">{stat.percentage.toFixed(1)}%</span>
                      </span>
                    </div>
                    <div className="h-2.5 overflow-hidden rounded-full bg-gray-100">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{ width: `${stat.percentage}%`, backgroundColor: color }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TreatmentsContent({ data }: { data?: TreatmentStats }) {
  if (!data) return null;
  const rate = data.acceptanceRate ?? 0;
  const circumference = 2 * Math.PI * 54;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="rounded-2xl border-gray-100 shadow-sm">
        <CardContent className="p-6">
          <SectionTitle
            icon={ClipboardList}
            title="Acceptance Rate"
            accent="bg-violet-100 text-violet-600"
          />
          <div className="flex flex-col items-center py-6">
            <div className="relative h-40 w-40">
              <svg viewBox="0 0 120 120" className="h-full w-full -rotate-90">
                <circle cx="60" cy="60" r="54" fill="none" stroke="#f3f4f6" strokeWidth="12" />
                <circle
                  cx="60"
                  cy="60"
                  r="54"
                  fill="none"
                  stroke="#8b5cf6"
                  strokeWidth="12"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - rate / 100)}
                />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-3xl font-bold text-gray-900">{rate.toFixed(1)}%</span>
                <span className="text-xs text-gray-400">accepted</span>
              </div>
            </div>
            <div className="mt-6 grid w-full grid-cols-2 gap-3">
              <div className="rounded-xl bg-gray-50 p-3 text-center">
                <p className="text-xl font-bold text-gray-900">{data.total}</p>
                <p className="text-xs text-gray-500">Total plans</p>
              </div>
              <div className="rounded-xl bg-emerald-50 p-3 text-center">
                <p className="text-xl font-bold text-emerald-600">{data.accepted}</p>
                <p className="text-xs text-gray-500">Accepted</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-gray-100 shadow-sm lg:col-span-2">
        <CardContent className="p-5">
          <SectionTitle
            icon={FileText}
            title="Plans by Status"
            accent="bg-blue-100 text-blue-600"
          />
          {!data.byStatus.length ? (
            <p className="py-16 text-center text-sm text-gray-500">No treatment plans in period</p>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {data.byStatus.map((stat) => (
                <div
                  key={stat.status}
                  className="flex items-center gap-4 rounded-xl border border-gray-100 p-4 transition-shadow hover:shadow-sm"
                >
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-indigo-500 text-white shadow-md shadow-blue-500/20">
                    <FileText className="h-6 w-6" />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{stat.count}</p>
                    <p className="text-xs capitalize text-gray-500">{stat.status.replace('-', ' ')}</p>
                  </div>
                  <span className="ml-auto rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                    {data.total > 0 ? ((stat.count / data.total) * 100).toFixed(0) : 0}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PatientsContent({ data }: { data?: PatientStats }) {
  if (!data) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Total Patients"
          value={data.total.toLocaleString()}
          icon={Users}
          gradient="from-blue-500 to-indigo-500"
        />
        <KpiCard
          label="New Patients"
          value={data.newPatients.toLocaleString()}
          icon={UserPlus}
          gradient="from-emerald-500 to-green-600"
          sub={<span>created in selected period</span>}
        />
        <KpiCard
          label="Growth Rate"
          value={`${data.total > 0 ? ((data.newPatients / data.total) * 100).toFixed(1) : 0}%`}
          icon={TrendingUp}
          gradient="from-violet-500 to-purple-600"
          sub={<span>new / total patients</span>}
        />
      </div>

      <Card className="rounded-2xl border-gray-100 shadow-sm">
        <CardContent className="p-5">
          <SectionTitle
            icon={BarChart3}
            title="New Patients per Month"
            accent="bg-indigo-100 text-indigo-600"
          />
          {!data.byMonth?.length ? (
            <p className="py-24 text-center text-sm text-gray-500">No new patients in period</p>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.byMonth} barSize={36}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 12, fill: '#6b7280' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fontSize: 12, fill: '#6b7280' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip contentStyle={tooltipStyle} cursor={{ fill: '#f9fafb' }} />
                  <Bar dataKey="count" fill="#6366f1" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
