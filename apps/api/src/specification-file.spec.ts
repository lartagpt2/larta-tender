import { specificationType } from './specification-file';
it('accepts PDF signatures and valid UTF-8 text', () => {
  expect(specificationType('a.pdf', 'application/pdf', Buffer.from('%PDF-1.7 synthetic'))).toBe(
    'application/pdf',
  );
  expect(specificationType('a.txt', 'text/plain', Buffer.from('Синтетическое ТЗ'))).toBe('text/plain');
});
it.each([
  ['a.pdf', 'application/pdf', Buffer.from('not PDF')],
  ['../a.txt', 'text/plain', Buffer.from('text')],
  ['a.exe', 'text/plain', Buffer.from('text')],
  ['a.txt', 'text/plain', Buffer.from([0xff])],
  ['a.txt', 'text/plain', Buffer.from([0])],
  ['a.txt', 'text/plain', Buffer.alloc(0)],
])('rejects unsafe or mismatching specification %s', (name, mime, bytes) => {
  expect(() => specificationType(name, mime, bytes)).toThrow();
});
