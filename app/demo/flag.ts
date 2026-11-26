/**
 * True only in the public demo build (`npm run build:demo`, Vite mode "demo").
 *
 * `import.meta.env.MODE` is replaced with a string at build time, so in every
 * other build this is the constant `false` and the code behind it, including
 * the lazily imported demo backend, is dropped from the bundle.
 */
export const DEMO = import.meta.env.MODE === "demo";
