// Single source of truth for design tokens. Plain CJS so tailwind.config.js
// (Node, no TS transform) and theme.ts (app code) can both consume it.
module.exports = {
  colors: {
    background: '#0B0F14',
    surface: '#141A21',
    surfaceAlt: '#1C242E',
    primary: '#4ADE80',
    primaryMuted: '#1F3D2B',
    accent: '#60A5FA',
    text: '#F3F6F9',
    textMuted: '#9AA5B1',
    border: '#26303B',
    danger: '#F87171',
    success: '#4ADE80',
  },
  fontFamily: {
    sans: ['System'],
    mono: ['Menlo', 'Courier New'],
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 16,
    lg: 24,
    xl: 32,
  },
  radius: {
    sm: 6,
    md: 12,
    lg: 20,
    full: 9999,
  },
  // Single transition duration used everywhere in the app (per project convention).
  transitionDuration: {
    DEFAULT: '200ms',
  },
};
