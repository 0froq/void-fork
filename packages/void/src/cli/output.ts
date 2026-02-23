import pc from "picocolors";

export { pc };

export function cliTitle(command: string): string {
  return pc.blue(`void ${command}`);
}

export function sectionTitle(title: string): string {
  return pc.reset(pc.blue(title));
}

export function categoryTitle(title: string): string {
  return pc.reset(pc.bold(pc.cyan(title)));
}

export function dim(text: string): string {
  return pc.dim(text);
}

export function tablePrefix(): string {
  return `${pc.gray("│")}  `;
}

export function helpLine(command: string, description: string): string {
  return `${pc.reset(command.padEnd(34))} ${pc.dim(description)}`;
}
