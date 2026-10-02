import {
  password,
  type CANCEL_SYMBOL,
  type PasswordOptions,
} from '@voidzero-dev/vite-plus-prompts';

/** A visual example for an empty secret field; never a default value or unmasked input. */
export function passwordWithPlaceholder(
  options: PasswordOptions & { placeholder: string },
): Promise<string | typeof CANCEL_SYMBOL> {
  return password(options);
}
