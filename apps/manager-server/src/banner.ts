/**
 * What the operator sees in the terminal once the manager is up.
 *
 * Starting it used to print four lines, three of which were for whoever was
 * debugging it - a missing `.env`, a gateway port, a bootstrap notice - with
 * the one address that matters last and in the same grey as the rest. Someone
 * who has just installed this has to find that address, get it onto their
 * phone, and know how to stop the thing again.
 *
 * Everything here is a pure function of its input so it can be tested without
 * a terminal, and nothing decides on its own whether colour is wanted: the
 * caller looks at the stream and says.
 *
 * It used to draw the Wi-Fi address as a scannable code. That was half the
 * height of the window on every start, on a machine whose operator is nearly
 * always sitting at it, and it pushed the log above out of view. The console
 * itself carries the code, on the address it belongs to, where somebody who
 * actually wants to open this on a phone will look for it.
 */

export interface BannerAddress {
  readonly label: string;
  readonly url: string;
}

export interface BannerInput {
  readonly title: string;
  readonly addresses: readonly BannerAddress[];
  readonly stopHint: string;
  /** False for a pipe or a log file: no escapes. */
  readonly colour: boolean;
  /** Terminal columns, for the rule under the title. */
  readonly width?: number;
}

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const INDENT = '  ';
const DEFAULT_WIDTH = 80;

export function bootstrapBanner(input: BannerInput): string {
  const width = input.width ?? DEFAULT_WIDTH;
  const paint = (text: string, code: string) => input.colour ? `${code}${text}${RESET}` : text;
  const labels = input.addresses.map((address) => address.label);
  const column = Math.max(0, ...labels.map((label) => label.length));
  const row = (label: string, value: string) => `${INDENT}${paint(label.padEnd(column), DIM)}  ${paint(value, BOLD)}`;

  const lines: string[] = [''];
  lines.push(`${INDENT}${paint(input.title, BOLD)}`);
  lines.push(`${INDENT}${paint((input.colour ? '─' : '-').repeat(Math.max(8, Math.min(width, 64) - INDENT.length)), DIM)}`);
  lines.push('');
  for (const address of input.addresses) lines.push(row(address.label, address.url));

  lines.push('');
  lines.push(`${INDENT}${paint(input.stopHint, DIM)}`, '');
  return lines.join('\n');
}
