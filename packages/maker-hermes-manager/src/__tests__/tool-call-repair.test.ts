import { describe, expect, it } from 'vitest';

import {
  repairHermesToolEvent,
  repairJsonString,
  repairToolCallArguments,
} from '../tool-call-repair.js';

describe('tool-call-repair', () => {
  describe('repairJsonString', () => {
    it('parses valid JSON without modification', () => {
      const input = '{"command": "git status", "timeout": 5000, "flag": true}';
      expect(repairJsonString(input)).toEqual({
        command: 'git status',
        timeout: 5000,
        flag: true,
      });
    });

    it('repairs trailing commas in objects and arrays', () => {
      const input = '{"cmd": "ls", "args": ["-l", "-a",], "extra": {"depth": 1,}, }';
      expect(repairJsonString(input)).toEqual({
        cmd: 'ls',
        args: ['-l', '-a'],
        extra: { depth: 1 },
      });
    });

    it('repairs unquoted object keys', () => {
      const input = '{command: "cat file.txt", lines: 10, verbose_mode: true}';
      expect(repairJsonString(input)).toEqual({
        command: 'cat file.txt',
        lines: 10,
        verbose_mode: true,
      });
    });

    it('repairs single-quoted keys and values', () => {
      const input = "{'path': 'src/index.ts', 'action': 'read', 'encoding': 'utf8'}";
      expect(repairJsonString(input)).toEqual({
        path: 'src/index.ts',
        action: 'read',
        encoding: 'utf8',
      });
    });

    it('handles escaped quotes inside single-quoted strings', () => {
      const input = "{'message': 'it\\'s a test', 'quote': 'he said \"hello\"'}";
      expect(repairJsonString(input)).toEqual({
        message: "it's a test",
        quote: 'he said "hello"',
      });
    });

    it('repairs Python literals True, False, None', () => {
      const input = '{"enabled": True, "strict": False, "fallback": None}';
      expect(repairJsonString(input)).toEqual({
        enabled: true,
        strict: false,
        fallback: null,
      });
    });

    it('strips markdown code fences (```json ... ```)', () => {
      const input = '```json\n{\n  "path": "/var/log/app.log",\n  "follow": true\n}\n```';
      expect(repairJsonString(input)).toEqual({
        path: '/var/log/app.log',
        follow: true,
      });
    });

    it('extracts JSON surrounded by conversational filler', () => {
      const input = 'Sure, here is the tool call:\n{"target": "deploy.sh", "force": false}\nLet me know if you need more!';
      expect(repairJsonString(input)).toEqual({
        target: 'deploy.sh',
        force: false,
      });
    });

    it('repairs truncated JSON with missing closing quotes and braces', () => {
      const input = '{"command": "echo test", "options": {"timeout": 1000';
      expect(repairJsonString(input)).toEqual({
        command: 'echo test',
        options: { timeout: 1000 },
      });
    });

    it('repairs unclosed string and braces', () => {
      const input = '{"description": "running automated tests';
      expect(repairJsonString(input)).toEqual({
        description: 'running automated tests',
      });
    });

    it('strips inline line comments and block comments', () => {
      const input = `
      {
        // First setting
        "host": "127.0.0.1",
        /* Port configuration */
        "port": 8080
      }
      `;
      expect(repairJsonString(input)).toEqual({
        host: '127.0.0.1',
        port: 8080,
      });
    });

    it('repairs unescaped literal newlines inside strings', () => {
      const input = '{"query": "SELECT * FROM users\nWHERE id = 1\nLIMIT 10"}';
      expect(repairJsonString(input)).toEqual({
        query: 'SELECT * FROM users\nWHERE id = 1\nLIMIT 10',
      });
    });

    it('fails open when encountering completely unparseable input', () => {
      const input = 'this is not json at all';
      expect(repairJsonString(input)).toEqual({ _raw: input });
    });
  });

  describe('repairToolCallArguments', () => {
    it('returns empty object on null or undefined', () => {
      expect(repairToolCallArguments(undefined)).toEqual({});
      expect(repairToolCallArguments(null)).toEqual({});
    });

    it('parses and repairs stringified JSON arguments', () => {
      const raw = "{cmd: 'git commit -m \"update\"', verify: True,}";
      expect(repairToolCallArguments(raw)).toEqual({
        cmd: 'git commit -m "update"',
        verify: true,
      });
    });

    it('returns existing object and repairs inner stringified JSON values', () => {
      const input = {
        toolName: 'execute',
        config: "{\"mode\": 'strict', \"retries\": 3,}",
        directValue: 42,
      };
      expect(repairToolCallArguments(input)).toEqual({
        toolName: 'execute',
        config: { mode: 'strict', retries: 3 },
        directValue: 42,
      });
    });
  });

  describe('repairHermesToolEvent', () => {
    it('repairs tool_use event with malformed arguments string', () => {
      const event = {
        type: 'tool_use',
        name: 'read_file',
        tool_call_id: 'call_123',
        input: "{path: 'README.md', lines: 50,}",
      };
      const repaired = repairHermesToolEvent(event);
      expect(repaired.input).toEqual({
        path: 'README.md',
        lines: 50,
      });
    });

    it('leaves non-tool events untouched', () => {
      const event = { type: 'text', text: 'Hello world' };
      expect(repairHermesToolEvent(event)).toEqual(event);
    });
  });
});
