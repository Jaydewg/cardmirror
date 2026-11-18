import { describe, expect, it } from 'vitest';
import { expandYear, findDate, hostOf, parseCite, parseShortCite, trimUrl } from '../src/parse-cite.js';
import { GOOD, TODAY } from './fixtures.js';

describe('parseShortCite', () => {
  it('reads surnames, et al. and every date form', () => {
    expect(parseShortCite('Smith 24', TODAY)).toMatchObject({ surnames: ['Smith'], year: 2024, dateText: '24' });
    expect(parseShortCite('Weiss & Bresnahan 3/26', TODAY)).toMatchObject({
      surnames: ['Weiss', 'Bresnahan'],
      month: 3,
      day: 26,
      year: null,
    });
    expect(parseShortCite('Norrlöf et al. 24', TODAY)).toMatchObject({ surnames: ['Norrlöf'], etAl: true, year: 2024 });
    expect(parseShortCite('Keynes 1936', TODAY)).toMatchObject({ year: 1936 });
    expect(parseShortCite('Parag & Darby 9', TODAY)).toMatchObject({ year: 2009 });
    expect(parseShortCite("Smith '19", TODAY)).toMatchObject({ year: 2019 });
    expect(parseShortCite('Smith n.d.', TODAY)).toMatchObject({ noDate: true, dateText: null });
    expect(parseShortCite('Smith', TODAY)).toMatchObject({ surnames: ['Smith'], dateText: null, noDate: false });
    expect(parseShortCite('', TODAY)).toBeNull();
  });

  it('reads a date joined to the name (no space, or separate cite runs)', () => {
    expect(parseShortCite('Toby20', TODAY)).toMatchObject({ surnames: ['Toby'], year: 2020, dateText: '20' });
    expect(parseShortCite('Smith2020', TODAY)).toMatchObject({ surnames: ['Smith'], year: 2020 });
    expect(parseShortCite('Smith,24', TODAY)).toMatchObject({ surnames: ['Smith'], year: 2024 });
    expect(parseShortCite('Smith24a', TODAY)).toMatchObject({ surnames: ['Smith'], year: 2024 });
    expect(parseShortCite('Smith & Jones3/26', TODAY)).toMatchObject({ surnames: ['Smith', 'Jones'], month: 3, day: 26 });
  });

  it('reads a 2-digit year as the latest past year', () => {
    expect(expandYear('26', TODAY)).toBe(2026);
    expect(expandYear('27', TODAY)).toBe(1927);
    expect(expandYear('99', TODAY)).toBe(1999);
  });
});

describe('findDate', () => {
  it('finds numeric, named-month and bare-year dates, earliest first', () => {
    expect(findDate('Reason, 9/25/23, https://x', TODAY)).toMatchObject({ year: 2023, month: 9, day: 25 });
    expect(findDate('published March 7, 2024 and updated 2025', TODAY)).toMatchObject({ year: 2024, month: 3, day: 7 });
    expect(findDate('7 Mar 2024', TODAY)).toMatchObject({ year: 2024, month: 3, day: 7 });
    expect(findDate('2021-11-04T10:00', TODAY)).toMatchObject({ year: 2021, month: 11, day: 4 });
    expect(findDate('Palgrave Macmillan, 2018, pp. 3', TODAY)).toMatchObject({ year: 2018, month: null });
    // An impossible m/d falls back to the year alone.
    expect(findDate('13/45/2020', TODAY)).toMatchObject({ year: 2020, month: null });
    expect(findDate('no dates here', TODAY)).toBeNull();
  });
});

describe('parseCite on CardMirror’s reference cites', () => {
  it.each(GOOD)('$short', ({ short, full }) => {
    const p = parseCite(short, [full], TODAY);
    expect(p.short?.text).toBe(short);
    expect(p.authorText).toBeTruthy();
    expect(p.qualsText).toBeTruthy();
    expect(p.qualsText).not.toMatch(/^"/);
    expect(p.titleText).toBeTruthy();
    expect(p.date).not.toBeNull();
    // The quals never swallow the title.
    expect(p.qualsText!.includes(p.titleText!)).toBe(false);
  });

  it('splits Stavins into name / quals / title / publication / date / book', () => {
    const g = GOOD.find((x) => x.short === 'Stavins 18')!;
    const p = parseCite(g.short, [g.full], TODAY);
    expect(p.authorText).toBe('Robert N. Stavins');
    expect(p.qualsText).toMatch(/^A\.J\. Meyer Professor/);
    expect(p.titleText).toBe('Environmental Economics');
    expect(p.publicationText).toBe('The New Palgrave Dictionary of Economics');
    expect(p.date?.year).toBe(2018);
    expect(p.bookLike).toBe(true);
    expect(p.urls).toEqual([]);
  });

  it('handles the name AFTER the short cite, brackets, and a DOI', () => {
    const p = parseCite(
      'Smith 21',
      ['Smith 21 [John Smith, Professor of Economics at Yale University, “Trade and Peace,” Journal of Peace Research, 3/4/2021, doi:10.1177/00223433211000001]'],
      TODAY,
    );
    expect(p.authorText).toBe('John Smith');
    expect(p.qualsText).toBe('Professor of Economics at Yale University');
    expect(p.titleText).toBe('Trade and Peace');
    expect(p.doi).toBe('10.1177/00223433211000001');
    expect(p.date).toMatchObject({ year: 2021, month: 3, day: 4 });
  });

  it('treats an “accessed” date as the only date only when there is no other', () => {
    expect(parseCite('Doe 24', ['Jane Doe 24, Reporter at Vox, "X Y Z," Vox, accessed 5/1/2024, https://vox.com/a'], TODAY)).toMatchObject({
      accessedOnly: true,
    });
    const both = parseCite('Doe 24', ['Jane Doe 24, Reporter at Vox, "X Y Z," Vox, 3/2/2024, accessed 5/1/2024, https://vox.com/a'], TODAY);
    expect(both.accessedOnly).toBe(false);
    expect(both.date).toMatchObject({ month: 3, day: 2 });
  });

  it('reads a cite with no cite-styled run from its start', () => {
    const p = parseCite('', ['Smith 24, Professor at MIT, "Title here," Journal, 2024'], TODAY);
    expect(p.short?.surnames).toEqual(['Smith']);
    expect(p.qualsText).toBe('Professor at MIT');
  });

  it('collects URLs without trailing punctuation, joining cite paragraphs', () => {
    const p = parseCite('Doe 24', ['Jane Doe 24, Reporter at Vox,', '"Headline here," Vox, 2024, https://www.vox.com/a/b).'], TODAY);
    expect(p.urls).toEqual(['https://www.vox.com/a/b']);
    expect(hostOf(p.urls[0]!)).toBe('vox.com');
  });

  it('reads a cite whose name and date are highlighted in place', () => {
    // "Toby **Smith**, …, March 7, **2020**" reaches the plugin as "Smith2020".
    const p = parseCite(
      'Smith2020',
      ['Toby Smith, Professor of Law at Yale University, "A Long Enough Title," Yale Law Journal, March 7, 2020, https://yalelawjournal.org/a'],
      TODAY,
    );
    expect(p.short).toMatchObject({ surnames: ['Smith'], year: 2020 });
    expect(p.authorText).toBe('Toby Smith');
    expect(p.qualsText).toBe('Professor of Law at Yale University');
    expect(p.titleText).toBe('A Long Enough Title');
    expect(p.publicationText).toBe('Yale Law Journal');
    expect(p.date).toMatchObject({ year: 2020, month: 3, day: 7 });
  });

  it('reads an in-place cite whose name is mid-cite', () => {
    const p = parseCite(
      'Smith2020',
      ['Professor Toby Smith of Yale University, "A Long Enough Title," Yale Law Journal, 2020, https://yalelawjournal.org/a'],
      TODAY,
    );
    expect(p.qualsText).toBe('Professor Toby Smith of Yale University');
    expect(p.titleText).toBe('A Long Enough Title');
    expect(p.date?.year).toBe(2020);
  });

  it('still splits a full name written before the date', () => {
    const p = parseCite('Doe 24', ['Jane Q. Doe 24, Reporter at Vox, "Headline here," Vox, 2024'], TODAY);
    expect(p.authorText).toBe('Jane Q. Doe');
    expect(p.qualsText).toBe('Reporter at Vox');
  });

  it('ends a URL at a bracket it did not open, or a backslash', () => {
    expect(trimUrl('https://x.com/a/b]\\Toby')).toBe('https://x.com/a/b');
    expect(trimUrl('https://x.com/a/b]')).toBe('https://x.com/a/b');
    expect(trimUrl('https://x.com/a/b\\Toby')).toBe('https://x.com/a/b');
    expect(trimUrl('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(trimUrl('https://x.com/q?a[0]=1]')).toBe('https://x.com/q?a[0]=1');
    expect(trimUrl('https://x.com/a).')).toBe('https://x.com/a');
    const p = parseCite('Doe 24', ['Doe 24 [Jane Doe, Reporter at Vox, "Headline here," Vox, 2024, https://www.vox.com/a/b]\\Toby'], TODAY);
    expect(p.urls).toEqual(['https://www.vox.com/a/b']);
  });
});
