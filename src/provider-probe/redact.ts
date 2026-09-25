// Scrubs account-identifying values out of provider CLI output before a
// probe report leaves the process (ticket E00: keep probe secrets and
// account data out of the repository and issue comments).

export interface RedactOptions {
  /** The owner's home directory; replaced with `~` so reports carry no user name. */
  home: string;
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/g;
const API_KEY = /\bsk-[A-Za-z0-9_-]{8,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const ORG_ID = /\borg-[A-Za-z0-9]{6,}/g;
const CF_RAY = /(cf-ray:\s*)[0-9a-f]+(-[A-Z]{3})?/gi;
const REQUEST_ID = /\breq_[A-Za-z0-9]+/g;

export function redactProbeText(text: string, options: RedactOptions): string {
  const home = options.home.replace(/\/+$/, '');
  const withoutHome = home.length > 1 ? text.split(home).join('~') : text;
  return withoutHome
    .replace(BEARER, '$1<secret>')
    .replace(JWT, '<secret>')
    .replace(API_KEY, '<secret>')
    .replace(EMAIL, '<email>')
    .replace(UUID, '<id>')
    .replace(ORG_ID, '<id>')
    .replace(CF_RAY, '$1<ray>')
    .replace(REQUEST_ID, '<request>');
}
