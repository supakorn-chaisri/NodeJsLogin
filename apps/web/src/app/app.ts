import { ChangeDetectionStrategy, Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { AuthApi } from './auth-api';

@Component({
  imports: [ReactiveFormsModule],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App implements OnInit {
  private readonly fb = inject(FormBuilder);
  protected readonly auth = inject(AuthApi);
  protected readonly language = signal<'en' | 'th'>(
    typeof navigator !== 'undefined' && navigator.language.toLowerCase().startsWith('en') ? 'en' : 'th',
  );
  protected readonly mode = signal<'login' | 'forgot' | 'invite' | 'reset' | 'confirm-email'>('login');
  protected readonly isLoading = signal(true);
  protected readonly isSubmitting = signal(false);
  protected readonly message = signal('');
  protected readonly error = signal('');
  protected readonly token = signal('');
  protected readonly tokenValid = computed(
    () => !['invite', 'reset', 'confirm-email'].includes(this.mode()) || this.token().length >= 32,
  );
  protected readonly accountForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(320)]],
    password: ['', [Validators.required, Validators.maxLength(1024)]],
    confirmPassword: ['', [Validators.required, Validators.maxLength(1024)]],
  });
  protected readonly adminForm = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email, Validators.maxLength(320)]],
  });
  protected readonly copy = computed(() => this.language() === 'th' ? thaiCopy : englishCopy);

  ngOnInit(): void {
    this.readRoute();
    this.updateValidators();
    void this.initialize();
  }

  protected async submit(): Promise<void> {
    this.error.set('');
    this.message.set('');
    this.accountForm.markAllAsTouched();

    if (this.accountForm.invalid) {
      return;
    }

    const { email, password, confirmPassword } = this.accountForm.getRawValue();
    const mode = this.mode();
    if ((mode === 'invite' || mode === 'reset') && password !== confirmPassword) {
      this.error.set(this.copy().passwordsDoNotMatch);
      return;
    }

    this.isSubmitting.set(true);
    try {
      if (mode === 'login') {
        await this.auth.login(email, password);
        this.message.set(this.copy().signedIn);
      } else if (mode === 'forgot') {
        await this.auth.requestReset(email);
        this.message.set(this.copy().resetSent);
      } else if (mode === 'invite') {
        await this.auth.acceptInvitation(this.token(), password);
        this.message.set(this.copy().invitationAccepted);
      } else if (mode === 'reset') {
        await this.auth.resetPassword(this.token(), password);
        await this.auth.refreshAccount();
        this.message.set(this.copy().passwordChanged);
        this.returnToSignIn();
      } else {
        await this.auth.confirmEmailChange(this.token());
        this.message.set(this.copy().emailChanged);
        this.returnToSignIn();
      }
      if (mode === 'login' || mode === 'invite') {
        location.assign('/');
      }
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async changeEmail(): Promise<void> {
    const emailControl = this.accountForm.controls.email;
    emailControl.markAsTouched();
    this.error.set('');
    this.message.set('');

    if (emailControl.invalid) {
      return;
    }

    this.isSubmitting.set(true);
    try {
      await this.auth.requestEmailChange(emailControl.value);
      this.message.set(this.copy().emailChangeSent);
      emailControl.reset('');
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async inviteUser(): Promise<void> {
    const emailControl = this.adminForm.controls.email;
    emailControl.markAsTouched();
    this.error.set('');
    this.message.set('');

    if (emailControl.invalid) {
      return;
    }

    this.isSubmitting.set(true);
    try {
      await this.auth.inviteUser(emailControl.value);
      this.message.set(this.copy().adminInviteSent);
      emailControl.reset('');
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async updateUserStatus(
    userId: string,
    status: 'ACTIVE' | 'DISABLED',
  ): Promise<void> {
    if (status === 'DISABLED' && !window.confirm(this.copy().disableUserConfirm)) {
      return;
    }

    this.error.set('');
    this.message.set('');
    this.isSubmitting.set(true);
    try {
      await this.auth.setUserStatus(userId, status);
      this.message.set(this.copy().userStatusUpdated);
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async resendInvitation(userId: string): Promise<void> {
    this.error.set('');
    this.message.set('');
    this.isSubmitting.set(true);
    try {
      await this.auth.resendInvitation(userId);
      this.message.set(this.copy().invitationResent);
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async logout(): Promise<void> {
    this.isSubmitting.set(true);
    try {
      await this.auth.logout();
      this.message.set(this.copy().signedOut);
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected async logoutOtherSessions(): Promise<void> {
    this.isSubmitting.set(true);
    try {
      await this.auth.logoutOtherSessions();
      this.message.set(this.copy().sessionsRevoked);
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isSubmitting.set(false);
    }
  }

  protected setLanguage(language: 'en' | 'th'): void {
    this.language.set(language);
    localStorage.setItem('account-language', language);
    document.documentElement.lang = language;
  }

  protected titleForMode(): string {
    const copy = this.copy();
    switch (this.mode()) {
      case 'forgot':
        return copy.forgotTitle;
      case 'invite':
        return copy.inviteTitle;
      case 'reset':
        return copy.resetTitle;
      case 'confirm-email':
        return copy.confirmEmailTitle;
      default:
        return copy.title;
    }
  }

  protected subtitleForMode(): string {
    const copy = this.copy();
    switch (this.mode()) {
      case 'forgot':
        return copy.forgotSubtitle;
      case 'invite':
        return copy.inviteSubtitle;
      case 'reset':
        return copy.resetSubtitle;
      case 'confirm-email':
        return copy.confirmEmailSubtitle;
      default:
        return copy.subtitle;
    }
  }

  protected submitLabel(): string {
    const copy = this.copy();
    switch (this.mode()) {
      case 'forgot':
        return copy.sendReset;
      case 'invite':
        return copy.inviteTitle;
      case 'reset':
        return copy.resetTitle;
      case 'confirm-email':
        return copy.confirmEmail;
      default:
        return this.isSubmitting() ? copy.signingIn : copy.signIn;
    }
  }

  private async initialize(): Promise<void> {
    const savedLanguage = localStorage.getItem('account-language');
    if (savedLanguage === 'en' || savedLanguage === 'th') {
      this.language.set(savedLanguage);
    }
    document.documentElement.lang = this.language();
    try {
      await this.auth.initialize();
      const oauthError = new URLSearchParams(location.search).get('error');
      if (oauthError) {
        this.error.set(this.copy().googleFailed);
        history.replaceState(null, '', location.pathname);
      }
    } catch (error: unknown) {
      this.error.set(this.auth.errorMessage(error, this.language()));
    } finally {
      this.isLoading.set(false);
    }
  }

  private readRoute(): void {
    const url = new URL(location.href);
    this.token.set(url.searchParams.get('token') ?? '');
    if (url.pathname === '/invite') {
      this.mode.set('invite');
    } else if (url.pathname === '/reset-password') {
      this.mode.set('reset');
    } else if (url.pathname === '/confirm-email-change') {
      this.mode.set('confirm-email');
    } else if (url.pathname === '/forgot-password') {
      this.mode.set('forgot');
    } else {
      this.mode.set('login');
    }
    this.updateValidators();
  }

  private returnToSignIn(): void {
    this.mode.set('login');
    this.token.set('');
    history.replaceState(null, '', '/');
    this.updateValidators();
  }

  private updateValidators(): void {
    const mode = this.mode();
    const emailValidators =
      mode === 'login' || mode === 'forgot'
        ? [Validators.required, Validators.email, Validators.maxLength(320)]
        : [];
    const passwordValidators =
      mode === 'login' || mode === 'invite' || mode === 'reset'
        ? [Validators.required, Validators.maxLength(1024)]
        : [];
    const confirmValidators =
      mode === 'invite' || mode === 'reset'
        ? [Validators.required, Validators.maxLength(1024)]
        : [];

    this.accountForm.controls.email.setValidators(emailValidators);
    this.accountForm.controls.password.setValidators(passwordValidators);
    this.accountForm.controls.confirmPassword.setValidators(confirmValidators);
    this.accountForm.controls.email.updateValueAndValidity({ emitEvent: false });
    this.accountForm.controls.password.updateValueAndValidity({ emitEvent: false });
    this.accountForm.controls.confirmPassword.updateValueAndValidity({ emitEvent: false });
    this.accountForm.updateValueAndValidity({ emitEvent: false });
  }
}

const englishCopy = {
  language: 'ภาษาไทย',
  title: 'Your account, securely.',
  subtitle: 'Sign in to continue to your workspace.',
  email: 'Email address',
  password: 'Password',
  confirmPassword: 'Confirm password',
  emailPlaceholder: 'you@your-company.com',
  passwordPlaceholder: 'Enter your password',
  signIn: 'Sign in',
  signingIn: 'Signing in…',
  google: 'Continue with Google',
  forgot: 'Forgot password?',
  backToSignIn: 'Back to sign in',
  forgotTitle: 'Reset your password',
  forgotSubtitle: 'Enter the email address linked to your account.',
  sendReset: 'Send reset link',
  inviteTitle: 'Set your password',
  inviteSubtitle: 'Choose a unique passphrase with at least 15 characters.',
  resetTitle: 'Choose a new password',
  resetSubtitle: 'Use a unique passphrase with at least 15 characters.',
  confirmEmailTitle: 'Confirm your new email',
  confirmEmailSubtitle: 'Confirm the email address requested for your account.',
  confirmEmail: 'Confirm email change',
  passwordsDoNotMatch: 'Passwords do not match.',
  signedIn: 'Signed in successfully.',
  signedOut: 'You have signed out.',
  resetSent: 'If that account can receive a reset email, a link will be sent.',
  invitationAccepted: 'Your account is ready.',
  passwordChanged: 'Your password has been updated. Sign in with your new password.',
  emailChanged: 'Your email address has been updated. Sign in again.',
  emailChangeSent: 'Check the new email address to confirm the change.',
  sessionsRevoked: 'Other sessions have been signed out.',
  googleFailed: 'Google sign-in could not be completed. Try again or use your password.',
  retry: 'Try again',
  loading: 'Loading your account…',
  invalidLink: 'This link is incomplete or invalid. Ask your administrator for a new one.',
  accountTitle: 'Account',
  accountSubtitle: 'Signed in as',
  changeEmail: 'Change email',
  requestEmailChange: 'Send verification link',
  logoutOtherSessions: 'Sign out other sessions',
  signOut: 'Sign out',
  passwordHint: 'At least 15 characters. Passphrases are welcome.',
  adminTitle: 'Member access',
  inviteMember: 'Invite a member',
  sendInvitation: 'Send invitation',
  adminInviteSent: 'Invitation queued for delivery.',
  userStatusUpdated: 'Member access updated.',
  invitationResent: 'Invitation queued for delivery.',
  disableUserConfirm: 'Disable this account and revoke its sessions?',
  invited: 'Invited',
  active: 'Active',
  disabled: 'Disabled',
  resend: 'Resend invitation',
  disable: 'Disable account',
  enable: 'Enable account',
  recentAudit: 'Recent account activity',
};

const thaiCopy = {
  language: 'English',
  title: 'บัญชีของคุณ ปลอดภัยทุกครั้ง',
  subtitle: 'เข้าสู่ระบบเพื่อใช้งานต่อ',
  email: 'อีเมล',
  password: 'รหัสผ่าน',
  confirmPassword: 'ยืนยันรหัสผ่าน',
  emailPlaceholder: 'you@your-company.com',
  passwordPlaceholder: 'กรอกรหัสผ่าน',
  signIn: 'เข้าสู่ระบบ',
  signingIn: 'กำลังเข้าสู่ระบบ…',
  google: 'เข้าสู่ระบบด้วย Google',
  forgot: 'ลืมรหัสผ่าน?',
  backToSignIn: 'กลับไปเข้าสู่ระบบ',
  forgotTitle: 'ตั้งรหัสผ่านใหม่',
  forgotSubtitle: 'กรอกอีเมลที่ใช้กับบัญชีของคุณ',
  sendReset: 'ส่งลิงก์รีเซ็ตรหัสผ่าน',
  inviteTitle: 'ตั้งรหัสผ่านของคุณ',
  inviteSubtitle: 'ตั้งวลีรหัสผ่านที่คาดเดายาก ความยาวอย่างน้อย 15 ตัวอักษร',
  resetTitle: 'เลือกรหัสผ่านใหม่',
  resetSubtitle: 'ใช้วลีรหัสผ่านที่ไม่ซ้ำใคร ความยาวอย่างน้อย 15 ตัวอักษร',
  confirmEmailTitle: 'ยืนยันอีเมลใหม่',
  confirmEmailSubtitle: 'ยืนยันอีเมลที่ต้องการใช้กับบัญชีของคุณ',
  confirmEmail: 'ยืนยันการเปลี่ยนอีเมล',
  passwordsDoNotMatch: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน',
  signedIn: 'เข้าสู่ระบบแล้ว',
  signedOut: 'ออกจากระบบแล้ว',
  resetSent: 'หากบัญชีนี้สามารถรับอีเมลรีเซ็ตรหัสผ่านได้ ระบบจะส่งลิงก์ให้',
  invitationAccepted: 'บัญชีของคุณพร้อมใช้งานแล้ว',
  passwordChanged: 'อัปเดตรหัสผ่านแล้ว กรุณาเข้าสู่ระบบด้วยรหัสผ่านใหม่',
  emailChanged: 'เปลี่ยนอีเมลแล้ว กรุณาเข้าสู่ระบบอีกครั้ง',
  emailChangeSent: 'โปรดตรวจสอบอีเมลใหม่เพื่อยืนยันการเปลี่ยนแปลง',
  sessionsRevoked: 'ออกจากระบบในอุปกรณ์อื่นแล้ว',
  googleFailed: 'เข้าสู่ระบบด้วย Google ไม่สำเร็จ ลองอีกครั้งหรือใช้รหัสผ่าน',
  retry: 'ลองอีกครั้ง',
  loading: 'กำลังโหลดบัญชี…',
  invalidLink: 'ลิงก์ไม่ครบหรือไม่ถูกต้อง โปรดขอลิงก์ใหม่จากผู้ดูแลระบบ',
  accountTitle: 'บัญชี',
  accountSubtitle: 'เข้าสู่ระบบด้วย',
  changeEmail: 'เปลี่ยนอีเมล',
  requestEmailChange: 'ส่งลิงก์ยืนยัน',
  logoutOtherSessions: 'ออกจากระบบในอุปกรณ์อื่น',
  signOut: 'ออกจากระบบ',
  passwordHint: 'อย่างน้อย 15 ตัวอักษร ใช้เป็นวลีรหัสผ่านได้',
  adminTitle: 'จัดการสิทธิ์สมาชิก',
  inviteMember: 'เชิญสมาชิก',
  sendInvitation: 'ส่งคำเชิญ',
  adminInviteSent: 'เพิ่มคำเชิญเข้าคิวส่งแล้ว',
  userStatusUpdated: 'อัปเดตสิทธิ์สมาชิกแล้ว',
  invitationResent: 'เพิ่มคำเชิญเข้าคิวส่งแล้ว',
  disableUserConfirm: 'ปิดใช้งานบัญชีนี้และออกจากระบบทุกเซสชันหรือไม่?',
  invited: 'รอการตอบรับ',
  active: 'ใช้งานอยู่',
  disabled: 'ปิดใช้งาน',
  resend: 'ส่งคำเชิญอีกครั้ง',
  disable: 'ปิดใช้งานบัญชี',
  enable: 'เปิดใช้งานบัญชี',
  recentAudit: 'กิจกรรมบัญชีล่าสุด',
};
