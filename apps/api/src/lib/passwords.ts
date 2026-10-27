import * as argon2 from 'argon2';

const minimumLength = 15;
const maximumLength = 256;
const maximumBytes = 1024;
const blockedPasswords = new Set([
  '123456789012345',
  'passwordpassword',
  'qwertyuiopasdfg',
  'letmeinletmein1',
  'iloveyouiloveyou',
]);

export function validatePassword(password: string): string | null {
  const length = [...password].length;

  if (length < minimumLength) {
    return 'PASSWORD_TOO_SHORT';
  }
  if (length > maximumLength || Buffer.byteLength(password, 'utf8') > maximumBytes) {
    return 'PASSWORD_TOO_LONG';
  }
  if (blockedPasswords.has(password.toLowerCase())) {
    return 'PASSWORD_COMMON';
  }

  return null;
}

const argonOptions: argon2.HashOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, argonOptions);
}

export function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
