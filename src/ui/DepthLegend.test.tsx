import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DepthLegend } from './DepthLetters';

describe('DepthLegend', () => {
  it('draws every state sample with a privilege colour, like the letters of the matrix', () => {
    const { container } = render(<DepthLegend />);
    for (const state of ['granted', 'covered', 'inactive', 'staged']) {
      const sample = container.querySelector(`.letter-${state}`);
      expect(sample, state).not.toBeNull();
      expect(sample?.getAttribute('data-priv'), state).toBeTruthy();
    }
    // a staged change looks as in the matrix: a filled letter with a dashed outline, not an extra mark
    expect(container.querySelector('.letter-staged')?.classList.contains('letter-pending')).toBe(true);
  });
});
