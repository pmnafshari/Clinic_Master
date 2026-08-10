'use client';

import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useQuery } from '@tanstack/react-query';
import apiClient from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { LogOut, Bell, Check, Clock, Mail, MessageSquare } from 'lucide-react';

interface Notification {
  id: string;
  type: string;
  channel: string;
  subject: string;
  content: string;
  status: string;
  createdAt: string;
}

const typeIcons: Record<string, typeof Bell> = {
  reminder: Clock,
  recall: Mail,
  'follow-up': MessageSquare,
  confirmation: Check,
};

export function Header() {
  const { user, logout } = useAuth();
  const [showNotifications, setShowNotifications] = useState(false);

  const { data: notifications } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: () => {
      const url = user?.role === 'patient' ? '/portal/notifications' : '/notifications';
      return apiClient.get(url).then((res) => res.data);
    },
    enabled: !!user,
    refetchInterval: 30000,
  });

  const unreadCount = notifications?.filter((n) => n.status === 'pending').length || 0;

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b bg-white px-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-gray-900">
          {user?.role === 'patient' ? 'Patient Portal' : 'Staff Dashboard'}
        </h1>
      </div>

      <div className="flex items-center gap-4">
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            onClick={() => setShowNotifications(!showNotifications)}
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span className="absolute right-1 top-1 h-4 w-4 rounded-full bg-red-500 text-[10px] text-white flex items-center justify-center font-medium">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </Button>

          {showNotifications && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowNotifications(false)} />
              <div className="absolute right-0 top-full mt-2 w-80 bg-white border rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                <div className="p-3 border-b font-medium text-sm">Notifications</div>
                {!notifications?.length ? (
                  <div className="p-4 text-center text-sm text-gray-500">No notifications</div>
                ) : (
                  <div className="divide-y">
                    {notifications.slice(0, 10).map((notif) => {
                      const Icon = typeIcons[notif.type] || Bell;
                      return (
                        <div key={notif.id} className={`p-3 hover:bg-gray-50 ${notif.status === 'pending' ? 'bg-blue-50/50' : ''}`}>
                          <div className="flex items-start gap-2">
                            <Icon className="h-4 w-4 mt-0.5 text-gray-400 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{notif.subject}</p>
                              <p className="text-xs text-gray-500 line-clamp-2">{notif.content}</p>
                              <p className="text-xs text-gray-400 mt-1">
                                {new Date(notif.createdAt).toLocaleDateString()}
                              </p>
                            </div>
                            {notif.status === 'pending' && (
                              <span className="h-2 w-2 rounded-full bg-blue-500 shrink-0 mt-1" />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <Button variant="ghost" size="sm" onClick={logout}>
          <LogOut className="mr-2 h-4 w-4" />
          Logout
        </Button>
      </div>
    </header>
  );
}
