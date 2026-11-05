import { describe, expect, it } from 'vitest';
import { screens } from './navigation';
describe('workspace navigation', () => {
  it('provides seven distinct screens and the creation route', () => {
    expect(screens.map((screen) => screen.code)).toEqual(['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07']);
    expect(new Set(screens.map((screen) => screen.path)).size).toBe(7);
    expect(screens[0].next).toBe('/tenders/new');
  });
});
