import { describe, expect, it } from 'vitest';
import { buildNameIndex, editDistance, matchAnswer, nameCollisions, normaliseName, typoAllowance } from '../src/srs/answerMatch';
import { quizData } from './fixtures';

const data = quizData();
const scope = data.scopes.sovereign;
const index = buildNameIndex(data.names, scope);
const judge = (target: string, text: string, tol: 'off' | 'normal' | 'lenient' = 'normal') => matchAnswer(index, target, text, tol);

describe('normaliseName', () => {
  it('ignores case, diacritics, punctuation, spacing, leading "the", & and St.', () => {
    expect(normaliseName("Côte d'Ivoire")).toBe(normaliseName('cote divoire'));
    expect(normaliseName('São Tomé & Príncipe')).toBe(normaliseName('Sao Tome and Principe'));
    expect(normaliseName('The Gambia')).toBe(normaliseName('gambia'));
    expect(normaliseName('St. Lucia')).toBe(normaliseName('Saint Lucia'));
    expect(normaliseName('St Kitts & Nevis')).toBe(normaliseName('saint kitts and nevis'));
    expect(normaliseName('  Guinea-Bissau ')).toBe(normaliseName('guinea bissau'));
    expect(normaliseName('TÜRKIYE')).toBe('turkiye');
  });
});

describe('aliases', () => {
  it('no normalised name belongs to two countries', () => {
    expect(nameCollisions(index)).toEqual([]);
  });

  it('every accepted name resolves exactly to its own country', () => {
    for (const id of scope) {
      for (const name of data.names[id]!.accepted) expect(judge(id, name), `${id}: ${name}`).toEqual({ kind: 'exact' });
    }
  });

  it.each([
    ['CZE', 'Czech Republic'],
    ['CIV', 'Ivory Coast'],
    ['SWZ', 'Swaziland'],
    ['MMR', 'Burma'],
    ['TUR', 'Turkey'],
    ['TLS', 'East Timor'],
    ['CPV', 'Cape Verde'],
    ['GBR', 'UK'],
    ['GBR', 'great britain'],
    ['USA', 'America'],
    ['USA', 'U.S.'],
    ['COD', 'DRC'],
    ['COD', 'Congo-Kinshasa'],
    ['COG', 'Congo'],
    ['COG', 'congo brazzaville'],
    ['MKD', 'Macedonia'],
    ['VAT', 'Holy See'],
    ['FSM', 'Federated States of Micronesia'],
    ['NLD', 'Holland'],
  ])('%s accepts "%s"', (id, text) => {
    expect(judge(id, text)).toEqual({ kind: 'exact' });
  });
});

describe('typo tolerance', () => {
  it('uses the specified allowances', () => {
    expect([4, 5, 9, 10].map((n) => typoAllowance(n, 'normal'))).toEqual([0, 1, 1, 2]);
    expect([3, 4, 7, 8].map((n) => typoAllowance(n, 'lenient'))).toEqual([0, 1, 1, 2]);
    expect(typoAllowance(20, 'off')).toBe(0);
  });

  it('counts a transposition as one edit', () => {
    expect(editDistance('australia', 'austrlaia')).toBe(1);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });

  it('accepts minor slips as typos', () => {
    expect(judge('FRA', 'Frnace')).toEqual({ kind: 'typo', distance: 1 });
    expect(judge('KAZ', 'Kazakstan')).toEqual({ kind: 'exact' });
    expect(judge('KAZ', 'Kazahkstan')).toMatchObject({ kind: 'typo' });
    expect(judge('MAR', 'Moroco')).toMatchObject({ kind: 'typo' });
    expect(judge('DEU', 'Germny')).toMatchObject({ kind: 'typo' });
    expect(judge('PHL', 'Philipines')).toMatchObject({ kind: 'typo' });
    expect(judge('LIE', 'Lichtenstein')).toMatchObject({ kind: 'typo' });
  });

  it('allows no slips under 5 letters (normal) and none when off', () => {
    expect(judge('PER', 'Peur')).toMatchObject({ kind: 'wrong' });
    expect(judge('FRA', 'Frnace', 'off')).toMatchObject({ kind: 'wrong' });
  });

  it('allows two slips from 10 letters', () => {
    expect(judge('AFG', 'Afganistann')).toMatchObject({ kind: 'typo', distance: 2 });
    expect(judge('AFG', 'Afgnstann')).toMatchObject({ kind: 'wrong' });
  });

  it('empty answers are flagged', () => {
    expect(judge('FRA', '   ')).toEqual({ kind: 'empty' });
  });
});

describe('ambiguity guard', () => {
  const pairs: [string, string, string, string][] = [
    ['NER', 'Niger', 'NGA', 'Nigeria'],
    ['GIN', 'Guinea', 'GNB', 'Guinea-Bissau'],
    ['GIN', 'Guinea', 'GNQ', 'Equatorial Guinea'],
    ['GNB', 'Guinea-Bissau', 'GNQ', 'Equatorial Guinea'],
    ['DMA', 'Dominica', 'DOM', 'Dominican Republic'],
    ['AUT', 'Austria', 'AUS', 'Australia'],
    ['IRN', 'Iran', 'IRQ', 'Iraq'],
    ['MLI', 'Mali', 'MWI', 'Malawi'],
    ['SVK', 'Slovakia', 'SVN', 'Slovenia'],
    ['SDN', 'Sudan', 'SDS', 'South Sudan'],
    ['COG', 'Congo', 'COD', 'DR Congo'],
  ];

  it.each(pairs)('%s (%s) vs %s (%s): each name is wrong for the other', (a, aName, b, bName) => {
    for (const tol of ['off', 'normal', 'lenient'] as const) {
      expect(judge(a, bName, tol)).toEqual({ kind: 'wrong', other: b });
      expect(judge(b, aName, tol)).toEqual({ kind: 'wrong', other: a });
      expect(judge(a, aName, tol)).toEqual({ kind: 'exact' });
    }
  });

  it('rejects near-misses that are within tolerance of another country', () => {
    expect(judge('NER', 'Nigera')).toMatchObject({ kind: 'wrong' }); // 1 from Nigeria and 1 from Niger
    expect(judge('SVK', 'Slovekia')).toMatchObject({ kind: 'wrong' }); // 1 from both Slovakia and Slovenia
    expect(judge('SVK', 'Slovakai')).toMatchObject({ kind: 'typo' }); // 1 from Slovakia, 3 from Slovenia
    expect(judge('AUS', 'Austrlaia')).toMatchObject({ kind: 'typo' });
    expect(judge('AUT', 'Austrai')).toMatchObject({ kind: 'typo' }); // 1 from Austria, 2 from Australia
    expect(judge('DMA', 'Dominican Rep')).toMatchObject({ kind: 'wrong', other: 'DOM' });
    // By the stated rule this is a 1-letter slip from Dominica and not near any other name.
    expect(judge('DMA', 'Dominican')).toMatchObject({ kind: 'typo' });
  });

  it('"Nigr" is accepted for Niger only when tolerance reaches 4 letters, and never for Nigeria', () => {
    expect(judge('NER', 'Nigr', 'normal')).toMatchObject({ kind: 'wrong' });
    expect(judge('NER', 'Nigr', 'lenient')).toEqual({ kind: 'typo', distance: 1 });
    expect(judge('NGA', 'Nigr', 'lenient')).toMatchObject({ kind: 'wrong', other: 'NER' });
  });
});
