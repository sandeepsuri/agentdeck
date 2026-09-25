import { describe, expect, it } from 'vitest';
import { redactProbeText } from './redact.js';

describe('redactProbeText', () => {
  it('removes account identity a CLI prints before a probe report is written', () => {
    const raw = '{"account":{"type":"chatgpt","email":"person@example.com","planType":"plus"},"accountId":"00000000-1111-4222-8333-444444444444"}';

    const redacted = redactProbeText(raw, { home: '/Users/someone' });

    expect(redacted).toBe('{"account":{"type":"chatgpt","email":"<email>","planType":"plus"},"accountId":"<id>"}');
  });

  it('replaces the home directory and provider request identifiers in error text', () => {
    const raw = 'cwd=/Users/someone/work 401 Unauthorized, cf-ray: 0123456789abcdef-AAA, request id: req_0000example0000';

    const redacted = redactProbeText(raw, { home: '/Users/someone' });

    expect(redacted).toBe('cwd=~/work 401 Unauthorized, cf-ray: <ray>, request id: <request>');
  });

  it('never lets an API key or bearer token through', () => {
    const raw = 'Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.def key=sk-ant-api03-AbCdEf123456_xyz and sk-proj-QwErTy987654';

    const redacted = redactProbeText(raw, { home: '/Users/someone' });

    expect(redacted).toBe('Authorization: Bearer <secret> key=<secret> and <secret>');
  });

  it('removes OAuth/JWT tokens and organization identifiers that are not UUIDs', () => {
    const raw = 'access_token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl org=org-AbC123xyz789';

    const redacted = redactProbeText(raw, { home: '/Users/someone' });

    expect(redacted).toBe('access_token=<secret> org=<id>');
  });
});
