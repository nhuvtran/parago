import { describe, it, expect } from 'vitest';
import { nextModePatch } from '../src/lib/protectionToggle.js';

describe('nextModePatch (popup power toggle)', () => {
  it('turning off from grey stashes grey in preferredMode', () => {
    expect(nextModePatch({ mode: 'grey', preferredMode: 'grey' }))
      .toEqual({ preferredMode: 'grey', mode: 'off' });
  });

  it('turning off from hide remembers hide', () => {
    expect(nextModePatch({ mode: 'hide', preferredMode: 'grey' }))
      .toEqual({ preferredMode: 'hide', mode: 'off' });
  });

  it('turning on restores the remembered mode', () => {
    expect(nextModePatch({ mode: 'off', preferredMode: 'hide' }))
      .toEqual({ mode: 'hide' });
  });

  it('turning on falls back to grey when preferredMode is missing', () => {
    expect(nextModePatch({ mode: 'off' }))
      .toEqual({ mode: 'grey' });
  });

  it('turning on never resolves to off even if preferredMode is off', () => {
    expect(nextModePatch({ mode: 'off', preferredMode: 'off' }))
      .toEqual({ mode: 'grey' });
  });
});
