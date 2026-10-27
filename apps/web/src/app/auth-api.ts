import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export type AccountUser = {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN';
};

export type AdminUser = AccountUser & {
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  createdAt: string;
};

export type AuditEvent = {
  id: string;
  event: string;
  createdAt: string;
};

type ApiError = {
  error?: {
    code?: string;
    message?: string;
  };
};

@Injectable({ providedIn: 'root' })
export class AuthApi {
  private readonly http = inject(HttpClient);
  private csrfToken: string | null = null;
  private csrfRequest: Promise<void> | null = null;
  readonly user = signal<AccountUser | null>(null);
  readonly googleConfigured = signal(false);
  readonly adminUsers = signal<AdminUser[]>([]);
  readonly auditEvents = signal<AuditEvent[]>([]);

  async initialize(): Promise<void> {
    await this.refreshCsrf();
    const result = await firstValueFrom(
      this.http.get<{ user: AccountUser | null }>('/api/auth/me'),
    );
    this.user.set(result.user);
    if (result.user?.role === 'ADMIN') {
      await this.refreshAdminData();
    }
  }

  async login(email: string, password: string): Promise<void> {
    await this.post<{ user: AccountUser }>('/api/auth/login', { email, password });
    await this.refreshAccount();
  }

  async logout(): Promise<void> {
    await this.post('/api/auth/logout', {});
    this.user.set(null);
    this.adminUsers.set([]);
    this.auditEvents.set([]);
  }

  async logoutOtherSessions(): Promise<void> {
    await this.post('/api/auth/logout-others', {});
  }

  async requestReset(email: string): Promise<void> {
    await this.post('/api/auth/forgot-password', { email });
  }

  async acceptInvitation(token: string, password: string): Promise<void> {
    await this.post('/api/auth/accept-invitation', { token, password });
    await this.refreshAccount();
  }

  async resetPassword(token: string, password: string): Promise<void> {
    await this.post('/api/auth/reset-password', { token, password });
  }

  async requestEmailChange(email: string): Promise<void> {
    await this.post('/api/auth/change-email', { email });
  }

  async inviteUser(email: string): Promise<void> {
    await this.post('/api/admin/users', { email });
    await this.refreshAdminData();
  }

  async resendInvitation(userId: string): Promise<void> {
    await this.post(`/api/admin/users/${encodeURIComponent(userId)}/invite`, {});
  }

  async setUserStatus(userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<void> {
    await this.patch(`/api/admin/users/${encodeURIComponent(userId)}/status`, { status });
    await this.refreshAdminData();
  }

  async refreshAdminData(): Promise<void> {
    const [users, audit] = await Promise.all([
      firstValueFrom(this.http.get<{ users: AdminUser[] }>('/api/admin/users')),
      firstValueFrom(this.http.get<{ events: AuditEvent[] }>('/api/admin/audit')),
    ]);
    this.adminUsers.set(users.users);
    this.auditEvents.set(audit.events);
  }

  async confirmEmailChange(token: string): Promise<void> {
    await this.post('/api/auth/confirm-email-change', { token });
    await this.refreshAccount();
  }

  async refreshAccount(): Promise<void> {
    const result = await firstValueFrom(
      this.http.get<{ user: AccountUser | null }>('/api/auth/me'),
    );
    this.user.set(result.user);
  }

  errorMessage(error: unknown, language: 'en' | 'th'): string {
    if (error instanceof HttpErrorResponse) {
      const body = error.error as ApiError | null;
      const code = body?.error?.code;
      const messages = language === 'th'
        ? {
            password: 'ตั้งวลีรหัสผ่านที่ไม่ซ้ำใครและมีความยาวอย่างน้อย 15 ตัวอักษร',
            token: 'ลิงก์นี้ไม่ถูกต้องหรือหมดอายุแล้ว โปรดขอลิงก์ใหม่จากผู้ดูแลระบบ',
            emailUnavailable: 'ไม่สามารถใช้อีเมลนี้ได้',
            emailUnchanged: 'อีเมลใหม่นี้ตรงกับอีเมลปัจจุบัน',
            credentials: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง',
            rateLimit: 'ลองหลายครั้งเกินไป โปรดรอสักครู่แล้วลองใหม่',
            generic: 'เกิดข้อผิดพลาด โปรดลองอีกครั้ง',
          }
        : {
            password: 'Choose a unique passphrase with at least 15 characters.',
            token: 'This link is invalid or has expired. Ask your administrator for a new one.',
            emailUnavailable: 'That email address cannot be used.',
            emailUnchanged: 'The new email is the same as your current email.',
            credentials: 'Email or password is incorrect.',
            rateLimit: 'Too many attempts. Please wait a while and try again.',
            generic: 'Something went wrong. Please try again.',
          };

      if (code === 'PASSWORD_TOO_SHORT' || code === 'PASSWORD_TOO_LONG' || code === 'PASSWORD_COMMON') {
        return messages.password;
      }
      if (code === 'TOKEN_INVALID') {
        return messages.token;
      }
      if (code === 'EMAIL_UNAVAILABLE') {
        return messages.emailUnavailable;
      }
      if (code === 'EMAIL_UNCHANGED') {
        return messages.emailUnchanged;
      }
      if (error.status === 401) {
        return messages.credentials;
      }
      if (error.status === 429) {
        return messages.rateLimit;
      }
      return messages.generic;
    }

    return language === 'th' ? 'เกิดข้อผิดพลาด โปรดลองอีกครั้ง' : 'Something went wrong. Please try again.';
  }

  private async post<T = { ok: boolean }>(url: string, body: unknown): Promise<T> {
    await this.ensureCsrf();
    return firstValueFrom(
      this.http.post<T>(url, body, {
        headers: { 'x-csrf-token': this.csrfToken ?? '' },
      }),
    );
  }

  private async patch<T = { ok: boolean }>(url: string, body: unknown): Promise<T> {
    await this.ensureCsrf();
    return firstValueFrom(
      this.http.patch<T>(url, body, {
        headers: { 'x-csrf-token': this.csrfToken ?? '' },
      }),
    );
  }

  private async ensureCsrf(): Promise<void> {
    if (this.csrfToken) {
      return;
    }
    await this.refreshCsrf();
  }

  private async refreshCsrf(): Promise<void> {
    if (!this.csrfRequest) {
      this.csrfRequest = firstValueFrom(
        this.http.get<{ csrf: { token: string }; googleConfigured: boolean }>('/api/meta'),
      )
        .then((result) => {
          this.csrfToken = result.csrf.token;
          this.googleConfigured.set(result.googleConfigured);
        })
        .finally(() => {
          this.csrfRequest = null;
        });
    }
    await this.csrfRequest;
  }
}
