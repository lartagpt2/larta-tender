// Suggestion-only comparison. Never return a rewritten source value or select a target automatically.
const visual: Record<string, string> = {
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  Х: 'X',
  У: 'Y',
};
const latin = new Set(Object.values(visual));
const skeleton = (s: string) =>
  Array.from(s.normalize('NFC').toUpperCase())
    .map((c) => visual[c] ?? c)
    .join('');
const tokens = (s: string) => [
  ...new Set(
    (s.match(/[A-Za-zА-Яа-яЁё0-9]+(?:[-_./][A-Za-zА-Яа-яЁё0-9]+)*/g) ?? [])
      .filter((t) => /[0-9]/.test(t) && /[A-Za-zА-Яа-яЁё]/.test(t))
      .slice(0, 30),
  ),
];
export interface ArticleCandidate {
  id: string;
  name: string;
  sourceArticle: string;
  targetArticle: string;
  reason: 'visual_homoglyph';
}
export function suggestArticles(
  description: string | null,
  sku: string | null,
  required: readonly { id: string; name: string }[],
) {
  const originals = tokens([sku ?? '', description ?? ''].join(' '));
  const ambiguous = originals
    .map((original) => ({
      original,
      characters: Array.from(original).flatMap((c, index) => {
        const upper = c.toUpperCase();
        return visual[upper] || latin.has(upper)
          ? [
              {
                index,
                character: c,
                codepoint: 'U+' + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
              },
            ]
          : [];
      }),
      mixedScripts: /[A-Za-z]/.test(original) && /[А-Яа-яЁё]/.test(original),
    }))
    .filter((t) => t.characters.length);
  const candidates: ArticleCandidate[] = [];
  for (const r of required.slice(0, 100))
    for (const sourceArticle of originals)
      for (const targetArticle of tokens(r.name)) {
        if (sourceArticle === targetArticle || skeleton(sourceArticle) !== skeleton(targetArticle)) continue;
        if (
          !candidates.some(
            (c) => c.id === r.id && c.sourceArticle === sourceArticle && c.targetArticle === targetArticle,
          )
        )
          candidates.push({
            id: r.id,
            name: r.name,
            sourceArticle,
            targetArticle,
            reason: 'visual_homoglyph',
          });
      }
  return { originals, ambiguous, candidates: candidates.slice(0, 20), truncated: candidates.length > 20 };
}
