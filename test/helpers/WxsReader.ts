/** One element of a Windows Installer source file, with its attributes decoded. */
export interface WxsElement {
  name: string;
  attributes: Record<string, string>;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: "\"",
  apos: "'",
};

/** Decodes the five predefined entities and numeric references; any other `&` is an error. */
function decode(value: string): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char !== "&") {
      result += char;
      index += 1;
      continue;
    }
    const end = value.indexOf(";", index);
    const reference = end === -1 ? "" : value.slice(index, end + 1);
    const body = reference.slice(1, -1);
    if (/^#x[0-9A-Fa-f]+$/.test(body)) {
      result += String.fromCodePoint(parseInt(body.slice(2), 16));
    } else if (/^#[0-9]+$/.test(body)) {
      result += String.fromCodePoint(parseInt(body.slice(1), 10));
    } else if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      result += NAMED_ENTITIES[body];
    } else {
      const shown = /^&[A-Za-z0-9#]*;?/.exec(value.slice(index))?.[0] ?? "&";
      throw new Error("Unsupported entity or bare ampersand: " + shown);
    }
    index += reference.length;
  }
  return result;
}

/**
 * Reads the elements of a small `.wxs` text in document order, with their attributes. Comments,
 * processing instructions and closing tags are skipped. Written without any code from the tool so
 * it can check the tool's output independently.
 */
export function readWxs(text: string): WxsElement[] {
  const elements: WxsElement[] = [];
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?[\s\S]*?\?>/g, "");
  const tag = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*\/?>/g;
  const attribute = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(stripped)) !== null) {
    const attributes: Record<string, string> = {};
    let pair: RegExpExecArray | null;
    attribute.lastIndex = 0;
    while ((pair = attribute.exec(match[2])) !== null) {
      attributes[pair[1]] = decode(pair[2] ?? pair[3] ?? "");
    }
    elements.push({ name: match[1], attributes });
  }
  return elements;
}
