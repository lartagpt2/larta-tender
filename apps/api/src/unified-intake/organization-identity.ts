export const normalizationVersion = 'organization-identity-v1';
export interface Identifier {
  scheme: string;
  raw_value: string;
  normalized_value: string | null;
  valid: boolean;
  validator_version: string;
}
export function countryKey(raw: string | null): string | null {
  if (!raw) return null;
  const key = raw.trim().toUpperCase();
  return (
    (
      {
        RU: 'RU',
        РОССИЯ: 'RU',
        'РОССИЙСКАЯ ФЕДЕРАЦИЯ': 'RU',
        GB: 'GB',
        UK: 'GB',
        'UNITED KINGDOM': 'GB',
        ВЕЛИКОБРИТАНИЯ: 'GB',
      } as Record<string, string>
    )[key] ?? (/^[A-Z]{2}$/.test(key) ? key : null)
  );
}
export function identifier(country: string | null, scheme: string, raw: string): Identifier {
  const value = raw
    .trim()
    .toUpperCase()
    .replace(/[ \t-]/g, '');
  let valid = false;
  if (country === 'RU' && scheme === 'RU_INN' && /^(?:\d{10}|\d{12})$/.test(value) && !/^0+$/.test(value)) {
    const n = [...value].map(Number);
    const check = (weights: number[]) => (weights.reduce((s, w, i) => s + w * n[i], 0) % 11) % 10;
    valid =
      n.length === 10
        ? check([2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[9]
        : check([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[10] &&
          check([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === n[11];
  }
  // Deliberately bounded supported UK subset; format validation is not registry verification.
  if (country === 'GB' && scheme === 'GB_CRN')
    valid = /^(?:\d{8}|(?:SC|NI|OC|SO|NC|FC)\d{6})$/.test(value) && value !== '00000000';
  return {
    scheme,
    raw_value: raw,
    normalized_value: valid ? value : null,
    valid,
    validator_version: normalizationVersion,
  };
}
export function weakName(name: string | null) {
  return (
    name
      ?.normalize('NFKC')
      .toLowerCase()
      .replace(/[«»"'.,()]/g, '')
      .replace(/\s+/g, ' ')
      .trim() ?? ''
  );
}
