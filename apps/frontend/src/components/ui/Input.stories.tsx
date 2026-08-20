import type { Meta, StoryObj } from '@storybook/react-vite';
import { Input } from './Input';

/**
 * `Input` is the 40px-tall text field, with an optional leading icon (used
 * by search/toolbar rows and the login form) and an `error` message that
 * both styles the field and is wired to it via `aria-describedby`.
 */
const meta: Meta<typeof Input> = {
  title: 'UI/Input',
  component: Input,
  args: {
    label: 'Email',
    placeholder: 'you@example.com',
  },
  argTypes: {
    label: { control: 'text' },
    icon: { control: 'text' },
    error: { control: 'text' },
    disabled: { control: 'boolean' },
  },
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Input>;

export const Playground: Story = {
  args: { icon: 'mail' },
};

/** No label -- the bare field used inside toolbars. */
export const SearchField: Story = {
  args: {
    label: undefined,
    icon: 'search',
    placeholder: 'Search tables...',
    type: 'search',
  },
};

export const WithError: Story = {
  args: {
    icon: 'mail',
    defaultValue: 'not-an-email',
    error: 'Enter a valid email address.',
  },
};

export const Disabled: Story = {
  args: {
    icon: 'lock',
    defaultValue: 'acme',
    disabled: true,
  },
};

/** The three stacked fields of the tenant login form. */
export const LoginFields: Story = {
  render: () => (
    <div className="flex flex-col gap-md">
      <Input label="Tenant ID" icon="apartment" autoComplete="off" />
      <Input label="Email" icon="mail" type="email" autoComplete="username" />
      <Input
        label="Password"
        icon="lock"
        type="password"
        autoComplete="current-password"
      />
    </div>
  ),
};
