export interface MiResultRecord {
  token?: number;
  kind: 'result';
  class: string;
  results: Record<string, MiValue>;
}

export interface MiAsyncRecord {
  token?: number;
  kind: 'exec' | 'status' | 'notify';
  class: string;
  results: Record<string, MiValue>;
}

export interface MiStreamRecord {
  kind: 'console' | 'target' | 'log';
  text: string;
}

export type MiRecord = MiResultRecord | MiAsyncRecord | MiStreamRecord;

export type MiValue = string | MiTuple | MiList;
export interface MiTuple {
  [key: string]: MiValue;
}
export type MiList = Array<MiValue | MiResult>;
export interface MiResult {
  variable: string;
  value: MiValue;
}

export function parseMiLine(line: string): MiRecord | undefined {
  if (!line || line === '(gdb)') {
    return undefined;
  }

  let index = 0;
  let tokenText = '';
  while (index < line.length && isDigit(line[index])) {
    tokenText += line[index];
    index += 1;
  }
  const token = tokenText ? Number(tokenText) : undefined;
  const prefix = line[index];
  index += 1;

  if (prefix === '~' || prefix === '@' || prefix === '&') {
    const text = decodeCString(line.slice(index));
    return {
      kind: prefix === '~' ? 'console' : prefix === '@' ? 'target' : 'log',
      text
    };
  }

  const body = line.slice(index);
  const parser = new MiValueParser(body);
  const recordClass = parser.readUntilComma();
  const results = parser.tryReadResults();

  if (prefix === '^') {
    return {
      token,
      kind: 'result',
      class: recordClass,
      results
    };
  }

  if (prefix === '*' || prefix === '+' || prefix === '=') {
    return {
      token,
      kind: prefix === '*' ? 'exec' : prefix === '+' ? 'status' : 'notify',
      class: recordClass,
      results
    };
  }

  return undefined;
}

class MiValueParser {
  private readonly text: string;
  private index = 0;

  constructor(text: string) {
    this.text = text;
  }

  readUntilComma(): string {
    const start = this.index;
    while (this.index < this.text.length && this.text[this.index] !== ',') {
      this.index += 1;
    }
    const value = this.text.slice(start, this.index);
    if (this.text[this.index] === ',') {
      this.index += 1;
    }
    return value;
  }

  tryReadResults(): Record<string, MiValue> {
    const results: Record<string, MiValue> = {};
    while (this.index < this.text.length) {
      const result = this.readResult();
      results[result.variable] = result.value;
      if (this.text[this.index] === ',') {
        this.index += 1;
      }
    }
    return results;
  }

  private readResult(): MiResult {
    const start = this.index;
    while (this.index < this.text.length && this.text[this.index] !== '=') {
      this.index += 1;
    }
    const variable = this.text.slice(start, this.index);
    this.index += 1;
    return { variable, value: this.readValue() };
  }

  private readValue(): MiValue {
    const ch = this.text[this.index];
    if (ch === '"') {
      return this.readCString();
    }
    if (ch === '{') {
      return this.readTuple();
    }
    if (ch === '[') {
      return this.readList();
    }

    const start = this.index;
    while (this.index < this.text.length && this.text[this.index] !== ',' && this.text[this.index] !== '}' && this.text[this.index] !== ']') {
      this.index += 1;
    }
    return this.text.slice(start, this.index);
  }

  private readCString(): string {
    let escaped = false;
    let out = '"';
    this.index += 1;
    while (this.index < this.text.length) {
      const ch = this.text[this.index];
      out += ch;
      this.index += 1;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        break;
      }
    }
    return decodeCString(out);
  }

  private readTuple(): MiTuple {
    const tuple: MiTuple = {};
    this.index += 1;
    while (this.index < this.text.length && this.text[this.index] !== '}') {
      const result = this.readResult();
      tuple[result.variable] = result.value;
      if (this.text[this.index] === ',') {
        this.index += 1;
      }
    }
    this.index += 1;
    return tuple;
  }

  private readList(): MiList {
    const list: MiList = [];
    this.index += 1;
    while (this.index < this.text.length && this.text[this.index] !== ']') {
      if (looksLikeResult(this.text, this.index)) {
        list.push(this.readResult());
      } else {
        list.push(this.readValue());
      }
      if (this.text[this.index] === ',') {
        this.index += 1;
      }
    }
    this.index += 1;
    return list;
  }
}

function looksLikeResult(text: string, index: number): boolean {
  let i = index;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '=') {
      return true;
    }
    if (ch === ',' || ch === ']' || ch === '}') {
      return false;
    }
    if (ch === '{' || ch === '[' || ch === '"') {
      return false;
    }
    i += 1;
  }
  return false;
}

function decodeCString(text: string): string {
  if (!text.startsWith('"')) {
    return text;
  }
  const inner = text.slice(1, -1);
  return inner.replace(/\\([\\nrt"'])/g, (_match, group: string) => {
    switch (group) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return group;
    }
  }).replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

function isDigit(value: string): boolean {
  return value >= '0' && value <= '9';
}
