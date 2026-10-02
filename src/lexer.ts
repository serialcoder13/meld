import { MeldSyntaxError, type Loc } from "./ir";

export type TokenKind = "ident" | "num" | "str" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  value: string;
  loc: Loc;
}

const PUNCT = [
  "->", "=>", "==", "!=", "<=", ">=", "&&", "||", "+=", "-=",
  "{", "}", "(", ")", "[", "]", ",", ":", ";", ".", "<", ">",
  "+", "-", "*", "/", "%", "!", "=", "?", "|",
];

export function lex(source: string, file: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const loc = (at: number): Loc => ({ file, line, col: at - lineStart + 1 });

  while (i < source.length) {
    const c = source[i]!;
    if (c === "\n") {
      i++;
      line++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const start = loc(i);
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      if (i >= source.length) throw new MeldSyntaxError(start, "This comment is never closed with */.");
      i += 2;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      tokens.push({ kind: "ident", value: source.slice(start, i), loc: loc(start) });
      continue;
    }
    if (/[0-9]/.test(c)) {
      const start = i;
      while (i < source.length && /[0-9_]/.test(source[i]!)) i++;
      if (source[i] === "." && /[0-9]/.test(source[i + 1] ?? "")) {
        i++;
        while (i < source.length && /[0-9_]/.test(source[i]!)) i++;
      }
      tokens.push({ kind: "num", value: source.slice(start, i).replaceAll("_", ""), loc: loc(start) });
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      const startLoc = loc(i);
      i++;
      let value = "";
      while (true) {
        const ch = source[i];
        if (ch === undefined || ch === "\n") throw new MeldSyntaxError(startLoc, "This text is missing its closing quote.");
        if (ch === c) break;
        if (ch === "\\") {
          const esc = source[i + 1];
          const map: Record<string, string> = { n: "\n", t: "\t", "\\": "\\", '"': '"', "'": "'" };
          if (esc === undefined || !(esc in map)) throw new MeldSyntaxError(loc(i), `Unknown escape \\${esc ?? ""} in text.`);
          value += map[esc];
          i += 2;
          continue;
        }
        value += ch;
        i++;
      }
      i++;
      tokens.push({ kind: "str", value, loc: loc(start) });
      continue;
    }
    if (c === "`") throw new MeldSyntaxError(loc(i), 'Backtick templates are not supported. Use "text" + text(value) instead.');
    if (source.startsWith("===", i)) throw new MeldSyntaxError(loc(i), "Use == instead of ===. In Meld, == never converts types.");
    if (source.startsWith("!==", i)) throw new MeldSyntaxError(loc(i), "Use != instead of !==. In Meld, != never converts types.");
    if (source.startsWith("??", i)) throw new MeldSyntaxError(loc(i), 'Meld has no ??. Use has(value, "field") or store.get(key, default).');
    const p = PUNCT.find((p) => source.startsWith(p, i));
    if (!p) throw new MeldSyntaxError(loc(i), `Unexpected character '${c}'.`);
    tokens.push({ kind: "punct", value: p, loc: loc(i) });
    i += p.length;
  }
  tokens.push({ kind: "eof", value: "", loc: loc(i) });
  return tokens;
}
