import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isMcpServerAllowed,
  isToolAllowed,
  loadExpertToolsFile,
  parseExpertToolsDoc,
  parseExpertToolsYaml,
  serializeExpertToolsPolicy,
  writeExpertToolsFile,
  type ExpertToolsPolicy,
} from '../expert-tools.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'expert-tools-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('parseExpertToolsDoc', () => {
  it('handles null, undefined and empty input gracefully', () => {
    expect(parseExpertToolsDoc(null)).toEqual({ policy: {}, issues: [] });
    expect(parseExpertToolsDoc(undefined)).toEqual({ policy: {}, issues: [] });
    expect(parseExpertToolsDoc('')).toEqual({ policy: {}, issues: [] });
    expect(parseExpertToolsDoc({})).toEqual({ policy: {}, issues: [] });
  });

  it('rejects non-mapping root', () => {
    const res = parseExpertToolsDoc(['invalid']);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]?.where).toBe('(file)');
  });

  it('reports unknown top-level properties', () => {
    const res = parseExpertToolsDoc({
      tools: { allow: ['read_file'] },
      unknownProp: 123,
    });
    expect(res.issues).toEqual([
      {
        where: 'unknownProp',
        message: 'unknown property "unknownProp" in tools.yaml (expected "tools" or "mcp_servers")',
      },
    ]);
  });

  it('reports error when both mcp_servers and mcpServers are provided', () => {
    const res = parseExpertToolsDoc({
      mcp_servers: { allow: ['cindy_docs'] },
      mcpServers: { allow: ['cindy_docs'] },
    });
    expect(res.issues.some((i) => i.where === 'mcp_servers')).toBe(true);
  });

  it('parses valid tools and mcp_servers sections with deduplication and trimming', () => {
    const res = parseExpertToolsDoc({
      tools: {
        allow: [' read_file ', 'grep', 'read_file'],
        deny: ['bash', ' terminal '],
      },
      mcp_servers: {
        allow: ['cindy_docs'],
        deny: ['cindy_ssh'],
      },
    });
    expect(res.issues).toEqual([]);
    expect(res.policy).toEqual({
      tools: {
        allow: ['read_file', 'grep'],
        deny: ['bash', 'terminal'],
      },
      mcpServers: {
        allow: ['cindy_docs'],
        deny: ['cindy_ssh'],
      },
    });
  });

  it('accepts camelCase mcpServers', () => {
    const res = parseExpertToolsDoc({
      mcpServers: {
        allow: ['cindy_docs'],
      },
    });
    expect(res.issues).toEqual([]);
    expect(res.policy.mcpServers?.allow).toEqual(['cindy_docs']);
  });

  it('reports non-mapping tools or mcp_servers sections', () => {
    const res = parseExpertToolsDoc({
      tools: ['read_file'],
      mcp_servers: 'cindy_docs',
    });
    expect(res.issues).toEqual([
      { where: 'tools', message: '"tools" must be a mapping with "allow" and/or "deny"' },
      { where: 'mcp_servers', message: '"mcp_servers" must be a mapping with "allow" and/or "deny"' },
    ]);
  });

  it('reports unknown keys in tools and mcp_servers mappings', () => {
    const res = parseExpertToolsDoc({
      tools: { allow: ['read_file'], invalid: true },
      mcp_servers: { wrong: 'val' },
    });
    expect(res.issues).toEqual([
      { where: 'tools.invalid', message: 'unknown key "invalid" in tools (expected "allow" or "deny")' },
      { where: 'mcp_servers.wrong', message: 'unknown key "wrong" in mcp_servers (expected "allow" or "deny")' },
    ]);
  });

  it('reports invalid list items in allow or deny', () => {
    const res = parseExpertToolsDoc({
      tools: {
        allow: ['ok', '', 123 as unknown as string],
        deny: 'not-a-list' as unknown as string[],
      },
    });
    expect(res.issues).toEqual([
      { where: 'tools.allow', message: '"allow" must be a list of non-empty strings' },
      { where: 'tools.deny', message: '"deny" must be a list of non-empty strings' },
    ]);
  });
});

describe('parseExpertToolsYaml and loadExpertToolsFile', () => {
  it('parses YAML text correctly', () => {
    const yaml = `
tools:
  allow:
    - read_project_file
    - search_project
  deny:
    - bash
mcp_servers:
  allow:
    - cindy_project_reader
`;
    const res = parseExpertToolsYaml(yaml);
    expect(res.issues).toEqual([]);
    expect(res.policy.tools?.allow).toEqual(['read_project_file', 'search_project']);
    expect(res.policy.tools?.deny).toEqual(['bash']);
    expect(res.policy.mcpServers?.allow).toEqual(['cindy_project_reader']);
  });

  it('handles invalid YAML syntax safely', () => {
    const badYaml = 'tools:\n  allow: [unclosed';
    const res = parseExpertToolsYaml(badYaml);
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]?.where).toBe('(file)');
    expect(res.issues[0]?.message).toContain('invalid YAML');
  });

  it('loadExpertToolsFile returns empty policy for non-existent file', () => {
    const res = loadExpertToolsFile(path.join(tempDir, 'does-not-exist.yaml'));
    expect(res.issues).toEqual([]);
    expect(res.policy).toEqual({});
  });

  it('loadExpertToolsFile reads valid file from disk', () => {
    const filePath = path.join(tempDir, 'tools.yaml');
    fs.writeFileSync(filePath, 'tools:\n  deny:\n    - bash\n');
    const res = loadExpertToolsFile(filePath);
    expect(res.issues).toEqual([]);
    expect(res.policy.tools?.deny).toEqual(['bash']);
  });
});

describe('serializeExpertToolsPolicy and writeExpertToolsFile', () => {
  it('serializes and round-trips policy', () => {
    const policy: ExpertToolsPolicy = {
      tools: {
        allow: ['read_file', 'grep'],
        deny: ['bash'],
      },
      mcpServers: {
        allow: ['cindy_docs'],
        deny: ['cindy_ssh'],
      },
    };
    const serialized = serializeExpertToolsPolicy(policy);
    expect(serialized).toContain('tools:');
    expect(serialized).toContain('mcp_servers:');
    const parsed = parseExpertToolsYaml(serialized);
    expect(parsed.issues).toEqual([]);
    expect(parsed.policy).toEqual(policy);
  });

  it('writes atomically to disk and re-reads cleanly', () => {
    const filePath = path.join(tempDir, 'sub', 'tools.yaml');
    const policy: ExpertToolsPolicy = {
      tools: { allow: ['read_note'] },
      mcpServers: { allow: ['cindy_notes'] },
    };
    writeExpertToolsFile(filePath, policy);
    expect(fs.existsSync(filePath)).toBe(true);

    const reloaded = loadExpertToolsFile(filePath);
    expect(reloaded.issues).toEqual([]);
    expect(reloaded.policy).toEqual(policy);
  });
});

describe('isToolAllowed evaluation', () => {
  it('allows everything when policy has no tools filter and no fallback', () => {
    expect(isToolAllowed('bash', undefined)).toBe(true);
    expect(isToolAllowed('bash', {})).toBe(true);
  });

  it('falls back to fallbackAllowedTools when policy tools filter is absent', () => {
    const fallback = ['draft_expert', 'list_experts'];
    expect(isToolAllowed('draft_expert', undefined, fallback)).toBe(true);
    expect(isToolAllowed('bash', undefined, fallback)).toBe(false);
    expect(isToolAllowed('draft_expert', {}, fallback)).toBe(true);
    expect(isToolAllowed('bash', {}, fallback)).toBe(false);
  });

  it('enforces strict whitelist when allow is specified', () => {
    const policy: ExpertToolsPolicy = {
      tools: {
        allow: ['read_file', 'search_project'],
      },
    };
    expect(isToolAllowed('read_file', policy)).toBe(true);
    expect(isToolAllowed('search_project', policy)).toBe(true);
    expect(isToolAllowed('bash', policy)).toBe(false);
  });

  it('blocks denied tools even if also listed in allow or fallback (deny always wins)', () => {
    const policy: ExpertToolsPolicy = {
      tools: {
        allow: ['bash', 'read_file'],
        deny: ['bash'],
      },
    };
    expect(isToolAllowed('bash', policy)).toBe(false);
    expect(isToolAllowed('read_file', policy)).toBe(true);
  });

  it('permits all non-denied tools when allow is omitted', () => {
    const policy: ExpertToolsPolicy = {
      tools: {
        deny: ['dangerous_tool'],
      },
    };
    expect(isToolAllowed('dangerous_tool', policy)).toBe(false);
    expect(isToolAllowed('any_other_tool', policy)).toBe(true);
  });
});

describe('isMcpServerAllowed evaluation', () => {
  it('allows all servers when no mcpServers policy is configured', () => {
    expect(isMcpServerAllowed('cindy_docs', undefined)).toBe(true);
    expect(isMcpServerAllowed('cindy_docs', {})).toBe(true);
  });

  it('enforces strict whitelist when allow is specified', () => {
    const policy: ExpertToolsPolicy = {
      mcpServers: {
        allow: ['cindy_docs', 'cindy_project_reader'],
      },
    };
    expect(isMcpServerAllowed('cindy_docs', policy)).toBe(true);
    expect(isMcpServerAllowed('cindy_project_reader', policy)).toBe(true);
    expect(isMcpServerAllowed('cindy_browser', policy)).toBe(false);
  });

  it('blocks denied servers even if also in allow (deny wins)', () => {
    const policy: ExpertToolsPolicy = {
      mcpServers: {
        allow: ['cindy_docs', 'cindy_ssh'],
        deny: ['cindy_ssh'],
      },
    };
    expect(isMcpServerAllowed('cindy_ssh', policy)).toBe(false);
    expect(isMcpServerAllowed('cindy_docs', policy)).toBe(true);
  });

  it('permits all non-denied servers when allow is omitted', () => {
    const policy: ExpertToolsPolicy = {
      mcpServers: {
        deny: ['cindy_ssh'],
      },
    };
    expect(isMcpServerAllowed('cindy_ssh', policy)).toBe(false);
    expect(isMcpServerAllowed('cindy_docs', policy)).toBe(true);
  });
});
