import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { App } from './app';
import { AuthApi, type AccountUser } from './auth-api';

describe('App', () => {
  const authApi = {
    user: signal<AccountUser | null>(null),
    googleConfigured: signal(false),
    initialize: async () => {},
    errorMessage: () => 'Something went wrong.',
  };

  beforeEach(async () => {
    localStorage.setItem('account-language', 'en');
    history.replaceState(null, '', '/');
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [{ provide: AuthApi, useValue: authApi }],
    })
      .compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the sign-in form', async () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Your account, securely.');
    expect(compiled.querySelector('input[type="email"]')).not.toBeNull();
    expect(compiled.querySelector('input[type="password"]')).not.toBeNull();
    expect(compiled.querySelector('button[type="submit"]')?.textContent).toContain('Sign in');
  });

  it('only asks for an email on the password reset request form', async () => {
    history.replaceState(null, '', '/forgot-password');
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;

    expect(compiled.querySelector('h1')?.textContent).toContain('Reset your password');
    expect(compiled.querySelectorAll('input')).toHaveLength(1);
    expect(compiled.querySelector('button[type="submit"]')?.textContent).toContain('Send reset link');
  });
});
