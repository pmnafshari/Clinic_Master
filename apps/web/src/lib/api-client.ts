import axios from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api';

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('accessToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      try {
        const refreshToken = localStorage.getItem('refreshToken');
        if (refreshToken) {
          const response = await axios.post(`${API_BASE_URL}/auth/refresh`, {
            refreshToken,
          });

          const { accessToken, refreshToken: newRefreshToken } = response.data;
          localStorage.setItem('accessToken', accessToken);
          localStorage.setItem('refreshToken', newRefreshToken);

          originalRequest.headers.Authorization = `Bearer ${accessToken}`;
          return apiClient(originalRequest);
        }
      } catch (refreshError) {
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        window.location.href = '/login';
        return Promise.reject(refreshError);
      }
    }

    if (error.response?.status === 500) {
      const message = error.response?.data?.message || 'Server error occurred';
      console.error('Server error:', message);
    }

    return Promise.reject(error);
  }
);

export function getErrorMessages(error: any): string[] {
  if (error?.response?.data?.messages) {
    return error.response.data.messages;
  }
  if (Array.isArray(error?.response?.data?.message)) {
    return error.response.data.message;
  }
  if (error?.response?.data?.message) {
    return [error.response.data.message];
  }
  return ['An unexpected error occurred'];
}

export function getErrorMessage(error: any): string {
  return getErrorMessages(error)[0] || 'An unexpected error occurred';
}

export default apiClient;
