const tag = "\x1b[1m\x1b[35m[void]\x1b[39m\x1b[22m";

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

function prefix(): string {
  return `\x1b[2m${timeFormat.format()}\x1b[22m ${tag}`;
}

export function voidLog(msg: string): void {
  console.log(`${prefix()} ${msg}`);
}

export function voidWarn(msg: string): void {
  console.log(`${prefix()} \x1b[33m${msg}\x1b[39m`);
}

export function voidError(msg: string): void {
  console.log(`${prefix()} \x1b[31m${msg}\x1b[39m`);
}
