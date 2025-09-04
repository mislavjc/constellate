/** @type {import("prettier").Options} */
const config = {
  printWidth: 80,
  tabWidth: 2,
  semi: true,
  singleQuote: true,
  bracketSpacing: true,
  arrowParens: 'avoid',
  // Additional settings from current config
  trailingComma: 'es5',
  useTabs: false,
  bracketSameLine: false,
  endOfLine: 'lf',
  quoteProps: 'as-needed',
  jsxSingleQuote: true,
  overrides: [
    {
      files: '*.md',
      options: {
        printWidth: 100,
      },
    },
  ],
};

export default config;
