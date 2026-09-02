// Shared REST body-field validation used across route modules (work-routes.ts,
// collaborator-routes.ts) so a bounded non-empty-string check isn't
// redefined per module with a slightly different signature.
export function nonEmptyString(value: unknown, maxLength = Infinity): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}
