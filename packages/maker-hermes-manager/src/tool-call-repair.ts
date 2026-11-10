/**
 * Local tool-call JSON repair & misformat guard (ROADMAP 9.4).
 *
 * Fail-open input sanitization layer for Hermes manager that automatically fixes
 * malformed JSON arguments from local LLMs (Ollama, LM Studio, vLLM, small models)
 * before tool dispatch.
 *
 * Common malformations handled:
 * - Trailing commas in objects and arrays: `{"a": 1, "b": [2, 3,],}`
 * - Unquoted object keys: `{cmd: "ls", count: 5}`
 * - Single-quoted keys and string values: `{'path': 'file.txt', 'opt': 'it\'s ok'}`
 * - Python literals: `True` -> `true`, `False` -> `false`, `None` -> `null`
 * - Markdown code fences: ````json\n{"command": "ls"}\n````
 * - Commentary prose outside JSON: `Here is the tool call: {"cmd": "ls"} hope this helps!`
 * - Truncated JSON / missing closing quotes & braces: `{"cmd": "run", "opt": {"timeout": 1000`
 * - Unescaped literal newlines/tabs inside string literals
 * - Comments inside JSON: line comments and block comments
 */

/**
 * Repairs a malformed or raw JSON string emitted by an LLM into a parsed value.
 * Returns null or undefined if input is empty, or the parsed object/array/value.
 * Fails open: if repairs cannot produce valid JSON, returns `{ _raw: raw }`.
 */
export function repairJsonString(raw: string): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return {};

  // 1. Fast path: try standard JSON.parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // proceed to repair passes
  }

  // 2. Strip markdown code fences (```json ... ``` or ``` ... ```)
  let text = trimmed;
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json|JSON)?\s*\r?\n?/, '').replace(/\r?\n?```\s*$/, '').trim();
    try {
      return JSON.parse(text);
    } catch {
      // continue
    }
  }

  // 3. Locate the outermost JSON structure ({ or [) if surrounded by conversational filler
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let startIdx = -1;
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
  }

  if (startIdx > 0) {
    text = text.slice(startIdx);
  }

  // 4. Strip single-line (//) and multi-line (/* */) comments outside string literals
  text = stripJsonComments(text);

  // 5. AST-like scanner pass to repair quotes, keys, trailing commas, literals, unclosed brackets
  const repairedText = repairJsonTokens(text);

  try {
    return JSON.parse(repairedText);
  } catch {
    // 6. Secondary fallback: remove any leftover trailing commas before closing braces/brackets
    try {
      const aggressive = repairedText.replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(aggressive);
    } catch {
      // Fail-open: return object containing original raw string
      return { _raw: raw };
    }
  }
}

/**
 * Strips line comments and block comments outside string literals.
 */
function stripJsonComments(text: string): string {
  let cleaned = '';
  let inString = false;
  let quoteChar = '';
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inString) {
      cleaned += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quoteChar) {
        inString = false;
      }
    } else {
      if (ch === '/' && next === '/') {
        // Skip line comment until newline
        while (i < text.length && text[i] !== '\n') i++;
        cleaned += '\n';
      } else if (ch === '/' && next === '*') {
        // Skip block comment
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
        i++; // skip trailing /
      } else {
        if (ch === '"' || ch === "'") {
          inString = true;
          quoteChar = ch;
        }
        cleaned += ch;
      }
    }
  }
  return cleaned.trim();
}

/**
 * Scans tokens, fixes unquoted keys, single quotes, Python literals, trailing commas,
 * unescaped control chars, and missing closing quotes / braces.
 */
function repairJsonTokens(text: string): string {
  let out = '';
  let inString = false;
  let quoteChar = '';
  let escaped = false;
  let hasStartedRoot = false;
  const stack: string[] = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const prev = text[i - 1];

    if (inString) {
      if (escaped) {
        if (quoteChar === "'" && ch === "'") {
          // Escaped single quote in single-quoted string -> single quote inside double-quoted string
          out += "'";
        } else if (quoteChar === "'" && ch === '"') {
          // Unescaped double quote inside single-quoted string -> escape for double quotes
          out += '\\"';
        } else {
          out += '\\' + ch;
        }
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quoteChar) {
        // Closing quote
        out += '"';
        inString = false;
      } else if (ch === '"' && quoteChar === "'") {
        // Raw double quote inside single-quoted string needs escaping in double-quoted output
        out += '\\"';
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
    } else {
      // Outside string literal
      if (ch === '"' || ch === "'") {
        inString = true;
        quoteChar = ch;
        out += '"';
      } else if (ch === '{') {
        hasStartedRoot = true;
        stack.push('}');
        out += '{';
      } else if (ch === '[') {
        hasStartedRoot = true;
        stack.push(']');
        out += '[';
      } else if (ch === '}' || ch === ']') {
        if (stack.length > 0 && stack[stack.length - 1] === ch) {
          stack.pop();
        }
        // Drop any trailing comma before closing bracket/brace
        out = out.replace(/,\s*$/, '');
        out += ch;
        if (hasStartedRoot && stack.length === 0) {
          // Reached the end of root JSON structure; ignore any following prose
          break;
        }
      } else if (ch === ':') {
        out += ':';
      } else if (ch === ',') {
        out += ',';
      } else {
        const remaining = text.slice(i);

        // Check for Python literals: True, False, None
        if (/^True\b/.test(remaining)) {
          out += 'true';
          i += 3;
        } else if (/^False\b/.test(remaining)) {
          out += 'false';
          i += 4;
        } else if (/^None\b/.test(remaining)) {
          out += 'null';
          i += 3;
        } else {
          // Check for unquoted object keys: e.g. `{ key:` or `, key:`
          const matchUnquoted = remaining.match(/^([a-zA-Z0-9_$-]+)\s*:/);
          if (
            matchUnquoted &&
            (prev === '{' || prev === ',' || (prev !== undefined && /\s/.test(prev)))
          ) {
            const key = matchUnquoted[1];
            out += `"${key}":`;
            i += matchUnquoted[0].length - 1;
          } else {
            out += ch;
          }
        }
      }
    }
  }

  // If ended while still inside string literal, close the quote
  if (inString) {
    out += '"';
  }

  // Remove any trailing commas at the end of the text
  out = out.replace(/,\s*$/, '');

  // Close any unclosed braces/brackets in LIFO order
  while (stack.length > 0) {
    const closing = stack.pop()!;
    out = out.replace(/,\s*$/, '') + closing;
  }

  return out;
}

/**
 * Sanitizes and repairs tool-call arguments.
 *
 * Can receive:
 * - `undefined` / `null` -> returns `{}`
 * - Raw string -> parses and repairs into an object
 * - Already parsed `Record<string, unknown>` -> returns it, with any inner stringified
 *   JSON values repaired if applicable.
 */
export function repairToolCallArguments(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) {
    return {};
  }

  if (typeof input === 'string') {
    const parsed = repairJsonString(input);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (Array.isArray(parsed)) {
      return { items: parsed };
    }
    return { _raw: input };
  }

  if (typeof input === 'object' && !Array.isArray(input)) {
    const record = { ...(input as Record<string, unknown>) };
    // Check if any top-level property contains a stringified JSON argument
    for (const [k, v] of Object.entries(record)) {
      if (typeof v === 'string') {
        const vTrimmed = v.trim();
        if (
          (vTrimmed.startsWith('{') && vTrimmed.endsWith('}')) ||
          (vTrimmed.startsWith('[') && vTrimmed.endsWith(']'))
        ) {
          try {
            record[k] = JSON.parse(vTrimmed);
          } catch {
            const repaired = repairJsonString(vTrimmed);
            if (repaired && typeof repaired === 'object') {
              record[k] = repaired;
            }
          }
        }
      }
    }
    return record;
  }

  return { _value: input };
}

/**
 * Normalizes and repairs a Hermes tool_use event in-place or returns a repaired copy.
 */
export function repairHermesToolEvent<T>(event: T): T {
  if (!event || typeof event !== 'object') return event;
  const evt = event as Record<string, unknown>;

  if (evt.type === 'tool_use' || evt.kind === 'tool-use') {
    const rawInput = evt.input ?? evt.arguments ?? evt.tool_input;
    const repaired = repairToolCallArguments(rawInput);
    return {
      ...evt,
      input: repaired,
      ...(evt.tool_input !== undefined ? { tool_input: repaired } : {}),
    } as unknown as T;
  }

  return event;
}
