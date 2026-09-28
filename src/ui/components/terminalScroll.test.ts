import { describe, expect, it } from 'vitest';
import { BASE_FONT_SIZE, MIN_FONT_SIZE, createWheelAccumulator, fitFontSize, isAtBottom } from './terminalScroll.js';

describe('fitFontSize', () => {
  const grid = { width: 800, height: 500 };
  it('keeps the base font when the grid fits', () => {
    expect(fitFontSize({ width: 1200, height: 900 }, grid)).toBe(BASE_FONT_SIZE);
  });
  it('shrinks in half-pixel steps to fit the tighter dimension, never below the minimum', () => {
    expect(fitFontSize({ width: 1200, height: 400 }, grid)).toBe(10);
    expect(fitFontSize({ width: 100, height: 100 }, grid)).toBe(MIN_FONT_SIZE);
  });
  it('falls back to the base font before anything is measured', () => {
    expect(fitFontSize({ width: 0, height: 0 }, grid)).toBe(BASE_FONT_SIZE);
    expect(fitFontSize({ width: 500, height: 500 }, { width: 0, height: 0 })).toBe(BASE_FONT_SIZE);
  });
});

describe('createWheelAccumulator', () => {
  it('carries fractional trackpad deltas until they add up to a line', () => {
    const lines = createWheelAccumulator();
    expect(lines({ deltaY: 6, deltaMode: 0 }, 16, 30)).toBe(0);
    expect(lines({ deltaY: 6, deltaMode: 0 }, 16, 30)).toBe(0);
    expect(lines({ deltaY: 6, deltaMode: 0 }, 16, 30)).toBe(1);
    expect(lines({ deltaY: -48, deltaMode: 0 }, 16, 30)).toBe(-2);
  });
  it('handles line and page wheel modes', () => {
    const lines = createWheelAccumulator();
    expect(lines({ deltaY: 3, deltaMode: 1 }, 16, 30)).toBe(3);
    expect(lines({ deltaY: -1, deltaMode: 2 }, 16, 30)).toBe(-30);
  });
});

describe('isAtBottom', () => {
  it('compares the viewport to the newest line', () => {
    expect(isAtBottom({ viewportY: 40, baseY: 40 })).toBe(true);
    expect(isAtBottom({ viewportY: 10, baseY: 40 })).toBe(false);
  });
});
