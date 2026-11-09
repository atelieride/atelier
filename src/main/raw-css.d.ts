// theme.css read as text (shared/theme-resolve.ts) from code that isn't typed with vite/client: main and the tests.
declare module '*.css?raw' {
  const text: string;
  export default text;
}
