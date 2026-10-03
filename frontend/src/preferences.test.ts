import { describe, expect, it } from 'vitest';
import { parsePreferences } from './preferences';

describe('saved appearance compatibility', () => {
  it('retains valid settings from the previous frontend', () => {
    expect(parsePreferences('{"theme":"paper-light","layout":"justified","group":"session","browse":"months"}')).toEqual({theme:'paper-light',layout:'justified',group:'session',browse:'months'});
  });
  it.each([null, 'broken', 'null', '[]', '{"theme":"other","layout":"other"}'])('recovers invalid browser settings: %s', raw => {
    expect(parsePreferences(raw)).toEqual({theme:'warm-dark',layout:'grid',group:'world',browse:'worlds'});
  });
});
