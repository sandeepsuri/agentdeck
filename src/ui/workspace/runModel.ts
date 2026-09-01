export function formatRunLabel(value: string): string {
  const words = value.replaceAll('-', ' ').replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
