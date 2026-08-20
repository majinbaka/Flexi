import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: ['@storybook/addon-docs'],
  framework: '@storybook/react-vite',
  // Every component gets a generated Docs page from its JSDoc + argTypes, so
  // the props table for a primitive never has to be written by hand.
  docs: { autodocs: 'tag' },
};

export default config;
