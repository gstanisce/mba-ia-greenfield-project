import type { ValidationError } from 'joi';
import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_ENDPOINT: 'http://rustfs:9000',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'access',
  S3_SECRET_KEY: 'secret',
  S3_BUCKET: 'streamtube',
};

const validate = (
  env: Record<string, string>,
): { error?: ValidationError; value: Record<string, string> } =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — object storage and upload keys', () => {
  it('should reject when S3_BUCKET is empty and name the key', () => {
    const { error } = validate({ S3_BUCKET: '' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('S3_BUCKET');
  });

  it('should apply the UPLOAD_* defaults when they are not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.UPLOAD_MAX_BYTES).toBe(10737418240);
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.UPLOAD_URL_TTL_SECONDS).toBe(3600);
  });
});
