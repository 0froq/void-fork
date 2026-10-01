import { CANCEL_SYMBOL, PasswordPrompt, settings } from '@clack/core';
import { S_BAR, S_BAR_END, S_PASSWORD_MASK, symbol, type PasswordOptions } from '@clack/prompts';
import pc from 'picocolors';

/** A visual example for an empty secret field; never a default value or an unmasked input. */
export async function passwordWithPlaceholder(
  options: PasswordOptions & { placeholder: string },
): Promise<string | typeof CANCEL_SYMBOL> {
  const value = await new PasswordPrompt({
    input: options.input,
    output: options.output,
    signal: options.signal,
    mask: options.mask ?? S_PASSWORD_MASK,
    validate: options.validate,
    render() {
      const guide = options.withGuide ?? settings.withGuide;
      const prefix = `${guide ? `${pc.gray(S_BAR)}\n` : ''}${symbol(this.state)}  ${options.message}\n`;
      const bar = guide ? `${pc.gray(S_BAR)}  ` : '';
      if (this.state === 'submit' || this.state === 'cancel') {
        return `${prefix}${bar}${pc.dim(this.masked)}`;
      }
      if (this.state === 'error') {
        const masked = this.masked;
        if (options.clearOnError) {
          this.clear();
        }
        return `${prefix}${bar}${pc.dim(masked)}\n${guide ? `${pc.yellow(S_BAR_END)}  ` : ''}${pc.yellow(this.error)}\n`;
      }
      // PasswordPrompt's cursor representation is masked as well. Never render
      // userInput/value, even on validation errors, submission, or cancellation.
      const input =
        this.userInput.length === 0 ? pc.dim(options.placeholder) : this.userInputWithCursor;
      return `${prefix}${guide ? `${pc.cyan(S_BAR)}  ` : ''}${input}\n${guide ? pc.cyan(S_BAR_END) : ''}\n`;
    },
  }).prompt();
  return value ?? CANCEL_SYMBOL;
}
