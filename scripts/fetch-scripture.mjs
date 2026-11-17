// Downloads the chapters used on the Bible pages, verbatim, from getbible.net.
// English: King James Version. Spanish: Reina-Valera 1909. Both are public domain.
// Run with: npm run fetch-scripture
import { writeFile } from 'node:fs/promises';

const PASSAGES = [
  { id: 'psalm34', book: 19, chapter: 34, verses: [18] },
  { id: 'proverbs3', book: 20, chapter: 3, verses: [5, 6] },
  { id: 'isaiah41', book: 23, chapter: 41, verses: [10] },
  { id: 'jeremiah29', book: 24, chapter: 29, verses: [11] },
  { id: 'matthew11', book: 40, chapter: 11, verses: [28] },
  { id: 'philippians4', book: 50, chapter: 4, verses: [6, 7] },
];
const TRANSLATIONS = { en: 'kjv', es: 'valera' };

const clean = (s) => s.replace(/\s+/g, ' ').trim();

const out = [];
for (const p of PASSAGES) {
  const entry = { id: p.id, chapter: p.chapter, verses: p.verses, book: {}, text: {} };
  for (const [lang, tr] of Object.entries(TRANSLATIONS)) {
    const url = `https://api.getbible.net/v2/${tr}/${p.book}/${p.chapter}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> ${res.status}`);
    const json = await res.json();
    entry.book[lang] = json.book_name;
    entry.text[lang] = json.verses.map((v) => ({ n: v.verse, t: clean(v.text) }));
  }
  out.push(entry);
}
await writeFile(new URL('../src/data/scripture.json', import.meta.url), JSON.stringify(out, null, 1));
for (const e of out) for (const lang of ['en', 'es'])
  console.log(`${e.book[lang]} ${e.chapter}:${e.verses.join('-')} | ` + e.verses.map((n) => e.text[lang].find((v) => v.n === n).t).join(' '));
