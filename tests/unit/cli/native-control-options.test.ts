import { describe, expect, it } from 'vitest';
import { validateNativeControlOptions } from '../../../src/cli/commands/native';

describe('native provider control options', () => {
  it('allows in-place rebind of a Bridge thread', () => {
    expect(() => validateNativeControlOptions('thread-1', {
      bridge: true,
      followCurrentProvider: true,
    })).not.toThrow();
  });

  it('keeps provider-following adoption compatible', () => {
    expect(() => validateNativeControlOptions(undefined, {
      adopt: 'legacy-thread',
      followCurrentProvider: true,
    })).not.toThrow();
  });

  it('rejects ambiguous or unsupported provider switches', () => {
    expect(() => validateNativeControlOptions(undefined, {
      followCurrentProvider: true,
    })).toThrow(/需要 --adopt <thread-id> 或 --bridge <thread-id>/);
    expect(() => validateNativeControlOptions(undefined, {
      bridge: true,
      followCurrentProvider: true,
    })).toThrow(/需要 --adopt <thread-id> 或 --bridge <thread-id>/);
    expect(() => validateNativeControlOptions('thread-1', {
      followCurrentProvider: true,
    })).toThrow(/普通 positional resume 不会切换 provider/);
  });

  it('does not restrict ordinary native and Bridge resumes', () => {
    expect(() => validateNativeControlOptions('thread-1', {})).not.toThrow();
    expect(() => validateNativeControlOptions('thread-1', {
      bridge: true,
    })).not.toThrow();
  });
});
