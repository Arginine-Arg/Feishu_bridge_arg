import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NO_PROXY,
  NetworkProxyUnavailableError,
  isLoopbackHost,
  parseProxyUrl,
  proxyEnvironmentArgs,
  sanitizeAgentEnv,
} from '../../../src/platform/network-env';

const deadProxyEnv = {
  HTTP_PROXY: 'http://127.0.0.1:17897',
  HTTPS_PROXY: 'http://127.0.0.1:17897',
  ALL_PROXY: 'socks5h://127.0.0.1:17897',
  KEEP_ME: 'unchanged',
};

describe('agent network environment', () => {
  it('direct mode removes every inherited proxy variable', async () => {
    const env = await sanitizeAgentEnv(deadProxyEnv, { mode: 'direct' });
    expect(env).toEqual({ KEEP_ME: 'unchanged' });
  });

  it('proxy mode applies the explicit proxy after a successful preflight', async () => {
    const probe = vi.fn(async () => 'open' as const);
    const env = await sanitizeAgentEnv(deadProxyEnv, {
      mode: 'proxy',
      proxyUrl: 'socks5h://127.0.0.1:7890',
    }, { probe });
    expect(probe).toHaveBeenCalledWith('127.0.0.1', 7890, 800);
    expect(env).toMatchObject({
      HTTP_PROXY: 'socks5h://127.0.0.1:7890',
      HTTPS_PROXY: 'socks5h://127.0.0.1:7890',
      ALL_PROXY: 'socks5h://127.0.0.1:7890',
      NO_PROXY: DEFAULT_NO_PROXY,
      http_proxy: 'socks5h://127.0.0.1:7890',
      KEEP_ME: 'unchanged',
    });
  });

  it('proxy mode fails closed when the proxy is unreachable', async () => {
    const probe = vi.fn(async () => 'refused' as const);
    await expect(sanitizeAgentEnv(deadProxyEnv, {
      mode: 'proxy',
      proxyUrl: 'http://127.0.0.1:17897',
    }, { probe })).rejects.toBeInstanceOf(NetworkProxyUnavailableError);
  });

  it('inherit mode keeps a live loopback proxy for clash workflows', async () => {
    const probe = vi.fn(async () => 'open' as const);
    const env = await sanitizeAgentEnv(deadProxyEnv, { mode: 'inherit' }, { probe });
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:17897');
    expect(env.KEEP_ME).toBe('unchanged');
  });

  it('inherit mode drops a provably dead loopback proxy instead of poisoning the child', async () => {
    const probe = vi.fn(async () => 'unreachable' as const);
    const env = await sanitizeAgentEnv(deadProxyEnv, { mode: 'inherit' }, { probe });
    expect(env).toEqual({ KEEP_ME: 'unchanged' });
  });

  it('inherit mode leaves non-loopback proxies alone because they cannot be probed safely', async () => {
    const probe = vi.fn(async () => 'unreachable' as const);
    const env = await sanitizeAgentEnv({ HTTPS_PROXY: 'http://10.0.0.5:3128' }, { mode: 'inherit' }, { probe });
    expect(env.HTTPS_PROXY).toBe('http://10.0.0.5:3128');
    expect(probe).not.toHaveBeenCalled();
  });

  it('inherit mode drops a live loopback proxy for a third-party provider', async () => {
    const probe = vi.fn(async () => 'open' as const);
    const env = await sanitizeAgentEnv(deadProxyEnv, { mode: 'inherit' }, {
      probe,
      thirdPartyProvider: true,
    });

    // The generic inherit path keeps a reachable loopback proxy for `clash on`
    // workflows, but it cannot route traffic to a domestic provider endpoint.
    expect(probe).not.toHaveBeenCalled();
    expect(env).toEqual({ KEEP_ME: 'unchanged' });
  });

  it('inherit mode keeps a remote proxy even for a third-party provider', async () => {
    const env = await sanitizeAgentEnv(
      { HTTPS_PROXY: 'http://10.0.0.5:3128', KEEP_ME: 'x' },
      { mode: 'inherit' },
      { thirdPartyProvider: true },
    );

    expect(env.HTTPS_PROXY).toBe('http://10.0.0.5:3128');
  });

  it('third-party detection never overrides an explicit proxy mode', async () => {
    const probe = vi.fn(async () => 'open' as const);
    const env = await sanitizeAgentEnv({ KEEP_ME: 'x' }, {
      mode: 'proxy',
      proxyUrl: 'socks5h://127.0.0.1:7890',
    }, { probe, thirdPartyProvider: true });

    expect(env.ALL_PROXY).toBe('socks5h://127.0.0.1:7890');
  });

  it('parses proxy URLs and recognizes loopback hosts', () => {
    expect(parseProxyUrl('http://127.0.0.1:7890')).toEqual({ host: '127.0.0.1', port: 7890 });
    expect(parseProxyUrl('socks5h://localhost')).toEqual({ host: 'localhost', port: 1080 });
    expect(parseProxyUrl('not a url')).toBeUndefined();
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('10.0.0.5')).toBe(false);
  });

  it('pins inherited values and clears only explicitly stripped keys', () => {
    const args = proxyEnvironmentArgs(
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
      { mode: 'inherit', strippedKeys: ['HTTP_PROXY'] },
    );
    expect(args).toContain('HTTPS_PROXY=http://127.0.0.1:7890');
    expect(args).toContain('HTTP_PROXY=');
    expect(args).not.toContain('ALL_PROXY=');
  });

  it('owns the whole proxy environment in direct/proxy mode', () => {
    const direct = proxyEnvironmentArgs({}, { mode: 'direct' });
    expect(direct).toContain('ALL_PROXY=');
    expect(direct).toContain('SOCKS5_PROXY=');
    expect(direct.filter(item => item === '-e')).toHaveLength(direct.length / 2);
  });

  it('reports which proxy keys were stripped', async () => {
    let keys: string[] | undefined;
    await sanitizeAgentEnv(deadProxyEnv, { mode: 'direct' }, {
      onDiagnostic: diagnostic => { keys = diagnostic.keys; },
    });
    expect(keys).toEqual(expect.arrayContaining(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']));
  });
});
