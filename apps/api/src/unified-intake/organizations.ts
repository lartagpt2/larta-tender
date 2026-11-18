import { emailTextPages } from './email-native';
import { BadRequestException } from '@nestjs/common';
import { IncomingOfferFile } from '../offer-files';
import { nativePages } from './classification';
import { countryKey, identifier, Identifier } from './organization-identity';
export const organizationSchema = 'intake-organizations-v1';
export const organizationPolicy = 'native-labeled-organizations-v1';
export const roles = ['supplier', 'buyer', 'manufacturer', 'carrier', 'other', 'unknown'] as const;
export type OrganizationRole = (typeof roles)[number];
export interface TextPage {
  page: number;
  text: string;
}
export interface FieldEvidence {
  page: number;
  excerpt: string;
  sheet?: string;
  cell_range?: string;
}
export interface Organization {
  local_key: string;
  role: OrganizationRole;
  name: string | null;
  legal_name: string | null;
  country: string | null;
  identifiers: Identifier[];
  address: string | null;
  emails: string[];
  contacts: string[];
  evidence_by_field: Record<string, FieldEvidence>;
  extraction_method: 'native_labeled' | 'localai' | 'test_mock';
  review_state: 'proposed' | 'needs_review';
  warnings: string[];
}
export interface OrganizationRequest {
  tenderId: string;
  originalId: string;
  receiptId: string;
  contractVersion: typeof organizationSchema;
  pages: TextPage[];
  structure: { mime: string };
}
export interface OrganizationsPort {
  readonly method: Organization['extraction_method'];
  extract(input: OrganizationRequest): Promise<Organization[]>;
}
export class DisabledLocalAIAdapter implements OrganizationsPort {
  readonly method = 'localai' as const;
  async extract(_input: OrganizationRequest): Promise<Organization[]> {
    void _input;
    return [];
  }
}
/** Only explicitly injected isolated tests may select this port. No environment flag enables it. */
export class TestOrganizationsMock implements OrganizationsPort {
  readonly method = 'test_mock' as const;
  constructor(private readonly callback: (input: OrganizationRequest) => Organization[]) {}
  async extract(input: OrganizationRequest) {
    return this.callback(input).map((o) => ({ ...o, extraction_method: 'test_mock' as const }));
  }
}
const marker =
  /(?:^|[;\n|])\s*(?:[A-Z]+\d+:\s*)?(Поставщик|Продавец|Покупатель|Изготовитель|Производитель|Грузоперевозчик|Грузоотправитель|Организация|Supplier|Seller|Buyer|Manufacturer|Carrier|Consignor|Organization|Seller\s*\/\s*Buyer)\s*:\s*/giu;
function roleOf(label: string): OrganizationRole {
  if (label.includes('/') || /^(Organization|Организация)$/iu.test(label)) return 'unknown';
  if (/^(поставщик|продавец|seller|supplier)$/iu.test(label)) return 'supplier';
  if (/^(покупатель|buyer)$/iu.test(label)) return 'buyer';
  if (/^(изготовитель|производитель|manufacturer)$/iu.test(label)) return 'manufacturer';
  if (/^(грузоперевозчик|carrier)$/iu.test(label)) return 'carrier';
  return 'other';
}
export class NativeOrganizationsExtractor implements OrganizationsPort {
  readonly method = 'native_labeled' as const;
  async extract(input: OrganizationRequest): Promise<Organization[]> {
    const output: Organization[] = [];
    for (const page of input.pages) {
      const hits = [...page.text.matchAll(marker)];
      for (const [index, hit] of hits.entries()) {
        if (output.length >= 50) throw new BadRequestException('organization_limit');
        const start = hit.index!,
          body = page.text.slice(start, hits[index + 1]?.index ?? page.text.length);
        const evidence: Record<string, FieldEvidence> = {};
        const proof = (field: string, excerpt: string) => {
          evidence[field] = {
            page: page.page,
            excerpt: excerpt.trim().slice(0, 1800),
            ...(input.structure.mime.includes('spreadsheet')
              ? { sheet: 'sheet' + page.page, cell_range: body.match(/[A-Z]+\d+/)?.[0] }
              : {}),
          };
        };
        const rawName = body
          .slice(hit[0].length)
          .split(/[;\n|]/)[0]
          .trim();
        // A field label after an empty role marker is not an organization name.
        const name =
          rawName && !/^(?:ИНН|INN|Country|Страна|Legal Name|Наименование)\s*:/iu.test(rawName)
            ? rawName
            : null;
        proof('role', hit[0]);
        if (name) proof('name', hit[0] + name);
        const values = (labels: string) => [
          ...body.matchAll(
            new RegExp('(?:^|[;\\n|])\\s*(?:[A-Z]+\\d+:\\s*)?(' + labels + ')\\s*:\\s*([^;\\n|]+)', 'giu'),
          ),
        ];
        const one = (field: string, labels: string) => {
          const found = values(labels);
          if (found.length === 1) {
            if (!found[0][2].trim()) return null;
            proof(field, found[0][0]);
            return found[0][2].trim();
          }
          return null;
        };
        const legal_name = one('legal_name', 'Legal Name|Юридическое наименование|Наименование');
        const country = one('country', 'Country|Страна');
        const address = one('address', 'Address|Адрес');
        const ids: Identifier[] = [];
        for (const m of values(
          'ИНН|INN|КПП|ОГРН|Company Registration Number|Registration Number|VAT Number',
        )) {
          const label = m[1].toUpperCase();
          const scheme = ['ИНН', 'INN'].includes(label)
            ? 'RU_INN'
            : label === 'КПП'
              ? 'RU_KPP'
              : label === 'ОГРН'
                ? 'RU_OGRN'
                : label === 'COMPANY REGISTRATION NUMBER' && countryKey(country) === 'GB'
                  ? 'GB_CRN'
                  : 'UNKNOWN_' + label.replaceAll(' ', '_');
          proof('identifiers.' + ids.length + '.raw_value', m[0]);
          ids.push(identifier(countryKey(country), scheme, m[2].trim()));
        }
        const strings = (field: string, labels: string) =>
          values(labels).map((m, i) => {
            proof(field + '.' + i, m[0]);
            return m[2].trim();
          });
        const emails = strings('emails', 'Email|E-mail|Электронная почта');
        const contacts = strings('contacts', 'Phone|Телефон|Contact|Контакт');
        const role = roleOf(hit[1]),
          warnings: string[] = [];
        if (role === 'unknown') warnings.push('ambiguous_role');
        if (!name && !legal_name) warnings.push('missing_name');
        const supported = ids.filter((i) => i.valid);
        if (!supported.length) warnings.push('no_strong_identifier');
        if (ids.some((i) => !i.valid)) warnings.push('invalid_or_unsupported_identifier');
        const groups = new Map<string, Set<string>>();
        for (const i of supported) {
          const set = groups.get(i.scheme) ?? new Set<string>();
          set.add(i.normalized_value!);
          groups.set(i.scheme, set);
        }
        if ([...groups.values()].some((s) => s.size > 1)) warnings.push('conflicting_identifiers');
        output.push({
          local_key: 'page' + page.page + ':organization' + index,
          role,
          name,
          legal_name,
          country,
          identifiers: ids,
          address,
          emails,
          contacts,
          evidence_by_field: evidence,
          extraction_method: 'native_labeled',
          review_state: warnings.length ? 'needs_review' : 'proposed',
          warnings,
        });
      }
    }
    return output;
  }
}
export async function organizationText(file: IncomingOfferFile): Promise<TextPage[]> {
  if (file.mime !== 'message/rfc822') {
    try {
      return await nativePages(file);
    } catch {
      return [];
    }
  }
  return emailTextPages(file);
}

export function validateOrganizations(orgs: Organization[], pages: TextPage[]) {
  if (orgs.length > 50) throw new BadRequestException('organization_limit');
  for (const o of orgs) {
    if (!roles.includes(o.role) || !['native_labeled', 'test_mock', 'localai'].includes(o.extraction_method))
      throw new BadRequestException('invalid_organization_contract');
    const fields: Record<string, string> = { role: o.role };
    for (const f of ['name', 'legal_name', 'country', 'address'] as const) if (o[f]) fields[f] = o[f]!;
    o.identifiers.forEach((v, i) => {
      fields['identifiers.' + i + '.raw_value'] = v.raw_value;
    });
    o.emails.forEach((v, i) => {
      fields['emails.' + i] = v;
    });
    o.contacts.forEach((v, i) => {
      fields['contacts.' + i] = v;
    });
    for (const [field, value] of Object.entries(fields)) {
      const e = o.evidence_by_field[field],
        page = pages.find((p) => p.page === e?.page);
      if (
        !e ||
        !e.excerpt ||
        e.excerpt.length > 1800 ||
        !page?.text.includes(e.excerpt) ||
        (field !== 'role' && !e.excerpt.includes(value))
      )
        throw new BadRequestException('missing_or_unrelated_organization_evidence');
      if (field === 'role') {
        const roleHit = [...e.excerpt.matchAll(marker)][0];
        if (!roleHit || roleOf(roleHit[1]) !== o.role)
          throw new BadRequestException('role_evidence_mismatch');
      }
    }
  }
}
