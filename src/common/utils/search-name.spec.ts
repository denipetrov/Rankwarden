import { describe, expect, it } from 'vitest';

import { searchNameOf } from './search-name.js';

describe('searchNameOf', () => {
  it('folds case and accents so every spelling of a name meets', () => {
    expect(searchNameOf('Bìbà')).toBe('biba');
    expect(searchNameOf('Biba')).toBe('biba');
    expect(searchNameOf('BIBA')).toBe('biba');
  });

  it('folds the accented names the ladders are full of', () => {
    expect(searchNameOf('Zëph')).toBe('zeph');
    expect(searchNameOf('Goküü')).toBe('gokuu');
    expect(searchNameOf('Ñáçhö')).toBe('nacho');
    expect(searchNameOf('Ýrsä')).toBe('yrsa');
  });

  it('treats a decomposed name exactly like a precomposed one', () => {
    // `e` followed by a combining diaeresis, as some clients send it.
    expect(searchNameOf('Zëph')).toBe(searchNameOf('Zëph'));
  });

  it('spells out letters that have no accent to strip', () => {
    expect(searchNameOf('Ærøn')).toBe('aeron');
    expect(searchNameOf('Großmann')).toBe('grossmann');
    expect(searchNameOf('Łukasz')).toBe('lukasz');
    expect(searchNameOf('Þór')).toBe('thor');
    expect(searchNameOf('Œdipe')).toBe('oedipe');
  });

  it('lowers a dotted capital I to a plain i', () => {
    expect(searchNameOf('İlkay')).toBe('ilkay');
  });

  it('maps full-width letters to plain ones', () => {
    expect(searchNameOf('Ｂｉｂａ')).toBe('biba');
  });

  it('keeps Korean and Chinese names whole and readable', () => {
    expect(searchNameOf('하늘이')).toBe('하늘이');
    expect(searchNameOf('天空')).toBe('天空');
  });

  it('keeps a folded prefix a prefix of the folded name', () => {
    // What makes the anchored index query correct.
    for (const name of ['Bìbà', 'Ærøn', '하늘이', 'Großmann']) {
      for (let length = 1; length <= name.length; length++) {
        expect(searchNameOf(name).startsWith(searchNameOf(name.slice(0, length)))).toBe(true);
      }
    }
  });

  it('leaves guild names with spaces and punctuation searchable', () => {
    expect(searchNameOf('Échø Of Ásh')).toBe('echo of ash');
    expect(searchNameOf("Liquid'")).toBe("liquid'");
  });
});
