/**
 * @file speechFormat.test.ts
 * @description Covers the "make it sound right when spoken" helpers.
 *
 * These are the rules that only become obvious once a person listens to the output, and
 * they are exactly the sort of thing that gets quietly refactored away by someone who
 * has only ever read the strings. Pinning them down in tests is the cheapest way to keep
 * them.
 */

import { describe, expect, it } from 'vitest';
import {
    containsWord,
    isAre,
    nonZeroParts,
    normalizeTranscript,
    plural,
    pluralWord,
    speakDistanceKm,
    speakId,
    speakIp,
    speakList,
    speakMinutes,
    speakPercent,
} from '../services/speechFormat';

describe('speakIp — dotted quads must be spoken, not read as a decimal', () => {
    it('replaces every separator with the spoken word "dot"', () => {
        expect(speakIp('203.0.113.5')).toBe('203 dot 0 dot 113 dot 5');
    });

    it('handles the other documentation range and RFC 1918 addresses identically', () => {
        expect(speakIp('198.51.100.70')).toBe('198 dot 51 dot 100 dot 70');
        expect(speakIp('192.168.40.15')).toBe('192 dot 168 dot 40 dot 15');
    });

    it('leaves an address with no dots untouched', () => {
        expect(speakIp('localhost')).toBe('localhost');
    });
});

describe('speakId — mixed letter/digit asset tags', () => {
    it('spaces out an uppercase run so it is not read as a word', () => {
        // Without this, engines pronounce "HC-118" as "hick one hundred eighteen".
        expect(speakId('HC-118')).toBe('H C 118');
    });

    it('collapses the hyphen without leaving double spaces', () => {
        expect(speakId('HC-101')).toBe('H C 101');
    });
});

describe('pluralisation — spoken output notices "1 vans" far more than text does', () => {
    it('uses the singular for exactly one', () => {
        expect(plural(1, 'van')).toBe('1 van');
        expect(pluralWord(1, 'van')).toBe('van');
    });

    it('uses the plural for zero and for many', () => {
        expect(plural(0, 'van')).toBe('0 vans');
        expect(plural(7, 'van')).toBe('7 vans');
    });

    it('accepts an explicit irregular plural', () => {
        expect(plural(2, 'analysis', 'analyses')).toBe('2 analyses');
    });

    it('agrees the verb with the count', () => {
        expect(isAre(1)).toBe('is');
        expect(isAre(0)).toBe('are');
        expect(isAre(4)).toBe('are');
    });
});

describe('speakList — a spoken list needs an audible end', () => {
    it('returns an empty string for nothing', () => {
        expect(speakList([])).toBe('');
    });

    it('returns a single item unchanged', () => {
        expect(speakList(['Kestrel'])).toBe('Kestrel');
    });

    it('joins two items with the conjunction and no comma', () => {
        expect(speakList(['Kestrel', 'Heron'])).toBe('Kestrel and Heron');
    });

    it('joins three or more with commas plus a final conjunction', () => {
        expect(speakList(['Kestrel', 'Heron', 'Osprey'])).toBe('Kestrel, Heron, and Osprey');
    });

    it('supports an alternative conjunction for choices', () => {
        expect(speakList(['Northgate', 'Riverside'], 'or')).toBe('Northgate or Riverside');
    });
});

describe('nonZeroParts — never recite zeros', () => {
    it('drops every zero-count entry', () => {
        const parts = nonZeroParts([
            { count: 0, text: 'no offline vans' },
            { count: 3, text: '3 vans offline' },
            { count: 0, text: 'no low batteries' },
        ]);
        expect(parts).toEqual(['3 vans offline']);
    });

    it('returns nothing at all when everything is clear, so the caller can say "all clear"', () => {
        expect(nonZeroParts([{ count: 0, text: 'x' }, { count: 0, text: 'y' }])).toEqual([]);
    });
});

describe('number and unit formatting', () => {
    it('rounds percentages — engines read long decimals as digit soup', () => {
        expect(speakPercent(82.6666)).toBe('83 percent');
        expect(speakPercent(11)).toBe('11 percent');
    });

    it('spells the distance unit and groups thousands', () => {
        expect(speakDistanceKm(940)).toBe('940 kilometres');
        expect(speakDistanceKm(41280)).toBe('41 thousand 280 kilometres');
        expect(speakDistanceKm(12000)).toBe('12 thousand kilometres');
    });

    it('reads durations in the largest sensible unit', () => {
        expect(speakMinutes(1)).toBe('1 minute');
        expect(speakMinutes(45)).toBe('45 minutes');
        expect(speakMinutes(60)).toBe('1 hour');
        expect(speakMinutes(97)).toBe('1 hour 37 minutes');
        expect(speakMinutes(213)).toBe('3 hours 33 minutes');
    });
});

describe('normalizeTranscript — recognisers punctuate unpredictably', () => {
    it('lowercases and strips trailing punctuation', () => {
        expect(normalizeTranscript('Any Problems?')).toBe('any problems');
    });

    it('removes apostrophes without inserting a gap, so "what\'s" becomes "whats"', () => {
        expect(normalizeTranscript("What's wrong")).toBe('whats wrong');
        expect(normalizeTranscript('What’s wrong')).toBe('whats wrong');
    });

    it('turns other punctuation into a separator rather than deleting it', () => {
        expect(normalizeTranscript('stop, listen')).toBe('stop listen');
    });

    it('collapses repeated whitespace', () => {
        expect(normalizeTranscript('  how   many  vans ')).toBe('how many vans');
    });
});

describe('containsWord — why short call signs must not be substring-matched', () => {
    it('matches a whole word', () => {
        expect(containsWord('tell me about tern', 'Tern')).toBe(true);
    });

    it('does NOT match a call sign hidden inside a longer word', () => {
        // The bug this prevents: "Tern" inside "eastern", "Teal" inside "stealthy".
        expect(containsWord('the eastern depot', 'Tern')).toBe(false);
        expect(containsWord('a stealthy approach', 'Teal')).toBe(false);
        expect(containsWord('ask the driver', 'river')).toBe(false);
    });

    it('matches multi-word phrases', () => {
        expect(containsWord('vans that are on route now', 'on route')).toBe(true);
    });

    it('is false for an empty needle', () => {
        expect(containsWord('anything', '')).toBe(false);
    });
});
