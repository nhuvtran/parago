// test/placementOverlay.test.js
import { describe, it, expect, afterEach } from 'vitest';
import {
  showProcessing, showFinishing, showConfirmed, showCouldNotComplete,
  showManualFallback, removePlacementOverlay, isPlacementOverlayShown,
} from '../src/content/placementOverlay.js';

afterEach(() => { removePlacementOverlay(); document.body.innerHTML = ''; });

describe('placementOverlay (all states are non-blocking corner toasts)', () => {
  it('renders a state as a corner toast, not a full-page blocking overlay', () => {
    showProcessing();
    expect(isPlacementOverlayShown()).toBe(true);
    expect(document.getElementById('parago-placement-toast')).not.toBeNull();
    expect(document.querySelector('#parago-placement-overlay')).toBeNull(); // no blocking card
    expect(document.body.textContent).toContain('being processed');
  });

  it('swaps states in place (one toast at a time)', () => {
    showProcessing();
    showConfirmed();
    expect(document.querySelectorAll('#parago-placement-toast').length).toBe(1);
    expect(document.body.textContent).toContain('confirmed');
  });

  it('finishing, confirmed, and failed each render as the toast', () => {
    showFinishing();
    expect(isPlacementOverlayShown()).toBe(true);
    showCouldNotComplete();
    expect(document.body.textContent).toContain("couldn't");
  });

  it('manual fallback wires the toast button to the callback', () => {
    let clicked = false;
    showManualFallback(() => { clicked = true; });
    document.querySelector('.parago-pl-toast-btn').click();
    expect(clicked).toBe(true);
  });

  it('removePlacementOverlay clears it', () => {
    showFinishing();
    removePlacementOverlay();
    expect(isPlacementOverlayShown()).toBe(false);
  });
});
